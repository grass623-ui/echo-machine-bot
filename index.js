require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { 
    Client, GatewayIntentBits, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionsBitField, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder 
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

const publicBoardIntro = "🎉 **歡迎來到專屬迴響預約中心！**\n為了讓大家出團順暢，請提早預約您的專屬迴響時段。\n👇 請點擊下方 **【📝 預約迴響時間】** 按鈕快速排單，系統將會為您登記並通知專員審核！";
const reserveBtnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_reserve').setLabel('📝 預約迴響時間').setStyle(ButtonStyle.Primary)
);

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

async function addViolation(discordId) {
    const userRef = db.collection('users').doc(discordId);
    const doc = await userRef.get();
    let points = 1;
    let bannedUntil = null;
    if (doc.exists) points = (doc.data().violationPoints || 0) + 1;
    if (points >= 3) {
        bannedUntil = Date.now() + 7 * 24 * 60 * 60 * 1000; 
        points = 0; 
    }
    await userRef.set({ violationPoints: points, bannedUntil: bannedUntil }, { merge: true });
    return { points, bannedUntil };
}

async function broadcastToManagementAreas(messagePayload) {
    const doc = await db.collection('settings').doc('managementArea').get();
    if (!doc.exists) return;
    const channels = doc.data().channels || [];
    for (const chId of channels) {
        const dChannel = await client.channels.fetch(chId).catch(() => null);
        if (dChannel) {
            await dChannel.send(messagePayload).catch(console.error);
        }
    }
}

