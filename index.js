require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { 
    Client, GatewayIntentBits, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionsBitField 
} = require('discord.js');

// ==========================================
// 1. 初始化 Firebase 資料庫
// ==========================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
let key = serviceAccount.private_key;
let pureKey = key.replace(/\\n/g, '').replace(/\\\\n/g, '').replace(/\n/g, '').replace(/\r/g, '')
                 .replace(/-----BEGIN PRIVATE KEY-----/gi, '').replace(/-----END PRIVATE KEY-----/gi, '')
                 .replace(/\s+/g, '');
const chunks = pureKey.match(/.{1,64}/g) || [];
serviceAccount.private_key = '-----BEGIN PRIVATE KEY-----\n' + chunks.join('\n') + '\n-----END PRIVATE KEY-----\n';

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });

// 輔助：取得台灣時間字串
function getTaiwanTime() {
    const now = new Date();
    const twDate = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    return {
        yyyy: twDate.getUTCFullYear(),
        mm: String(twDate.getUTCMonth() + 1).padStart(2, '0'),
        dd: String(twDate.getUTCDate()).padStart(2, '0'),
        hh: String(twDate.getUTCHours()).padStart(2, '0'),
        min: String(twDate.getUTCMinutes()).padStart(2, '0')
    };
}

// 輔助：組合排班表
function generateScheduleEmbed(reservations, isAdmin = false) {
    const now = Date.now();
    const futureRes = reservations
        .filter(res => res.timestamp > now - (30 * 60 * 1000)) 
        .sort((a, b) => a.timestamp - b.timestamp);

    if (futureRes.length === 0) {
        return new EmbedBuilder().setColor(0x0099FF).setTitle('📅 王團自動排班表').setDescription('目前沒有未來的預約喔！').setTimestamp();
    }

    const grouped = {};
    futureRes.forEach(res => {
        if (!grouped[res.date]) grouped[res.date] = [];
        grouped[res.date].push(res);
    });

    let scheduleText = '';
    for (const [date, items] of Object.entries(grouped)) {
        scheduleText += `\n**📅 ${date}**\n`;
        items.forEach((res) => {
            const playerInfo = isAdmin ? `遊戲ID：${res.gameId} | 聯絡：<@${res.discordId}>` : `👤 🔒 匿名玩家`;
            const noteText = res.notes && res.notes !== '無' ? `\n> 備註：${res.notes}` : '';
            scheduleText += `> \`${res.time}\` | ${res.location} | 頻道：${res.channel} | ${playerInfo}${noteText}\n`;
        });
    }

    return new EmbedBuilder()
        .setColor(isAdmin ? 0xFF0000 : 0x0099FF)
        .setTitle(isAdmin ? '🕵️‍♂️ 【管理員限定】王團真實名單' : '📅 王團自動排班表')
        .setDescription(scheduleText)
        .setTimestamp();
}

// 輔助：更新置頂看板
async function updateBoard() {
    try {
        const boardDoc = await db.collection('settings').doc('board').get();
        if (!boardDoc.exists) return;
        const { channelId, messageId } = boardDoc.data();
        
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) {
                const embed = generateScheduleEmbed(reservations, false);
                await msg.edit({ embeds: [embed] });
            }
        }
    } catch (e) {
        console.log('看板更新失敗', e);
    }
}

client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    const commands = [
        { 
            name: '預約', description: '開啟王團預約表單',
            options: [{
                name: '地點', type: 3, description: '請選擇預約地點', required: true,
                choices: [
                    { name: '闇黑龍王', value: '闇黑龍王' },
                    { name: '艾畢奈亞', value: '艾畢奈亞' },
                    { name: '道館', value: '道館' },
                    { name: '其他', value: '其他' }
                ]
            }]
        },
        {
            name: '價格', description: '設定各王團地點的預設價格 (管理員)',
            options: [
                { name: '地點', type: 3, description: '選擇地點', required: true,
                  choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] },
                { name: '價格', type: 4, description: '輸入價格 (單位：萬)', required: true }
            ]
        },
        { name: '後台查詢', description: '顯示未遮罩的完整名單 (管理員)' },
        { name: '產生看板', description: '產生一個會自動更新的班表看板 (管理員)' }
    ];
    await client.application.commands.set(commands);

    // 每分鐘巡邏鬧鐘與刷新看板
    setInterval(async () => {
        const now = Date.now();
        await updateBoard(); // 自動刷新看板

        try {
            const snapshot = await db.collection('reservations').where('reminded', '==', false).get();
            const pricesDoc = await db.collection('settings').doc('prices').get();
            const prices = pricesDoc.exists ? pricesDoc.data() : {};

            snapshot.forEach(async doc => {
                const data = doc.data();
                const timeDiff = data.timestamp - now;
                
                // 距離開打 <= 15 分鐘
                if (timeDiff <= 15 * 60 * 1000 && timeDiff > 0) {
                    try {
                        const price = prices[data.location] || '未設定';
                        
                        // 1. 通知預約者
                        const user = await client.users.fetch(data.discordId);
                        await user.send(`🔔 **王團預約提醒鬧鐘**\n您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）開始，請備妥${price}萬楓幣給迴響機！`);
                        
                        // 2. 通知迴響機管理員
                        const echoAdminId = process.env.ECHO_ADMIN_ID;
                        if (echoAdminId) {
                            const dateObj = new Date(data.timestamp);
                            dateObj.setMinutes(dateObj.getMinutes() - 5);
                            const pre5Min = String(dateObj.getHours()).padStart(2, '0') + ':' + String(dateObj.getMinutes()).padStart(2, '0');
                            
                            const echoUser = await client.users.fetch(echoAdminId);
                            await echoUser.send(`🔔 **王團提醒訂單鬧鐘**\n與您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）需要施放迴響！\n請記得於（\`${data.date} ${pre5Min}\`）上線並準備施放 **英雄的迴響** 喔！`);
                        }
                        await db.collection('reservations').doc(doc.id).update({ reminded: true });
                    } catch (error) { console.log('私訊失敗'); }
                }
            });
        } catch (error) { console.error(error); }
    }, 60 * 1000); 
});

