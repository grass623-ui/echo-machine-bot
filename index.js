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

// 處理違規記點與封鎖的函數
async function addViolation(discordId) {
    const userRef = db.collection('users').doc(discordId);
    const doc = await userRef.get();
    let points = 1;
    let bannedUntil = null;
    if (doc.exists) {
        points = (doc.data().violationPoints || 0) + 1;
    }
    if (points >= 3) {
        bannedUntil = Date.now() + 7 * 24 * 60 * 60 * 1000; // 封鎖 7 天
        points = 0; // 封鎖後歸零
    }
    await userRef.set({ violationPoints: points, bannedUntil: bannedUntil }, { merge: true });
    return { points, bannedUntil };
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

    if (!isAdmin) futureRes = futureRes.filter(res => res.date === todayStr);

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
        { name: '我的紀錄', description: '查詢個人的預約統計與違規記點' },
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
                        
                        await user.send(`🔔 **王團預約提醒鬧鐘**\n您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）開始，請備妥 ${price}萬 楓幣給迴響機！`).catch(console.error);
                        
                        if (echoAdminId) {
                            const pre5MinTime = data.timestamp - 5 * 60 * 1000;
                            const twPre5Obj = new Date(pre5MinTime + 8 * 60 * 60 * 1000);
                            const pre5MinStr = String(twPre5Obj.getUTCHours()).padStart(2, '0') + ':' + String(twPre5Obj.getUTCMinutes()).padStart(2, '0');
                            
                            const echoUser = await client.users.fetch(echoAdminId);
                            await echoUser.send(`🔔 **王團提醒訂單鬧鐘**\n<@${data.discordId}> 與您預約的【${data.location}】將在 15 分鐘後（\`${data.date} ${data.time}\`）需要施放迴響！\n請記得於（\`${data.date} ${pre5MinStr}\`）上線並準備施放 **英雄的迴響** 喔！`).catch(console.error);
                        }
                        await db.collection('reservations').doc(doc.id).update({ reminded: true });
                    } catch (error) { console.log('私訊失敗'); }
                }
            });
        } catch (error) { console.error(error); }
    }, 60 * 1000); 
});