// 組合排班表 (加入 completed 納入 VIP 計算邏輯)
function generateScheduleEmbed(reservations, isAdmin = false) {
    const now = Date.now();
    const tw = getTaiwanTime();
    const todayStr = `${tw.yyyy}-${tw.mm}-${tw.dd}`;
    const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;

    const stats = {};
    reservations.forEach(r => {
        // 只有「審核通過」或「順利完成」的單子才納入統計
        if (r.status !== 'approved' && r.status !== 'completed') return;
        if (!stats[r.discordId]) stats[r.discordId] = { total: 0, month: 0 };
        stats[r.discordId].total += 1;
        if (r.date.startsWith(currentMonthPrefix)) stats[r.discordId].month += 1;
    });

    let futureRes = reservations
        .filter(res => res.status === 'approved' && res.timestamp >= now) 
        .sort((a, b) => a.timestamp - b.timestamp);

    if (!isAdmin) futureRes = futureRes.filter(res => res.date === todayStr);

    if (futureRes.length === 0) {
        return new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(isAdmin ? '👑【管理員】王團自動排班表' : '👤 迴響預約清單')
            .setDescription(isAdmin ? '目前沒有任何已通過的未來預約喔！' : '本日目前沒有已通過的預約喔！')
            .setTimestamp();
    }

    const grouped = {};
    futureRes.forEach(res => {
        if (!grouped[res.date]) grouped[res.date] = [];
        grouped[res.date].push(res);
    });

    let scheduleText = '';
    for (const [date, items] of Object.entries(grouped)) {
        scheduleText += `\n**📅 ${date}**\n\n`;
        items.forEach((res) => {
            const noteText = res.notes && res.notes !== '無' ? ` | 備註：${res.notes}` : '';
            let channelDisplay = '';
            let playerInfo = '';
            
            if (isAdmin) {
                const userStats = stats[res.discordId] || { month: 0, total: 0 };
                channelDisplay = ` | 頻道：${res.channel || '當日決定'}`;
                playerInfo = `ID：${res.gameId} | <@${res.discordId}> | 本月：${userStats.month}次 | 總：${userStats.total}次`;
            } else {
                channelDisplay = ''; 
                playerInfo = `👤 🔒 匿名玩家`;
            }
            
            scheduleText += `🕒 \`${res.time}\` ── **【${res.location}】**\n`;
            scheduleText += ` └─ ${playerInfo}${channelDisplay}${noteText}\n\n`;
        });
    }

    return new EmbedBuilder()
        .setColor(isAdmin ? 0xFF0000 : 0x0099FF)
        .setTitle(isAdmin ? '👑【管理員】王團自動排班表' : '👤 迴響預約清單')
        .setDescription(scheduleText)
        .setTimestamp();
}

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
                if (msg) await msg.edit({ content: publicBoardIntro, embeds: [generateScheduleEmbed(reservations, false)], components: [reserveBtnRow] });
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
            options: [{ name: '地點', type: 3, description: '請選擇預約地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }]
        },
        { name: '我的紀錄', description: '查詢個人的預約統計與排單狀態' },
        { name: '產生看板', description: '產生會自動更新的【公開】預約看板與按鈕 (管理員)' },
        { name: '產生管理看板', description: '產生會自動更新的【真實名單】班表 (管理員)' },
        { name: '迴響管理區', description: '將此頻道加入或移除「迴響管理區」(多頻道同步接收派單/審核/結案)' },
        {
            name: '價格', description: '設定各王團地點的預設價格 (管理員)',
            options: [
                { name: '地點', type: 3, description: '選擇地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] },
                { name: '價格', type: 4, description: '輸入價格 (單位：萬)', required: true }
            ]
        },
        {
            name: '迴響鬧鐘', description: '設定提早多少分鐘發送鬧鐘與派單 (管理員)',
            options: [{ name: '分鐘', type: 4, description: '提早分鐘數 (預設15)', required: true }]
        },
        {
            name: '優惠設定', description: '設定各王團地點的 VIP 滿件優惠 (管理員)',
            options: [
                { name: '地點', type: 3, description: '選擇地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] },
                { name: '滿幾次', type: 4, description: '消費次數 (例如：5)', required: true },
                { name: '送幾次', type: 4, description: '免費次數 (例如：1)', required: true }
            ]
        }
    ];
    await client.application.commands.set(commands);

    // 每分鐘鬧鐘、派單與結案巡邏
    setInterval(async () => {
        const now = Date.now();
        await updateBoard(); 

        try {
            // 抓出所有「已通過」的訂單進行時間判定
            const snapshot = await db.collection('reservations').where('status', '==', 'approved').get();
            const pricesDoc = await db.collection('settings').doc('prices').get();
            const prices = pricesDoc.exists ? pricesDoc.data() : {};
            
            const alarmDoc = await db.collection('settings').doc('alarm').get();
            const alarmLeadTime = alarmDoc.exists ? alarmDoc.data().leadTime : 15;

            const vipDoc = await db.collection('settings').doc('vipRules').get();
            const vipRules = vipDoc.exists ? vipDoc.data() : {};
            
            // 取得所有已通過+已完成的紀錄，用來計算 VIP
            const allResSnapshot = await db.collection('reservations').where('status', 'in', ['approved', 'completed']).get();
            let allRes = [];
            allResSnapshot.forEach(d => allRes.push({ id: d.id, ...d.data() }));

            snapshot.forEach(async doc => {
                const data = doc.data();
                const timeDiff = data.timestamp - now;
                const displayChannel = data.channel ? data.channel : '-'; 
                
                // 【階段二】鬧鐘派單邏輯 (開打前提早 X 分鐘)
                if (!data.reminded && timeDiff <= alarmLeadTime * 60 * 1000 && timeDiff > 0) {
                    try {
                        let finalPriceStr = `${prices[data.location] || '未設定'}萬`;
                        const rule = vipRules[data.location];
                        if (rule && rule.buy > 0) {
                            const userHistory = allRes.filter(r => r.discordId === data.discordId && r.location === data.location).sort((a, b) => a.timestamp - b.timestamp);
                            const orderIndex = userHistory.findIndex(r => r.id === doc.id);
                            if (orderIndex !== -1) {
                                const cycle = rule.buy + rule.free;
                                if ((orderIndex % cycle) >= rule.buy) finalPriceStr = `0萬 (💎 VIP滿件優惠)`;
                            }
                        }

                        const user = await client.users.fetch(data.discordId);
                        
                        await user.send(`🔔 **王團預約提醒鬧鐘**\n您預約的【${data.location}】將在 ${alarmLeadTime} 分鐘後（\`${data.date} ${data.time}\`）開始，請備妥 ${finalPriceStr} 楓幣給迴響機！`).catch(console.error);
                        
                        const pre5MinTime = data.timestamp - 5 * 60 * 1000;
                        const twPre5Obj = new Date(pre5MinTime + 8 * 60 * 60 * 1000);
                        const pre5MinStr = String(twPre5Obj.getUTCHours()).padStart(2, '0') + ':' + String(twPre5Obj.getUTCMinutes()).padStart(2, '0');

                        const alarmEmbed = new EmbedBuilder().setColor(0xFFA500)
                            .setDescription(`🔔 **王團提醒訂單鬧鐘**\n<@${data.discordId}> 與您預約的【${data.location}】將在 ${alarmLeadTime} 分鐘後（\`${data.date} ${data.time}\`）於 \`${displayChannel}\` 施放迴響！\n請記得於（\`${data.date} ${pre5MinStr}\`）上線並準備施放 **英雄的迴響** 喔！`);

                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`takeOrder_${doc.id}`).setLabel('✋ 我來接單').setStyle(ButtonStyle.Primary)
                        );

                        await broadcastToManagementAreas({ embeds: [alarmEmbed], components: [row] });
                        await db.collection('reservations').doc(doc.id).update({ reminded: true });
                    } catch (error) { console.log('發送通知失敗'); }
                }

                // 【階段三】結案確認邏輯 (開打後經過 10 分鐘)
                if (!data.postChecked && now - data.timestamp >= 10 * 60 * 1000) {
                    try {
                        const postCheckEmbed = new EmbedBuilder()
                            .setColor(0x8A2BE2) // 紫色卡片
                            .setTitle('⏱️ 訂單結案確認 (已過預約時間10分鐘)')
                            .setDescription(`**玩家**：<@${data.discordId}>\n**地點**：${data.location}\n**頻道**：${displayChannel}\n**預約時間**：\`${data.date} ${data.time}\`\n**接單專員**：${data.takenBy ? `<@${data.takenBy}>` : '無人接單'}\n\n*這筆訂單已經結束，請問順利完成了嗎？*`);

                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`complete_${doc.id}`).setLabel('⭕ 順利完成').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`fail_${doc.id}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                        );

                        await broadcastToManagementAreas({ embeds: [postCheckEmbed], components: [row] });
                        await db.collection('reservations').doc(doc.id).update({ postChecked: true });
                    } catch (error) { console.log('發送結案確認失敗'); }
                }
            });
        } catch (error) { console.error(error); }
    }, 60 * 1000); 
});

client.on('interactionCreate', async interaction => {
    
    if (interaction.isChatInputCommand() && interaction.commandName === '迴響管理區') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const docRef = db.collection('settings').doc('managementArea');
        const doc = await docRef.get();
        let channels = doc.exists ? (doc.data().channels || []) : [];
        if (channels.includes(interaction.channelId)) {
            channels = channels.filter(id => id !== interaction.channelId);
            await docRef.set({ channels });
            return interaction.reply({ content: '✅ 已將此頻道從「迴響管理區」移除。' });
        } else {
            channels.push(interaction.channelId);
            await docRef.set({ channels });
            return interaction.reply({ content: '✅ **設定成功！** 此頻道將同步接收審核、鬧鐘派單與結案確認。' });
        }
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '產生看板') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const msg = await interaction.reply({ content: publicBoardIntro, embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0x0099FF)], components: [reserveBtnRow], fetchReply: true });
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
        await interaction.reply({ content: `✅ 已將【${loc}】的價格設定為 **${price}萬**。`, ephemeral: true });
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '迴響鬧鐘') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const mins = interaction.options.getInteger('分鐘');
        await db.collection('settings').doc('alarm').set({ leadTime: mins }, { merge: true });
        await interaction.reply({ content: `✅ 已將系統鬧鐘提前時間設定為 **${mins}分鐘**。`, ephemeral: true });
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '優惠設定') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
        const loc = interaction.options.getString('地點');
        const buy = interaction.options.getInteger('滿幾次');
        const free = interaction.options.getInteger('送幾次');
        await db.collection('settings').doc('vipRules').set({ [loc]: { buy, free } }, { merge: true });
        await interaction.reply({ content: `✅ 已設定【${loc}】優惠規則為：滿 **${buy}** 次，贈送 **${free}** 次。`, ephemeral: true });
    }
    else if (interaction.isChatInputCommand() && interaction.commandName === '我的紀錄') {
        await interaction.deferReply({ ephemeral: true });
        const snapshot = await db.collection('reservations').where('discordId', '==', interaction.user.id).where('status', 'in', ['approved', 'completed']).get();
        const tw = getTaiwanTime();
        const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;
        let total = 0, month = 0;
        
        snapshot.forEach(doc => {
            total++;
            if (doc.data().date.startsWith(currentMonthPrefix)) month++;
        });

        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        let points = 0;
        let banStatus = '🟢 正常 (功能皆可正常使用)';
        if (userDoc.exists) {
            const ud = userDoc.data();
            points = ud.violationPoints || 0;
            if (ud.bannedUntil && ud.bannedUntil > Date.now()) {
                const bDate = new Date(ud.bannedUntil + 8 * 3600 * 1000);
                banStatus = `🔴 預約休息中 (解除時間：${bDate.getUTCFullYear()}-${String(bDate.getUTCMonth()+1).padStart(2,'0')}-${String(bDate.getUTCDate()).padStart(2,'0')} ${String(bDate.getUTCHours()).padStart(2,'0')}:${String(bDate.getUTCMinutes()).padStart(2,'0')})`;
            }
        }

        const statEmbed = new EmbedBuilder().setColor(0x9B59B6).setTitle(`📊 ${interaction.user.username} 的預約數據面板`)
            .addFields(
                { name: '本月完成預約', value: `${month} 次`, inline: true },
                { name: '歷史總完成預約', value: `${total} 次`, inline: true },
                { name: '臨時調整紀錄', value: `${points} / 3 次`, inline: false },
                { name: '帳號排單狀態', value: banStatus, inline: false }
            );
        await interaction.editReply({ embeds: [statEmbed] });
    }

    // =====================================
    // 預約觸發與表單
    // =====================================
    else if ((interaction.isButton() && interaction.customId === 'btn_reserve') || (interaction.isChatInputCommand() && interaction.commandName === '預約')) {
        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        if (userDoc.exists && userDoc.data().bannedUntil > Date.now()) {
            return interaction.reply({ content: `💡 **溫馨提醒**：您近期「臨時調整」達上限，權限暫時休息中喔！`, ephemeral: true });
        }
        
        if (interaction.isButton()) {
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('select_location').setPlaceholder('請選擇要預約的地點')
                .addOptions([ { label: '闇黑龍王', value: '闇黑龍王' }, { label: '艾畢奈亞', value: '艾畢奈亞' }, { label: '道館', value: '道館' }, { label: '其他', value: '其他' } ])
            );
            await interaction.reply({ content: '👇 **請選擇您要預約的地點：**', components: [row], ephemeral: true });
        } else {
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
    }
    else if (interaction.isStringSelectMenu() && interaction.customId === 'select_location') {
        const location = interaction.values[0];
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
        if (newDateTime.getTime() <= Date.now()) return interaction.reply({ content: '❌ **無法預約過去的時間**。', ephemeral: true });

        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const isConflict = reservations.some(res => res.location === location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000 && res.status === 'approved');
        if (isConflict) return interaction.reply({ content: '❌ 此時段前後10分鐘已有排單，請重新調整喔。', ephemeral: true });

        const docRef = await db.collection('reservations').add({
            discordId: interaction.user.id, gameId, date, time, location, channel, notes,
            timestamp: newDateTime.getTime(), reminded: false, status: 'pending', takenBy: null, postChecked: false
        });
        
        const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('🚨 新訂單待審核')
            .setDescription(`**玩家**：<@${interaction.user.id}> (遊戲ID: ${gameId})\n**地點**：${location}\n**時間**：\`${date} ${time}\`\n**頻道**：${channel || '-'}\n**備註**：${notes}`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${docRef.id}`).setLabel('✅ 審核通過').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${docRef.id}`).setLabel('❌ 拒絕').setStyle(ButtonStyle.Danger)
        );
        await broadcastToManagementAreas({ embeds: [embed], components: [row] });

        const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cancel_${docRef.id}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger));
        const dmEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⏳ 預約等待審核中')
            .setDescription(`您的訂單已送出，等待管理員審核通過後才會加入排班表喔！\n**地點**：${location}\n**時間**：${date} ${time}`);

        try {
            await interaction.user.send({ embeds: [dmEmbed], components: [cancelRow] });
            await interaction.reply({ content: `✅ 預約已送出！請查看 DM 等待審核結果。`, ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: `✅ 預約已送出，正在等待管理員審核。\n⚠️ **請開啟接收私訊功能，以便接收通知與按鈕！**`, ephemeral: true });
        }
    }

    // =====================================
    // 按鈕：審核 / 接單 / 結案 O_X / DM
    // =====================================
    else if (interaction.isButton()) {
        const [action, docId] = interaction.customId.split('_');
        const docRef = db.collection('reservations').doc(docId);
        const doc = await docRef.get();
        if (!doc.exists) return interaction.reply({ content: '❌ 找不到此訂單（可能已被刪除）。', ephemeral: true });
        const data = doc.data();

        // 【審核按鈕】
        if (action === 'approve' || action === 'reject') {
            if (data.status !== 'pending') return interaction.reply({ content: '❌ 這筆訂單已經被處理過囉！', ephemeral: true });
            const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            
            if (action === 'approve') {
                await docRef.update({ status: 'approved' });
                originalEmbed.setColor(0x00FF00).setTitle('✅ 已審核通過').addFields({ name: '審核人', value: `<@${interaction.user.id}>` });
                await interaction.update({ embeds: [originalEmbed], components: [] });
                try {
                    const user = await client.users.fetch(data.discordId);
                    const dmEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ 預約已審核通過')
                        .setDescription(`管理員已通過您的訂單，正式加入排班表！\n**地點**：${data.location}\n**時間**：${data.date} ${data.time}\n**頻道**：${data.channel || '未填寫'}`);
                    const btnRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`edit_${docId}`).setLabel('✏️ 變更登記資料').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`cancel_${docId}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger)
                    );
                    await user.send({ embeds: [dmEmbed], components: [btnRow] });
                } catch (e) {}
                updateBoard();
            } else {
                await docRef.update({ status: 'rejected' });
                originalEmbed.setColor(0xFF0000).setTitle('❌ 已拒絕').addFields({ name: '處理人', value: `<@${interaction.user.id}>` });
                await interaction.update({ embeds: [originalEmbed], components: [] });
                try {
                    const user = await client.users.fetch(data.discordId);
                    await user.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🚫 預約未通過').setDescription(`管理員退回了您的申請。\n**地點**：${data.location}\n**時間**：${data.date} ${data.time}`)], components: [] });
                } catch (e) {}
            }
            return;
        }

        // 【接單按鈕】
        if (action === 'takeOrder') {
            if (data.takenBy) return interaction.reply({ content: '❌ 這筆訂單已經被接走囉！', ephemeral: true });
            await docRef.update({ takenBy: interaction.user.id });
            const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            originalEmbed.setColor(0x00FF00).setTitle('✅ 訂單已接手').addFields({ name: '接單專員', value: `<@${interaction.user.id}>` });
            return interaction.update({ embeds: [originalEmbed], components: [] });
        }

        // 【結案 O/X 按鈕】
        if (action === 'complete' || action === 'fail') {
            if (data.status === 'completed' || data.status === 'failed') return interaction.reply({ content: '❌ 訂單已經結案過了！', ephemeral: true });
            const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            
            if (action === 'complete') {
                await docRef.update({ status: 'completed' });
                originalEmbed.setColor(0x00FF00).setTitle('✅ 訂單已結案 (⭕ 順利完成)').addFields({ name: '確認人', value: `<@${interaction.user.id}>` });
            } else {
                await docRef.update({ status: 'failed' });
                originalEmbed.setColor(0xFF0000).setTitle('❌ 訂單已結案 (❌ 未完成/取消)').addFields({ name: '確認人', value: `<@${interaction.user.id}>` });
            }
            await interaction.update({ embeds: [originalEmbed], components: [] });
            updateBoard();
            return;
        }

        // 【DM 取消/修改按鈕】
        if (data.timestamp < Date.now() && action !== 'edit' && action !== 'cancel') return;
        if (data.timestamp < Date.now()) {
            return interaction.update({ embeds: [new EmbedBuilder().setColor(0x808080).setTitle('📜 歷史紀錄').setDescription(`此預約時間已過。`)], components: [] });
        }
        
        const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;

        if (action === 'cancel') {
            await docRef.delete();
            const cancelEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚫 訂單已取消').setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}`);
            let replyText = '✅ **訂單已取消**。';
            
            if (isLastMinute && data.status === 'approved') {
                const { points, bannedUntil } = await addViolation(interaction.user.id);
                if (bannedUntil) replyText += `\n💡 **系統通知**：因近期臨時調整達上限，暫停預約權限 7 天。`;
                else replyText += `\n💡 **溫馨小提醒**：距離開打不到 30 分鐘取消，已記錄一次臨時調整（目前：${points}/3）。`;
                await broadcastToManagementAreas({ content: `📢 **【臨時釋出候補】**\n原本預約的【${data.location}】\`${data.date} ${data.time}\` 釋出了，欲接手請重新預約！` });
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

    else if (interaction.isModalSubmit() && interaction.customId.startsWith('submitEdit_')) {
        const docId = interaction.customId.split('_')[1];
        const newDate = interaction.fields.getTextInputValue('newDate').replace(/\//g, '-');
        let newTime = interaction.fields.getTextInputValue('newTime');
        const newGameId = interaction.fields.getTextInputValue('gameId');
        const newChannel = interaction.fields.getTextInputValue('channel') || '';
        const newNotes = interaction.fields.getTextInputValue('notes') || '無';
        
        if (newTime.length === 4 && newTime.indexOf(':') === 1) newTime = '0' + newTime;
        const newDateTime = new Date(`${newDate}T${newTime}:00+08:00`);

        if (isNaN(newDateTime.getTime())) return interaction.reply({ content: '❌ 格式錯誤。', ephemeral: true });
        if (newDateTime.getTime() <= Date.now()) return interaction.reply({ content: '❌ 無法改為過去的時間。', ephemeral: true });

        const currentDoc = await db.collection('reservations').doc(docId).get();
        if (!currentDoc.exists) return interaction.reply({ content: '❌ 找不到此訂單。', ephemeral: true });
        const data = currentDoc.data();
        const timeChanged = data.timestamp !== newDateTime.getTime();

        if (timeChanged) {
            const snapshot = await db.collection('reservations').get();
            let reservations = [];
            snapshot.forEach(doc => { if (doc.id !== docId) reservations.push({ id: doc.id, ...doc.data() }); });
            const isConflict = reservations.some(res => res.location === data.location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000 && res.status === 'approved');
            if (isConflict) return interaction.reply({ content: '❌ 申請時間前後10分鐘已排單。', ephemeral: true });
        }

        const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;
        let replyText = `✅ **資料已更新，重新提交審核中。**`;
        
        if (timeChanged && isLastMinute && data.status === 'approved') {
            const { points, bannedUntil } = await addViolation(interaction.user.id);
            if (bannedUntil) replyText += `\n💡 **系統通知**：因近期臨時調整達上限，暫停預約權限 7 天。`;
            else replyText += `\n💡 **溫馨小提醒**：距離原本開打不到 30 分鐘更改時間，已記錄一次臨時調整（目前：${points}/3）。`;
        }

        await db.collection('reservations').doc(docId).update({ 
            date: newDate, time: newTime, gameId: newGameId, channel: newChannel, notes: newNotes,
            timestamp: newDateTime.getTime(), reminded: false, status: 'pending', takenBy: null, postChecked: false
        });

        const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('🚨 訂單變更待重新審核')
            .setDescription(`**玩家**：<@${interaction.user.id}> (遊戲ID: ${newGameId})\n**地點**：${data.location}\n**新時間**：\`${newDate} ${newTime}\`\n**新頻道**：${newChannel || '-'}`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${docId}`).setLabel('✅ 審核通過').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${docId}`).setLabel('❌ 拒絕').setStyle(ButtonStyle.Danger)
        );
        await broadcastToManagementAreas({ embeds: [embed], components: [row] });

        await interaction.reply({ content: replyText, ephemeral: true });
        const dmEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⏳ 預約變更待審核中')
            .setDescription(`資料已變更，等待管理員重新審核。\n**地點**：${data.location}\n**時間**：${newDate} ${newTime}`);
        const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cancel_${docId}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger));
        await interaction.message.edit({ embeds: [dmEmbed], components: [cancelRow] });

        updateBoard();
    }
});

client.login(process.env.DISCORD_TOKEN);
