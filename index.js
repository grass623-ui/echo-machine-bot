require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { 
    Client, GatewayIntentBits, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionsBitField, ButtonBuilder, ButtonStyle 
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
// 2. Web 伺服器
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is currently alive and running!'));
app.listen(port, () => console.log(`[Web Server] Listening on port ${port}`));

// ==========================================
// 3. Discord 機器人核心與功能邏輯
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });

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

// 組合排班表
function generateScheduleEmbed(reservations, isAdmin = false) {
    const now = Date.now();
    const tw = getTaiwanTime();
    const todayStr = `${tw.yyyy}-${tw.mm}-${tw.dd}`;
    const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;

    const stats = {};
    reservations.forEach(r => {
        if (!stats[r.discordId]) stats[r.discordId] = { total: 0, month: 0 };
        stats[r.discordId].total += 1;
        if (r.date.startsWith(currentMonthPrefix)) {
            stats[r.discordId].month += 1;
        }
    });

    let futureRes = reservations
        .filter(res => res.timestamp >= now) 
        .sort((a, b) => a.timestamp - b.timestamp);

    if (!isAdmin) {
        futureRes = futureRes.filter(res => res.date === todayStr);
    }

    if (futureRes.length === 0) {
        return new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(isAdmin ? '👑【管理員】王團自動排班表' : '👤王團自動排班表')
            .setDescription(isAdmin ? '目前沒有任何未來的預約喔！' : '本日目前沒有未來的預約喔！')
            .setTimestamp();
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
            const displayChannel = res.channel ? res.channel : '當日決定';
            const noteText = res.notes && res.notes !== '無' ? `\n> 備註：${res.notes}` : '';
            
            let playerInfo;
            if (isAdmin) {
                const userStats = stats[res.discordId];
                playerInfo = `遊戲ID：${res.gameId} | 聯絡：<@${res.discordId}> | 本月預約迴響次數：${userStats.month} | 歷史預約迴響次數：${userStats.total}`;
            } else {
                playerInfo = `👤 🔒 匿名玩家`;
            }
            
            scheduleText += `> \`${res.time}\` | ${res.location} | 頻道：${displayChannel} | ${playerInfo}${noteText}\n`;
        });
    }

    return new EmbedBuilder()
        .setColor(isAdmin ? 0xFF0000 : 0x0099FF)
        .setTitle(isAdmin ? '👑【管理員】王團自動排班表' : '👤王團自動排班表')
        .setDescription(scheduleText)
        .setTimestamp();
}

// 自動更新看板
async function updateBoard() {
    try {
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const boardDoc = await db.collection('settings').doc('board').get();
        if (boardDoc.exists) {
            const { channelId, messageId } = boardDoc.data();
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                const msg = await channel.messages.fetch(messageId).catch(() => null);
                if (msg) await msg.edit({ embeds: [generateScheduleEmbed(reservations, false)] });
            }
        }

        const adminBoardDoc = await db.collection('settings').doc('adminBoard').get();
        if (adminBoardDoc.exists) {
            const { channelId, messageId } = adminBoardDoc.data();
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                const msg = await channel.messages.fetch(messageId).catch(() => null);
                if (msg) await msg.edit({ embeds: [generateScheduleEmbed(reservations, true)] });
            }
        }
    } catch (e) { console.log('看板更新失敗', e); }
}

