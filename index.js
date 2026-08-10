require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

// ==========================================
// 1. Web 伺服器 (Render + UptimeRobot 喚醒用)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    // 當 UptimeRobot 發送 HTTP GET 請求時，回傳狀態碼 200 與存活訊息
    res.send('Bot is currently alive and running!');
});

app.listen(port, () => {
    console.log(`[Web Server] Listening on port ${port}`);
});

// ==========================================
// 2. Discord 機器人核心邏輯
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           // 伺服器基本事件
        GatewayIntentBits.GuildMessages,    // 伺服器訊息事件
        GatewayIntentBits.MessageContent    // 讀取訊息內容 (需在 Developer Portal 開啟 Message Content Intent)
    ],
    partials: [Partials.Message, Partials.Channel]
});

// 機器人成功登入並準備就緒時觸發
client.once('ready', () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
});

// 監聽：新增留言 (玩家提交預約)
client.on('messageCreate', async message => {
    // 避免機器人回覆自己或其他的機器人
    if (message.author.bot) return;

    // 檢查是否為預約格式 (簡單檢查是否包含 "地點："、"時間：")
    if (message.content.includes('地點：') && message.content.includes('時間：')) {
        try {
            // 在這裡加入你的「5分鐘衝突檢查」邏輯
            const isConflict = false; // 這裡替換成你的實際判斷邏輯

            if (isConflict) {
                await message.react('❌');
                await message.reply({ content: '預約失敗：與其他預約時間衝突 (差在5分鐘內)，請修改時間。', ephemeral: true });
            } else {
                await message.react('✅');
                // 這裡可以呼叫更新「班表訊息」的函式
                console.log(`[New Reservation] 處理了 ${message.author.username} 的預約`);
            }
        } catch (error) {
            console.error('處理留言時發生錯誤：', error);
        }
    }
});

// 監聽：修改留言 (玩家編輯預約)
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.author.bot) return;

    // 如果未被緩存的訊息被編輯，oldMessage 可能會是不完整的
    if (newMessage.partial) await newMessage.fetch();

    if (newMessage.content.includes('地點：') && newMessage.content.includes('時間：')) {
        console.log(`[Edit Reservation] ${newMessage.author.username} 修改了預約`);
        // 這裡可以加入：重新檢查衝突、清除舊的 ✅❌ 表情並重新給表情，然後更新班表
    }
});

// 監聽：刪除留言 (玩家取消預約)
client.on('messageDelete', async message => {
    if (message.author?.bot) return;

    // 檢查被刪除的是不是預約訊息
    if (message.content.includes('地點：') && message.content.includes('時間：')) {
        console.log(`[Cancel Reservation] ${message.author.username} 刪除了預約`);
        // 這裡可以呼叫更新函式，將該筆資料從班表中移除
    }
});

// 啟動機器人
client.login(process.env.DISCORD_TOKEN);
