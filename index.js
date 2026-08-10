require('dotenv').config();
const express = require('express');
const { 
    Client, GatewayIntentBits, Partials, 
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder 
} = require('discord.js');

// ==========================================
// 1. Web 伺服器 (維持 UptimeRobot 喚醒用)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is currently alive and running!'));
app.listen(port, () => console.log(`[Web Server] Listening on port ${port}`));

// ==========================================
// 2. 班表記憶體 (暫存預約資料用)
// ==========================================
// 注意：目前暫存在記憶體，若機器人重啟資料會清空。後續可升級為資料庫。
let reservations = []; 

// ==========================================
// 3. Discord 機器人核心邏輯
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds], // 使用斜線指令只需要基礎 Guilds 權限即可
});

// 當機器人啟動完成
client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    
    // 向 Discord 註冊「/預約」這個斜線指令
    const commands = [{
        name: '預約',
        description: '開啟王團預約表單'
    }];
    
    try {
        await client.application.commands.set(commands);
        console.log('✅ 成功註冊斜線指令：/預約');
    } catch (error) {
        console.error('❌ 註冊指令失敗：', error);
    }
});

// 監聽玩家互動 (輸入指令 或 送出表單)
client.on('interactionCreate', async interaction => {
    
    // ==========================================
    // 狀況 A：玩家輸入了 /預約，我們要彈出對話框
    // ==========================================
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === '預約') {
            
            // 建立對話框 (Modal)
            const modal = new ModalBuilder()
                .setCustomId('reservationModal')
                .setTitle('📝 王團預約表單');

            // 建立輸入欄位：地點
            const locationInput = new TextInputBuilder()
                .setCustomId('location')
                .setLabel("地點 (例如：玩具城深處)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            // 建立輸入欄位：時間
            const timeInput = new TextInputBuilder()
                .setCustomId('time')
                .setLabel("時間 (請用 24小時制，例如：20:30)")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(5)
                .setRequired(true);

            // 建立輸入欄位：頻道
            const channelInput = new TextInputBuilder()
                .setCustomId('channel')
                .setLabel("頻道 (不確定可填：當日決定)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            // 建立輸入欄位：代約
            const proxyInput = new TextInputBuilder()
                .setCustomId('proxy')
                .setLabel("代約 (無則填無，有則填寫遊戲ID)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false); // 這個欄位選填

            // 將欄位加入對話框
            modal.addComponents(
                new ActionRowBuilder().addComponents(locationInput),
                new ActionRowBuilder().addComponents(timeInput),
                new ActionRowBuilder().addComponents(channelInput),
                new ActionRowBuilder().addComponents(proxyInput)
            );

            // 顯示對話框給玩家
            await interaction.showModal(modal);
        }
    }

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