client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    const commands = [
        { 
            name: '預約', description: '開啟王團預約表單',
            options: [{
                name: '地點', type: 3, description: '請選擇預約地點', required: true,
                choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ]
            }]
        },
        {
            name: '價格', description: '設定各王團地點的預設價格 (管理員)',
            options: [
                { name: '地點', type: 3, description: '選擇地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] },
                { name: '價格', type: 4, description: '輸入價格 (單位：萬)', required: true }
            ]
        },
        { name: '產生看板', description: '產生會自動更新的【公開】班表 (管理員)' },
        { name: '產生管理看板', description: '產生會自動更新的【真實名單】班表 (管理員)' },
        { name: '註冊迴響機', description: '將自己綁定為接收提醒的迴響機操作員 (管理員)' } 
    ];
    await client.application.commands.set(commands);

    setInterval(async () => {
        const now = Date.now();
        await updateBoard(); 

        try {
            const snapshot = await db.collection('reservations').where('reminded', '==', false).get();
            const pricesDoc = await db.collection('settings').doc('prices').get();
            const prices = pricesDoc.exists ? pricesDoc.data() : {};
            
            const echoAdminDoc = await db.collection('settings').doc('echoAdmin').get();
            const echoAdminId = echoAdminDoc.exists ? echoAdminDoc.data().discordId : null;

            snapshot.forEach(async doc => {
                const data = doc.data();
                const timeDiff = data.timestamp - now;
                
                if (timeDiff <= 15 * 60 * 1000 && timeDiff > 0) {
                    try {
                        const price = prices[data.location] || '未設定';
                        const user = await client.users.fetch(data.discordId);
                        const dcName = user.globalName || user.username;
                        
                        await user.send(`🔔 **王團預約提醒鬧鐘**\n您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）開始，請備妥 ${price}萬 楓幣給迴響機！`).catch(console.error);
                        
                        if (echoAdminId) {
                            // 時區修正：精準減去 5 分鐘，並加上台灣時區補償 (+8 小時)
                            const pre5MinTime = data.timestamp - 5 * 60 * 1000;
                            const twPre5Obj = new Date(pre5MinTime + 8 * 60 * 60 * 1000);
                            const pre5MinStr = String(twPre5Obj.getUTCHours()).padStart(2, '0') + ':' + String(twPre5Obj.getUTCMinutes()).padStart(2, '0');
                            
                            const echoUser = await client.users.fetch(echoAdminId);
                            await echoUser.send(`🔔 **王團提醒訂單鬧鐘**\n${dcName}與您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）需要施放迴響！\n請記得於（\`${data.date} ${pre5MinStr}\`）上線並準備施放 **英雄的迴響** 喔！`).catch(console.error);
                        }
                        await db.collection('reservations').doc(doc.id).update({ reminded: true });
                    } catch (error) { console.log('私訊失敗'); }
                }
            });
        } catch (error) { console.error(error); }
    }, 60 * 1000); 
});