client.on('interactionCreate', async interaction => {
    
    // --- 指令：產生看板 ---
    if (interaction.isChatInputCommand() && interaction.commandName === '產生看板') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));
        const embed = generateScheduleEmbed(reservations, false);
        
        const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
        await db.collection('settings').doc('board').set({ channelId: interaction.channelId, messageId: msg.id });
    }

    // --- 指令：設定價格 ---
    else if (interaction.isChatInputCommand() && interaction.commandName === '價格') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const loc = interaction.options.getString('地點');
        const price = interaction.options.getInteger('價格');
        await db.collection('settings').doc('prices').set({ [loc]: price }, { merge: true });
        await interaction.reply({ content: `✅ 已將【${loc}】的價格設定為 **${price}萬** 楓幣。`, ephemeral: true });
    }

    // --- 指令：後台查詢 ---
    else if (interaction.isChatInputCommand() && interaction.commandName === '後台查詢') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        await interaction.deferReply({ ephemeral: true }); 
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));
        const embed = generateScheduleEmbed(reservations, true);
        await interaction.editReply({ embeds: [embed] });
    }

    // --- 指令：預約表單 (含動態時間) ---
    else if (interaction.isChatInputCommand() && interaction.commandName === '預約') {
        const location = interaction.options.getString('地點');
        const modal = new ModalBuilder().setCustomId(`reserve_${location}`).setTitle(`📝 預約：${location}`);
        
        const tw = getTaiwanTime();
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel("日期 (可修改)").setStyle(TextInputStyle.Short).setValue(`${tw.yyyy}-${tw.mm}-${tw.dd}`).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel("時間 (24小時制，可修改)").setStyle(TextInputStyle.Short).setValue(`${tw.hh}:${tw.min}`).setMaxLength(5).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel("頻道").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gameId').setLabel("遊戲ID").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel("備註 (非必填)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }

    // --- 處理表單送出 ---
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('reserve_')) {
        const location = interaction.customId.split('_')[1];
        const date = interaction.fields.getTextInputValue('date').replace(/\//g, '-');
        let time = interaction.fields.getTextInputValue('time');
        const channel = interaction.fields.getTextInputValue('channel');
        const gameId = interaction.fields.getTextInputValue('gameId');
        const notes = interaction.fields.getTextInputValue('notes') || '無';
        
        // 容錯：9:45 自動轉 09:45
        if (time.length === 4 && time.indexOf(':') === 1) time = '0' + time;

        const dateString = `${date}T${time}:00+08:00`;
        const newDateTime = new Date(dateString);

        // 防呆：格式錯誤 (私密訊息)
        if (isNaN(newDateTime.getTime())) {
            return interaction.reply({ content: '❌ **日期或時間格式錯誤**，請確認格式（例如：2026-08-11 與 20:30）。', ephemeral: true });
        }

        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        // 防撞檢查：10 分鐘內地點相同 (私密訊息)
        const isConflict = reservations.some(res => {
            const timeDiff = Math.abs(newDateTime.getTime() - res.timestamp);
            return res.location === location && timeDiff < 10 * 60 * 1000;
        });

        if (isConflict) {
            return interaction.reply({ content: '❌ 您申請預約的時間前後10分鐘有訂單，無法進行預約，請重新設定。', ephemeral: true });
        }

        // 通過驗證，寫入資料
        const newReservation = {
            discordId: interaction.user.id, gameId, date, time, location, channel, notes,
            timestamp: newDateTime.getTime(), reminded: false
        };
        await db.collection('reservations').add(newReservation);
        
        // 公開回覆成功訊息
        await interaction.reply({ content: `✅ 預約成功！您的訂單已加入自動排班表。` });
        updateBoard(); // 立即手動刷新一次看板
    }
});

client.login(process.env.DISCORD_TOKEN);