client.on('interactionCreate', async interaction => {
    
    // =====================================
    // 獨立指令處理
    // =====================================
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
    else if (interaction.isChatInputCommand() && interaction.commandName === '我的紀錄') {
        await interaction.deferReply({ ephemeral: true });
        const snapshot = await db.collection('reservations').where('discordId', '==', interaction.user.id).get();
        const tw = getTaiwanTime();
        const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;
        let total = 0, month = 0;
        
        snapshot.forEach(doc => {
            total++;
            if (doc.data().date.startsWith(currentMonthPrefix)) month++;
        });

        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        let points = 0;
        let banStatus = '🟢 正常 (無封鎖限制)';
        if (userDoc.exists) {
            const ud = userDoc.data();
            points = ud.violationPoints || 0;
            if (ud.bannedUntil && ud.bannedUntil > Date.now()) {
                const bDate = new Date(ud.bannedUntil + 8 * 3600 * 1000);
                banStatus = `🔴 權限受限 (解除時間：${bDate.getUTCFullYear()}-${String(bDate.getUTCMonth()+1).padStart(2,'0')}-${String(bDate.getUTCDate()).padStart(2,'0')} ${String(bDate.getUTCHours()).padStart(2,'0')}:${String(bDate.getUTCMinutes()).padStart(2,'0')})`;
            }
        }

        const statEmbed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`📊 ${interaction.user.username} 的預約數據面板`)
            .addFields(
                { name: '本月預約', value: `${month} 次`, inline: true },
                { name: '歷史總預約', value: `${total} 次`, inline: true },
                { name: '違規記點', value: `${points} / 3 點`, inline: false },
                { name: '帳號狀態', value: banStatus, inline: false }
            )
            .setFooter({ text: '※ 若於開打 30 分鐘內臨時異動或取消，系統將自動記 1 點。滿 3 點封鎖預約權限 7 天。' });

        await interaction.editReply({ embeds: [statEmbed] });
    }

    // =====================================
    // 預約表單處理
    // =====================================
    else if (interaction.isChatInputCommand() && interaction.commandName === '預約') {
        // 先檢查是否被封鎖
        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        if (userDoc.exists) {
            const ud = userDoc.data();
            if (ud.bannedUntil && ud.bannedUntil > Date.now()) {
                const bDate = new Date(ud.bannedUntil + 8 * 3600 * 1000);
                const banTimeStr = `${bDate.getUTCFullYear()}-${String(bDate.getUTCMonth()+1).padStart(2,'0')}-${String(bDate.getUTCDate()).padStart(2,'0')} ${String(bDate.getUTCHours()).padStart(2,'0')}:${String(bDate.getUTCMinutes()).padStart(2,'0')}`;
                return interaction.reply({ content: `❌ **權限受限**：因您近期多次臨時取消或異動，觸發系統保護機制。您的預約功能已被暫停至 \`${banTimeStr}\`。`, ephemeral: true });
            }
        }

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
        if (newDateTime.getTime() <= Date.now()) return interaction.reply({ content: '❌ **無法預約過去的時間**，請設定未來的時刻。', ephemeral: true });

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
            new ButtonBuilder().setCustomId(`edit_${docRef.id}`).setLabel('✏️ 變更登記資料').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`cancel_${docRef.id}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger)
        );

        const embed = new EmbedBuilder()
            .setColor(0x00FF00).setTitle('✅ 預約已送出')
            .setDescription(`**地點**：${location}\n**時間**：${date} ${time}\n**頻道**：${channel || '未填寫 (當日決定)'}`);

        try {
            await interaction.user.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: `✅ 預約成功！排班表已更新。請查看您的 **私訊(DM)** 以管理這筆訂單。`, ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: `✅ 預約成功！排班表已更新。\n⚠️ **警告：我們無法發送訂單管理卡片給您，請確認您的隱私設定有開啟「允許來自伺服器成員的私人訊息」。**`, ephemeral: true });
        }
        
        updateBoard(); 
    }

    // =====================================
    // 私訊(DM)內的按鈕與表單處理
    // =====================================
    else if (interaction.isButton()) {
        const [action, docId] = interaction.customId.split('_');
        
        const doc = await db.collection('reservations').doc(docId).get();
        if (!doc.exists) return interaction.reply({ content: '❌ 找不到此訂單，可能已被刪除。', ephemeral: true });
        
        const data = doc.data();

        if (data.timestamp < Date.now()) {
            const expiredEmbed = new EmbedBuilder()
                .setColor(0x808080)
                .setTitle('📜 歷史預約紀錄')
                .setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}\n**頻道**：${data.channel || '未填寫 (當日決定)'}\n\n*此預約時間已過，無法再進行更改。*`);
            return interaction.update({ embeds: [expiredEmbed], components: [] });
        }
        
        const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;

        if (action === 'cancel') {
            await db.collection('reservations').doc(docId).delete();
            
            const cancelEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🚫 訂單已取消')
                .setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}\n**頻道**：${data.channel || '未填寫 (當日決定)'}`);
            
            let replyText = '✅ **這筆訂單已成功取消**，伺服器排班表已同步刷新。';
            
            // 臨時取消記點與候補廣播
            if (isLastMinute) {
                const { points, bannedUntil } = await addViolation(interaction.user.id);
                if (bannedUntil) {
                    replyText += `\n\n⚠️ **系統警告**：此次操作屬「開打前 30 分鐘內」臨時異動，記 1 點違規。**累計達 3 點，您的預約權限已被封鎖 7 天！**`;
                } else {
                    replyText += `\n\n⚠️ **系統提醒**：此次操作屬「開打前 30 分鐘內」臨時異動，已記 1 點違規（目前累計：${points}/3）。滿 3 點將封鎖權限 7 天，請多加留意。`;
                }
                
                const boardDoc = await db.collection('settings').doc('board').get();
                if (boardDoc.exists) {
                    const channel = await client.channels.fetch(boardDoc.data().channelId).catch(() => null);
                    if (channel) await channel.send(`📢 **【臨時釋出候補】**\n原本預約的【${data.location}】\`${data.date} ${data.time}\` 時段剛剛釋出囉！有人要接手嗎？\n*(欲接手請直接使用 \`/預約\` 指令重新登記)*`);
                }
            }

            await interaction.update({ embeds: [cancelEmbed], components: [] });
            await interaction.followUp({ content: replyText, ephemeral: true });
            updateBoard();
        } 
        else if (action === 'edit') {
            const modal = new ModalBuilder().setCustomId(`submitEdit_${docId}`).setTitle('變更登記資料');
            
            const channelInput = new TextInputBuilder().setCustomId('channel').setLabel("幸運頻道").setStyle(TextInputStyle.Short).setRequired(false);
            if (data.channel) channelInput.setValue(data.channel);

            const notesInput = new TextInputBuilder().setCustomId('notes').setLabel("備註").setStyle(TextInputStyle.Short).setRequired(false);
            if (data.notes && data.notes !== '無') notesInput.setValue(data.notes);

            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newDate').setLabel("日期").setStyle(TextInputStyle.Short).setValue(data.date).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newTime').setLabel("時間 (24小時制)").setStyle(TextInputStyle.Short).setValue(data.time).setMaxLength(5).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gameId').setLabel("預約者遊戲ID").setStyle(TextInputStyle.Short).setValue(data.gameId).setRequired(true)),
                new ActionRowBuilder().addComponents(channelInput),
                new ActionRowBuilder().addComponents(notesInput)
            );
            await interaction.showModal(modal);
        }
    }

    // 處理：變更登記資料表單送出
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('submitEdit_')) {
        const docId = interaction.customId.split('_')[1];
        const newDate = interaction.fields.getTextInputValue('newDate').replace(/\//g, '-');
        let newTime = interaction.fields.getTextInputValue('newTime');
        const newGameId = interaction.fields.getTextInputValue('gameId');
        const newChannel = interaction.fields.getTextInputValue('channel') || '';
        const newNotes = interaction.fields.getTextInputValue('notes') || '無';
        
        if (newTime.length === 4 && newTime.indexOf(':') === 1) newTime = '0' + newTime;
        const newDateTime = new Date(`${newDate}T${newTime}:00+08:00`);

        if (isNaN(newDateTime.getTime())) return interaction.reply({ content: '❌ **日期或時間格式錯誤**。', ephemeral: true });
        if (newDateTime.getTime() <= Date.now()) return interaction.reply({ content: '❌ **無法更改為過去的時間**，請設定未來的時刻。', ephemeral: true });

        const currentDoc = await db.collection('reservations').doc(docId).get();
        if (!currentDoc.exists) return interaction.reply({ content: '❌ 找不到此訂單。', ephemeral: true });
        
        const data = currentDoc.data();
        const currentLocation = data.location;
        const timeChanged = data.timestamp !== newDateTime.getTime();

        if (timeChanged) {
            const snapshot = await db.collection('reservations').get();
            let reservations = [];
            snapshot.forEach(doc => {
                if (doc.id !== docId) reservations.push({ id: doc.id, ...doc.data() });
            });

            const isConflict = reservations.some(res => {
                return res.location === currentLocation && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000;
            });

            if (isConflict) return interaction.reply({ content: '❌ 您申請更改的時間前後10分鐘有訂單，無法進行更改，請重新設定。', ephemeral: true });
        }

        await db.collection('reservations').doc(docId).update({ 
            date: newDate, time: newTime, gameId: newGameId, channel: newChannel, notes: newNotes,
            timestamp: newDateTime.getTime(), reminded: false 
        });

        const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;
        let replyText = `✅ **變更成功**，看板已同步刷新。`;
        
        // 如果臨時更改時間，觸發記點與候補釋出廣播
        if (timeChanged && isLastMinute) {
            const { points, bannedUntil } = await addViolation(interaction.user.id);
            if (bannedUntil) {
                replyText += `\n\n⚠️ **系統警告**：臨時更改時間記 1 點違規。**累計達 3 點，您的預約權限已被封鎖 7 天！**（本次更改仍生效）`;
            } else {
                replyText += `\n\n⚠️ **系統提醒**：臨時更改時間記 1 點違規（目前累計：${points}/3）。滿 3 點將封鎖權限 7 天。`;
            }
            
            const boardDoc = await db.collection('settings').doc('board').get();
            if (boardDoc.exists) {
                const channel = await client.channels.fetch(boardDoc.data().channelId).catch(() => null);
                if (channel) await channel.send(`📢 **【臨時釋出候補】**\n原本預約的【${currentLocation}】\`${data.date} ${data.time}\` 時段剛剛釋出囉！有人要接手嗎？\n*(欲接手請直接使用 \`/預約\` 指令重新登記)*`);
            }
        }

        await interaction.reply({ content: replyText, ephemeral: true });

        const embed = new EmbedBuilder()
            .setColor(0x00FF00).setTitle('✅ 預約已更新')
            .setDescription(`**地點**：${currentLocation}\n**時間**：${newDate} ${newTime}\n**頻道**：${newChannel || '未填寫 (當日決定)'}`);
        await interaction.message.edit({ embeds: [embed] });

        updateBoard();
    }
});

client.login(process.env.DISCORD_TOKEN);
