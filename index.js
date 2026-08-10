require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { 
    Client, GatewayIntentBits, 
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder 
} = require('discord.js');

// ==========================================
// 1. 初始化 Firebase 資料庫
// ==========================================
// 從 Render 的環境變數讀取金鑰並解析
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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
// 3. Discord 機器人核心邏輯
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    const commands = [{ name: '預約', description: '開啟王團預約表單' }];
    await client.application.commands.set(commands);
});

client.on('interactionCreate', async interaction => {
    
    // --- 狀況 A：彈出對話框 ---
    if (interaction.isChatInputCommand() && interaction.commandName === '預約') {
        const modal = new ModalBuilder().setCustomId('reservationModal').setTitle('📝 王團預約表單');

        const dateInput = new TextInputBuilder().setCustomId('date').setLabel("日期 (例如：08/11 或 2026-08-11)").setStyle(TextInputStyle.Short).setRequired(true);
        const timeInput = new TextInputBuilder().setCustomId('time').setLabel("時間 (24小時制，例如：20:30)").setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true);
        const locationInput = new TextInputBuilder().setCustomId('location').setLabel("地點 (例如：玩具城深處)").setStyle(TextInputStyle.Short).setRequired(true);
        const channelInput = new TextInputBuilder().setCustomId('channel').setLabel("頻道 (不確定可填：當日決定)").setStyle(TextInputStyle.Short).setRequired(true);
        const gameIdInput = new TextInputBuilder().setCustomId('gameId').setLabel("遊戲ID (方便隊長辨識)").setStyle(TextInputStyle.Short).setRequired(true); 

        modal.addComponents(
            new ActionRowBuilder().addComponents(dateInput),
            new ActionRowBuilder().addComponents(timeInput),
            new ActionRowBuilder().addComponents(locationInput),
            new ActionRowBuilder().addComponents(channelInput),
            new ActionRowBuilder().addComponents(gameIdInput)
        );

        await interaction.showModal(modal);
    }

    // --- 狀況 B：處理表單送出並寫入 Firebase ---
    else if (interaction.isModalSubmit() && interaction.customId === 'reservationModal') {
        
        // 為了避免機器人想太久跳出錯誤，先告訴 Discord「我正在處理中」
        await interaction.deferReply();

        const date = interaction.fields.getTextInputValue('date');
        const time = interaction.fields.getTextInputValue('time');
        const location = interaction.fields.getTextInputValue('location');
        const channel = interaction.fields.getTextInputValue('channel');
        const gameId = interaction.fields.getTextInputValue('gameId');
        const discordUserId = interaction.user.id; 

        const newDateTime = new Date(`${date} ${time}`);
        if (isNaN(newDateTime.getTime())) {
            return interaction.editReply({ content: '❌ **日期或時間格式錯誤**，請確認格式。' });
        }

        // 1. 從 Firebase 抓取所有現有預約
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        // 2. 防呆邏輯：檢查 10 分鐘衝突
        const isConflict = reservations.some(res => {
            const existingDateTime = new Date(`${res.date} ${res.time}`);
            const timeDiff = Math.abs(newDateTime - existingDateTime);
            return res.location === location && timeDiff < 10 * 60 * 1000;
        });

        if (isConflict) {
            return interaction.editReply({ content: `❌ **預約失敗**：【${location}】在這個時段的前後 10 分鐘內已經有人預約囉！` });
        }

        // 3. 準備要存入資料庫的新資料
        const newReservation = {
            discordId: discordUserId,
            gameId: gameId,
            date: date,
            time: time,
            location: location,
            channel: channel,
            timestamp: newDateTime.getTime()
        };

        // 4. 正式寫入 Firebase Firestore
        await db.collection('reservations').add(newReservation);
        
        // 將新資料也加入陣列中以便排序顯示
        reservations.push(newReservation);

        // 5. 排序邏輯
        reservations.sort((a, b) => a.timestamp - b.timestamp);

        // 6. 組合班表
        let scheduleText = '';
        reservations.forEach((res, index) => {
            scheduleText += `**${index + 1}. [${res.date} ${res.time}] ${res.location}**\n`;
            scheduleText += `> 頻道：${res.channel} | 遊戲ID：${res.gameId} | 聯絡：<@${res.discordId}>\n\n`;
        });

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📅 最新王團自動排班表')
            .setDescription(scheduleText)
            .setTimestamp();

        // 7. 更新回覆
        await interaction.editReply({ content: `✅ 預約成功！資料已永久儲存至雲端。`, embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);

    // ==========================================
    // 狀況 B：玩家填完表單按下了「送出」
    // ==========================================
    else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'reservationModal') {
            
            // 抓取玩家填寫的資料
            const location = interaction.fields.getTextInputValue('location');
            const time = interaction.fields.getTextInputValue('time');
            const channel = interaction.fields.getTextInputValue('channel');
            const proxy = interaction.fields.getTextInputValue('proxy') || '無';
            const user = interaction.user.username;

            // 1. 將新資料加入班表陣列
            reservations.push({
                user: user,
                location: location,
                time: time,
                channel: channel,
                proxy: proxy
            });

            // 2. 進行「時間排序」 (按照 00:00 ~ 23:59 排序)
            reservations.sort((a, b) => a.time.localeCompare(b.time));

            // 3. 組合出漂亮的班表文字
            let scheduleText = '';
            reservations.forEach((res, index) => {
                scheduleText += `**${index + 1}. [${res.time}] ${res.location}**\n`;
                scheduleText += `> 頻道：${res.channel} | 預約人：${res.user} | 代約：${res.proxy}\n\n`;
            });

            // 4. 建立排版精美的 Embed 訊息
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('📅 今日王團自動排班表')
                .setDescription(scheduleText.length > 0 ? scheduleText : '目前還沒有人預約喔！')
                .setTimestamp();

            // 5. 回覆玩家並貼出最新班表
            await interaction.reply({ 
                content: `✅ 預約成功！最新班表如下：`, 
                embeds: [embed] 
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
