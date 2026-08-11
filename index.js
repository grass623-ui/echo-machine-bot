require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { 
    Client, GatewayIntentBits, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionsBitField 
} = require('discord.js');

// ==========================================
// 1. 初始化 Firebase 資料庫 (無敵重組裝甲版)
// ==========================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// 🛡️ 不管 Render 把格式弄得多亂，我們強制重新排版
let key = serviceAccount.private_key;
let pureKey = key.replace(/\\n/g, '')
                 .replace(/\\\\n/g, '')
                 .replace(/\n/g, '')
                 .replace(/\r/g, '')
                 .replace(/-----BEGIN PRIVATE KEY-----/gi, '')
                 .replace(/-----END PRIVATE KEY-----/gi, '')
                 .replace(/\s+/g, ''); // 清除所有空白

// 依照官方標準，每 64 個字母切成一行重新組裝
const chunks = pureKey.match(/.{1,64}/g) || [];
serviceAccount.private_key = '-----BEGIN PRIVATE KEY-----\n' + chunks.join('\n') + '\n-----END PRIVATE KEY-----\n';

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
console.log('✅ Firebase 資料庫連線成功！');

// ==========================================
// 2. Web 伺服器 (維持 UptimeRobot 喚醒用)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is currently alive and running!'));
app.listen(port, () => console.log(`[Web Server] Listening on port ${port}`));

// ==========================================
// 3. Discord 機器人核心與功能邏輯
// ==========================================
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel]
});

// --- 輔助函數：組合班表 (支援隱私遮罩與自動過濾過期) ---
function generateScheduleEmbed(reservations, isAdmin = false) {
    const now = Date.now();
    // 過濾出「未來」的預約，保留過去 30 分鐘內的避免剛開打就消失，並排序
    const futureRes = reservations
        .filter(res => res.timestamp > now - (30 * 60 * 1000)) 
        .sort((a, b) => a.timestamp - b.timestamp);

    if (futureRes.length === 0) {
        return new EmbedBuilder().setColor(0x0099FF).setTitle('📅 王團排班表').setDescription('目前還沒有未來的預約喔！');
    }

    // 依照「日期」進行分組
    const grouped = {};
    futureRes.forEach(res => {
        if (!grouped[res.date]) grouped[res.date] = [];
        grouped[res.date].push(res);
    });

    let scheduleText = '';
    for (const [date, items] of Object.entries(grouped)) {
        scheduleText += `\n**📅 ${date}**\n`;
        items.forEach((res) => {
            // 隱私判斷：管理員後台查詢顯示真實 ID，否則顯示匿名玩家
            const playerInfo = isAdmin ? `遊戲ID：${res.gameId} | 聯絡：<@${res.discordId}>` : `👤 🔒 匿名玩家`;
            scheduleText += `> \`${res.time}\` | ${res.location} | 頻道：${res.channel} | ${playerInfo}\n`;
        });
    }

    return new EmbedBuilder()
        .setColor(isAdmin ? 0xFF0000 : 0x0099FF)
        .setTitle(isAdmin ? '🕵️‍♂️ 【管理員限定】王團真實名單' : '📅 王團自動排班表')
        .setDescription(scheduleText)
        .setTimestamp();
}