client.on('interactionCreate', async interaction => {
    
    // 指令處理：註冊、看板、價格...
    if (interaction.isChatInputCommand() && interaction.commandName === '註冊迴響機') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        await db.collection('settings').doc('echoAdmin').set({ discordId: interaction.user.id });
        return interaction.reply({ content: '✅ **註冊成功！** 您現在是指定的迴響機操作員，未來將會自動接收提早 5 分鐘的上線通知。', ephemeral: true });
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '產生看板') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const msg = await interaction.reply({ embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0x0099FF)], fetchReply: true });
        await db.collection('settings').doc('board').set({ channelId: interaction.channelId, messageId: msg.id });
        updateBoard();
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '產生管理看板') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const msg = await interaction.reply({ embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0xFF0000)], fetchReply: true });
        await db.collection('settings').doc('adminBoard').set({ channelId: interaction.channelId, messageId: msg.id });
        updateBoard();
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '價格') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const loc = interaction.options.getString('地點');
        const price = interaction.options.getInteger('價格');
        await db.collection('settings').doc('prices').set({ [loc]: price }, { merge: true });
        await interaction.reply({ content: `✅ 已將【${loc}】的價格設定為 **${price}萬** 楓幣。`, ephemeral: true });
    }

    // 指令處理：預約表單
    else if (interaction.isChatInputCommand() && interaction.commandName === '預約') {
        const location = interaction.options.getString('地點');
        const modal = new ModalBuilder().setCustomId(`reserve_${location}`).setTitle(`📝 預約：${location}`);
        const tw = getTaiwanTime();
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel("日期 (可修改)").setStyle(TextInputStyle.Short).setValue(`${tw.yyyy}-${tw.mm}-${tw.dd}`).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel("時間 (24小時制，可修改)").setStyle(TextInputStyle.Short).setValue(`${tw.hh}:${tw.min}`).setMaxLength(5).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gameId').setLabel("預約者遊戲ID").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel("幸運頻道").setStyle(TextInputStyle.Short).setRequired(false)), 
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel("備註").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }

    // 處理：預約表單送出
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('reserve_')) {
        const location = interaction.customId.split('_')[1];
        const date = interaction.fields.getTextInputValue('date').replace(/\//g, '-');
        let time = interaction.fields.getTextInputValue('time');
        const gameId = interaction.fields.getTextInputValue('gameId');
        const channel = interaction.fields.getTextInputValue('channel') || ''; 
        const notes = interaction.fields.getTextInputValue('notes') || '無';
        
        if (time.length === 4 && time.indexOf(':') === 1) time = '0' + time;
        const newDateTime = new Date(`${date}T${time}:00+08:00`);

        if (isNaN(newDateTime.getTime())) return interaction.reply({ content: '❌ **日期或時間格式錯誤**。', ephemeral: true });

        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const isConflict = reservations.some(res => {
            return res.location === location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000;
        });

        if (isConflict) return interaction.reply({ content: '❌ 您申請預約的時間前後10分鐘有訂單，無法進行預約，請重新設定。', ephemeral: true });

        const docRef = await db.collection('reservations').add({
            discordId: interaction.user.id, gameId, date, time, location, channel, notes,
            timestamp: newDateTime.getTime(), reminded: false
        });
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cancel_${docRef.id}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`updTime_${docRef.id}`).setLabel('⌚ 更改時間').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`updChan_${docRef.id}`).setLabel('✏️ 補填/更改頻道').setStyle(ButtonStyle.Primary)
        );

        const embed = new EmbedBuilder()
            .setColor(0x00FF00).setTitle('✅ 預約已送出')
            .setDescription(`**地點**：${location}\n**時間**：${date} ${time}\n**頻道**：${channel || '未填寫 (當日決定)'}\n\n*您可以點擊下方按鈕隨時管理這筆訂單，若取消或更改訂單將會同步更新伺服器班表。*`);

        try {
            await interaction.user.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: `✅ 預約成功！排班表已更新。請查看您的 **私訊(DM)** 以管理這筆訂單。`, ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: `✅ 預約成功！排班表已更新。\n⚠️ **警告：我們無法發送訂單管理卡片給您，請確認您的隱私設定有開啟「允許來自伺服器成員的私人訊息」。**`, ephemeral: true });
        }
        
        updateBoard(); 
    }

    // 處理：真實私訊(DM)內的按鈕點擊
    else if (interaction.isButton()) {
        const [action, docId] = interaction.customId.split('_');
        
        if (action === 'cancel') {
            await db.collection('reservations').doc(docId).delete();
            await interaction.update({ content: '✅ **這筆訂單已成功取消**，伺服器排班表已同步刷新。', embeds: [], components: [] });
            updateBoard();
        } 
        else if (action === 'updChan') {
            const modal = new ModalBuilder().setCustomId(`submitChan_${docId}`).setTitle('補填 / 更改頻道');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newChannel').setLabel("新頻道").setStyle(TextInputStyle.Short).setRequired(true)));
            await interaction.showModal(modal);
        }
        else if (action === 'updTime') {
            const doc = await db.collection('reservations').doc(docId).get();
            if (!doc.exists) return interaction.reply({ content: '❌ 找不到此訂單，可能已被刪除。', ephemeral: true });
            
            const data = doc.data();
            const modal = new ModalBuilder().setCustomId(`submitTime_${docId}`).setTitle('更改預約時間');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newDate').setLabel("新日期 (例如：2026-08-11)").setStyle(TextInputStyle.Short).setValue(data.date).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newTime').setLabel("新時間 (24小時制)").setStyle(TextInputStyle.Short).setValue(data.time).setMaxLength(5).setRequired(true))
            );
            await interaction.showModal(modal);
        }
    }

    // 處理：更改頻道送出
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('submitChan_')) {
        const docId = interaction.customId.split('_')[1];
        const newChannel = interaction.fields.getTextInputValue('newChannel');
        
        await db.collection('reservations').doc(docId).update({ channel: newChannel });
        await interaction.reply({ content: `✅ 頻道已成功更新為：**${newChannel}**，看板已同步刷新。`, ephemeral: true });
        updateBoard();
    }

    // 處理：更改時間送出
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('submitTime_')) {
        const docId = interaction.customId.split('_')[1];
        const newDate = interaction.fields.getTextInputValue('newDate').replace(/\//g, '-');
        let newTime = interaction.fields.getTextInputValue('newTime');
        
        if (newTime.length === 4 && newTime.indexOf(':') === 1) newTime = '0' + newTime;
        const newDateTime = new Date(`${newDate}T${newTime}:00+08:00`);

        if (isNaN(newDateTime.getTime())) return interaction.reply({ content: '❌ **日期或時間格式錯誤**。', ephemeral: true });

        // 重新進行防撞檢查 (需排除自己原本的單子)
        const currentDoc = await db.collection('reservations').doc(docId).get();
        if (!currentDoc.exists) return interaction.reply({ content: '❌ 找不到此訂單。', ephemeral: true });
        const currentLocation = currentDoc.data().location;

        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => {
            if (doc.id !== docId) reservations.push({ id: doc.id, ...doc.data() });
        });

        const isConflict = reservations.some(res => {
            return res.location === currentLocation && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000;
        });

        if (isConflict) return interaction.reply({ content: '❌ 您申請更改的時間前後10分鐘有訂單，無法進行更改，請重新設定。', ephemeral: true });

        // 更新資料庫，並將提醒狀態歸零 (以防改時間後沒提醒到)
        await db.collection('reservations').doc(docId).update({ 
            date: newDate, 
            time: newTime, 
            timestamp: newDateTime.getTime(),
            reminded: false 
        });
        await interaction.reply({ content: `✅ 預約時間已成功更改為：**${newDate} ${newTime}**，看板已同步刷新。`, ephemeral: true });
        updateBoard();
    }
});

client.login(process.env.DISCORD_TOKEN);