// 當機器人啟動完成
client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    
    // 註冊指令：一般預約 & 後台查詢
    const commands = [
        { name: '預約', description: '開啟王團預約表單' },
        { name: '後台查詢', description: '顯示未遮罩的完整真實預約名單 (僅限管理員)' }
    ];
    try {
        await client.application.commands.set(commands);
        console.log('✅ 成功註冊斜線指令');
    } catch (error) {
        console.error('❌ 註冊指令失敗：', error);
    }

    // ==========================================
    // 4. 迴響鬧鐘：每分鐘自動巡邏一次資料庫
    // ==========================================
    setInterval(async () => {
        const now = Date.now();
        try {
            // 找出還沒提醒過的預約
            const snapshot = await db.collection('reservations').where('reminded', '==', false).get();
            
            snapshot.forEach(async doc => {
                const data = doc.data();
                const timeDiff = data.timestamp - now;
                
                // 距離開打小於等於 15 分鐘 (900,000 毫秒)，且還沒過期的預約
                if (timeDiff <= 15 * 60 * 1000 && timeDiff > 0) {
                    try {
                        const user = await client.users.fetch(data.discordId);
                        await user.send(`🔔 **王團提醒鬧鐘**\n您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）開始！\n請記得準備施放 **英雄的迴響** 喔！`);
                        // 標記為已提醒
                        await db.collection('reservations').doc(doc.id).update({ reminded: true });
                    } catch (error) {
                        console.log(`無法私訊玩家 ${data.discordId}，可能設定了阻擋陌生私訊。`);
                    }
                }
            });
        } catch (error) {
            console.error('執行鬧鐘巡邏時發生錯誤:', error);
        }
    }, 60 * 1000); // 每 60 秒執行一次
});

// 監聽玩家互動
client.on('interactionCreate', async interaction => {
    
    // --- 指令：後台查詢 (僅限管理員) ---
    if (interaction.isChatInputCommand() && interaction.commandName === '後台查詢') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '❌ 您沒有權限使用此指令喔！', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true }); 
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const embed = generateScheduleEmbed(reservations, true); // true 代表開啟真實名單
        await interaction.editReply({ embeds: [embed] });
    }

    // --- 指令：預約表單 ---
    else if (interaction.isChatInputCommand() && interaction.commandName === '預約') {
        const modal = new ModalBuilder().setCustomId('reservationModal').setTitle('📝 王團預約表單');
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel("日期 (例如：2026-08-11)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel("時間 (24小時制，例如：20:30)").setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('location').setLabel("地點 (例如：玩具城深處)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel("頻道 (不確定可填：當日決定)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gameId').setLabel("遊戲ID (方便隊長辨識)").setStyle(TextInputStyle.Short).setRequired(true))
        );
        await interaction.showModal(modal);
    }

    // --- 處理表單送出 ---
    else if (interaction.isModalSubmit() && interaction.customId === 'reservationModal') {
        await interaction.deferReply(); 

        const date = interaction.fields.getTextInputValue('date').replace(/\//g, '-');
        const time = interaction.fields.getTextInputValue('time');
        const location = interaction.fields.getTextInputValue('location');
        const channel = interaction.fields.getTextInputValue('channel');
        const gameId = interaction.fields.getTextInputValue('gameId');
        const discordUserId = interaction.user.id; 

        // 轉換為台灣時區 (UTC+8) 的絕對時間，確保跨國主機運算正確
        const dateString = `${date}T${time}:00+08:00`;
        const newDateTime = new Date(dateString);

        if (isNaN(newDateTime.getTime())) {
            return interaction.editReply({ content: '❌ **日期或時間格式錯誤**，請確認格式（例如：2026-08-11 與 20:30）。' });
        }

        // 從 Firebase 抓取資料庫進行防撞檢查
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const isConflict = reservations.some(res => {
            const timeDiff = Math.abs(newDateTime.getTime() - res.timestamp);
            return res.location === location && timeDiff < 10 * 60 * 1000;
        });

        if (isConflict) {
            return interaction.editReply({ content: `❌ **預約失敗**：【${location}】在這個時段的前後 10 分鐘內已經有人預約囉！` });
        }

        // 寫入 Firebase
        const newReservation = {
            discordId: discordUserId,
            gameId: gameId,
            date: date,
            time: time,
            location: location,
            channel: channel,
            timestamp: newDateTime.getTime(),
            reminded: false
        };
        await db.collection('reservations').add(newReservation);
        reservations.push(newReservation);

        // 產生公開版班表 (隱私遮罩啟用)
        const embed = generateScheduleEmbed(reservations, false);
        await interaction.editReply({ content: `✅ 預約成功！排班表已更新。`, embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);
