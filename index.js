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
// 3. Discord 機器人核心邏輯
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });

const publicBoardIntro = "🎉 **歡迎來到迴響預約中心！**\n為了出團順暢，請提早預約您的專屬迴響時段。\n👇 請點擊下方 **【📝 預約迴響時間】** 快速排單，系統將會為您登記並通知審核！";
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

function getBoardContentWithTime() {
    const tw = getTaiwanTime();
    return `${publicBoardIntro}\n\n🔄 **最後刷新時間**：\`${tw.yyyy}-${tw.mm}-${tw.dd} ${tw.hh}:${tw.min}\``;
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

// 廣播工單至管理區
async function broadcastToManagementAreas(payload) {
    const doc = await db.collection('settings').doc('managementArea').get();
    if (!doc.exists) return [];
    const channels = doc.data().channels || [];
    let sentMsgs = [];
    for (const chId of channels) {
        const dChannel = await client.channels.fetch(chId).catch(() => null);
        if (dChannel) {
            const msg = await dChannel.send(payload).catch(() => null);
            if (msg) sentMsgs.push({ channelId: chId, messageId: msg.id });
        }
    }
    return sentMsgs;
}

// 原地更新工單 (靜態變更)
async function syncManagementMessages(msgRefs, newEmbed, newComponents = []) {
    if (!msgRefs || !Array.isArray(msgRefs)) return;
    for (const m of msgRefs) {
        try {
            const ch = await client.channels.fetch(m.channelId).catch(() => null);
            if (ch) {
                const msg = await ch.messages.fetch(m.messageId).catch(() => null);
                if (msg) await msg.edit({ embeds: [newEmbed], components: newComponents });
            }
        } catch (e) {}
    }
}

// 動態推移工單 (刪除舊卡片，發新卡片置底)
async function bumpManagementMessages(msgRefs, newEmbed, newComponents = []) {
    if (!msgRefs || !Array.isArray(msgRefs)) return [];
    let newRefs = [];
    for (const m of msgRefs) {
        try {
            const ch = await client.channels.fetch(m.channelId).catch(() => null);
            if (ch) {
                const oldMsg = await ch.messages.fetch(m.messageId).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => null); 
                const newMsg = await ch.send({ embeds: [newEmbed], components: newComponents }); 
                newRefs.push({ channelId: ch.id, messageId: newMsg.id });
            }
        } catch (e) {}
    }
    return newRefs;
}

async function editUserDM(discordId, messageId, payload) {
    if (!messageId) return;
    try {
        const user = await client.users.fetch(discordId);
        const dmChannel = await user.createDM();
        const msg = await dmChannel.messages.fetch(messageId);
        if (msg) await msg.edit(payload);
    } catch (e) {}
}

function buildTicketPayload(docId, data) {
    let embed = new EmbedBuilder();
    let components = [];
    let row = new ActionRowBuilder();

    const baseDesc = `**玩家**：<@${data.discordId}> (遊戲ID: ${data.gameId})\n**地點**：${data.location}\n**頻道**：${data.channel || '-'}\n**預約時間**：\`${data.date} ${data.time}\`\n**備註**：${data.notes || '無'}\n\n**📋 訂單時間線**：\n`;
    let timeline = '';

    if (data.status === 'pending') {
        embed.setColor(0xFFA500).setTitle('🚨 新訂單待審核');
        timeline += `> 🟡 審核等待中...\n`;
        row.addComponents(
            new ButtonBuilder().setCustomId(`approve_${docId}`).setLabel('✅ 審核通過').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${docId}`).setLabel('❌ 拒絕').setStyle(ButtonStyle.Danger)
        );
    } else if (data.status === 'rejected') {
        embed.setColor(0xFF0000).setTitle('❌ 訂單已拒絕');
        timeline += `> 🔴 已拒絕 (審核：<@${data.reviewer}>)\n`;
    } else if (data.status === 'expired') {
        embed.setColor(0x808080).setTitle('⏳ 申請已過期失效');
        timeline += `> ⚪ 未審核，開打時間已過自動失效\n`;
    } else if (data.status === 'canceled') {
        embed.setColor(0x808080).setTitle('🚫 玩家已自行取消');
        timeline += `> ⚪ 玩家已取消\n`;
    } else {
        timeline += `> ✅ 審核通過 (審核：<@${data.reviewer || '管理員'}>)\n`;

        if (data.status === 'approved') {
            if (!data.reminded) {
                embed.setColor(0x00FF00).setTitle('🟢 訂單已排程');
                timeline += `> ⏳ 等待鬧鐘發送...\n`;
            } else if (data.reminded && !data.postChecked) {
                if (!data.takenBy) {
                    embed.setColor(0xFFA500).setTitle('🚨 準備出團 (等待接單)');
                    timeline += `> 🟡 鬧鐘已響，等待專員接單...\n`;
                    row.addComponents(new ButtonBuilder().setCustomId(`takeOrder_${docId}`).setLabel('✋ 我來接單').setStyle(ButtonStyle.Primary));
                } else {
                    embed.setColor(0x00FF00).setTitle('🟢 專員已接單');
                    timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
                    timeline += `> ⏳ 等待出團與結案...\n`;
                }
            } else if (data.postChecked) {
                embed.setColor(0x8A2BE2).setTitle('🟣 等待結案回報');
                if (data.takenBy) {
                    timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
                    timeline += `> 🟡 等待專員回報結案...\n`;
                    if (data.dmFailed) {
                        timeline += `> ⚠️ 無法私訊，請在此直接結案！\n`;
                        row.addComponents(
                            new ButtonBuilder().setCustomId(`complete_${docId}`).setLabel('⭕ 順利完成').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`fail_${docId}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                        );
                    }
                } else {
                    timeline += `> 🔴 警告：此單無人接手！\n`;
                    timeline += `> 🟡 等待任何專員幫忙補結案...\n`;
                    row.addComponents(
                        new ButtonBuilder().setCustomId(`complete_${docId}`).setLabel('⭕ 順利完成').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`fail_${docId}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                    );
                }
            }
        } else if (data.status === 'completed') {
            embed.setColor(0x00FF00).setTitle('⭕ 訂單已結案 (順利完成)');
            if (data.takenBy) timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
            timeline += `> ⭕ 順利完成 (確認：<@${data.closer || data.takenBy}>)\n`;
        } else if (data.status === 'failed') {
            embed.setColor(0xFF0000).setTitle('❌ 訂單已結案 (未完成/取消)');
            if (data.takenBy) timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
            timeline += `> ❌ 未完成/取消 (確認：<@${data.closer || data.takenBy || '系統'}>)\n`;
        }
    }

    embed.setDescription(baseDesc + timeline);
    if (row.components.length > 0) components.push(row);
    return { embeds: [embed], components };
}

function generateScheduleEmbed(reservations, isAdmin = false) {
    const now = Date.now();
    const tw = getTaiwanTime();
    const todayStr = `${tw.yyyy}-${tw.mm}-${tw.dd}`;
    const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;

    const stats = {};
    reservations.forEach(r => {
        if (r.status !== 'approved' && r.status !== 'completed') return;
        if (!stats[r.discordId]) stats[r.discordId] = { total: 0, month: 0 };
        stats[r.discordId].total += 1;
        if (r.date.startsWith(currentMonthPrefix)) stats[r.discordId].month += 1;
    });

    let futureRes = reservations.filter(res => res.status === 'approved' && res.timestamp >= now).sort((a, b) => a.timestamp - b.timestamp);
    if (!isAdmin) futureRes = futureRes.filter(res => res.date === todayStr);

    let scheduleText = '';

    if (futureRes.length === 0) {
        scheduleText += isAdmin ? '目前沒有任何已通過的未來預約喔！\n\n' : '本日目前沒有已通過的預約喔！\n\n';
    } else {
        const grouped = {};
        futureRes.forEach(res => {
            if (!grouped[res.date]) grouped[res.date] = [];
            grouped[res.date].push(res);
        });

        for (const [date, items] of Object.entries(grouped)) {
            scheduleText += `**📅 ${date}**\n\n`;
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
    }

    scheduleText += `🔄 **最後刷新時間**：\`${tw.yyyy}-${tw.mm}-${tw.dd} ${tw.hh}:${tw.min}\``;

    return new EmbedBuilder()
        .setColor(isAdmin ? 0xFF0000 : 0x0099FF)
        .setTitle(isAdmin ? '👑【管理員】王團自動排班表' : '👤 迴響預約清單')
        .setDescription(scheduleText);
}

async function updateBoard() {
    try {
        const snapshot = await db.collection('reservations').get();
        let reservations = [];
        snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

        const boardContent = getBoardContentWithTime();

        const pubRef = db.collection('settings').doc('publicBoards');
        const pubDoc = await pubRef.get();
        if (pubDoc.exists) {
            let list = pubDoc.data().list || [];
            let validList = [];
            let dbChanged = false;
            for (let i = 0; i < list.length; i++) {
                const b = list[i];
                try {
                    const ch = await client.channels.fetch(b.channelId).catch(() => null);
                    if (ch) {
                        const msg = await ch.messages.fetch(b.messageId).catch(() => null);
                        if (msg) {
                            await msg.edit({ content: publicBoardIntro, embeds: [generateScheduleEmbed(reservations, false)], components: [reserveBtnRow] });
                            validList.push(b);
                        } else {
                            const newMsg = await ch.send({ content: publicBoardIntro, embeds: [generateScheduleEmbed(reservations, false)], components: [reserveBtnRow] });
                            validList.push({ channelId: ch.id, messageId: newMsg.id });
                            dbChanged = true;
                        }
                    } else dbChanged = true;
                } catch (e) { dbChanged = true; }
            }
            if (dbChanged || list.length !== validList.length) await pubRef.set({ list: validList });
        }

        const admRef = db.collection('settings').doc('adminBoards');
        const admDoc = await admRef.get();
        if (admDoc.exists) {
            let list = admDoc.data().list || [];
            let validList = [];
            let dbChanged = false;
            for (let i = 0; i < list.length; i++) {
                const b = list[i];
                try {
                    const ch = await client.channels.fetch(b.channelId).catch(() => null);
                    if (ch) {
                        const msg = await ch.messages.fetch(b.messageId).catch(() => null);
                        if (msg) {
                            await msg.edit({ content: null, embeds: [generateScheduleEmbed(reservations, true)] });
                            validList.push(b);
                        } else {
                            const newMsg = await ch.send({ embeds: [generateScheduleEmbed(reservations, true)] });
                            validList.push({ channelId: ch.id, messageId: newMsg.id });
                            dbChanged = true;
                        }
                    } else dbChanged = true;
                } catch (e) { dbChanged = true; }
            }
            if (dbChanged || list.length !== validList.length) await admRef.set({ list: validList });
        }
    } catch (e) { console.log('看板更新失敗', e); }
}

client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    const commands = [
        { name: '預約', description: '開啟王團預約表單', options: [{ name: '地點', type: 3, description: '請選擇預約地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }] },
        { name: '我的紀錄', description: '查詢個人的預約統計與排單狀態' },
        { name: '接單統計', description: '查詢各專員的接單與完成數量 (管理員)' },
        { name: '清理訊息', description: '批次清理頻道內的訊息 (管理員)', options: [{ name: '數量', type: 4, description: '要刪除的訊息數量 (1-100)', required: true }] },
        { name: '設定公開看板', description: '將此頻道加入或移除「公開看板區」' },
        { name: '設定管理看板', description: '將此頻道加入或移除「真實名單看板區」' },
        { name: '迴響管理區', description: '將此頻道加入或移除「迴響管理區」' },
        { name: '價格', description: '設定價格', options: [ { name: '地點', type: 3, description: '地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }, { name: '價格', type: 4, description: '萬', required: true } ] },
        { name: '迴響鬧鐘', description: '設定鬧鐘提前分鐘', options: [{ name: '分鐘', type: 4, description: '分鐘', required: true }] },
        { name: '優惠設定', description: '設定VIP規則', options: [ { name: '地點', type: 3, description: '地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }, { name: '滿幾次', type: 4, description: '次數', required: true }, { name: '送幾次', type: 4, description: '次數', required: true } ] }
    ];
    await client.application.commands.set(commands);

    setInterval(async () => {
        const now = Date.now();
        try {
            const pricesDoc = await db.collection('settings').doc('prices').get();
            const prices = pricesDoc.exists ? pricesDoc.data() : {};
            const alarmDoc = await db.collection('settings').doc('alarm').get();
            const alarmLeadTime = alarmDoc.exists ? alarmDoc.data().leadTime : 15;
            const vipDoc = await db.collection('settings').doc('vipRules').get();
            const vipRules = vipDoc.exists ? vipDoc.data() : {};
            
            const allResSnapshot = await db.collection('reservations').get();
            let allRes = [];
            allResSnapshot.forEach(d => allRes.push({ id: d.id, ...d.data() }));

            for (let data of allRes) {
                const timeDiff = data.timestamp - now;
                let needsSync = false;
                let needsBump = false;
                const displayChannel = data.channel ? data.channel : '-'; 

                // 1. 過期清理
                if (data.status === 'pending' && data.timestamp < now) {
                    await db.collection('reservations').doc(data.id).update({ status: 'expired' });
                    needsSync = true;
                    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [new EmbedBuilder().setColor(0x808080).setTitle('⏳ 預約已過期失效').setDescription(`您的預約因超過開打時間未審核，已自動失效。\n**地點**：${data.location}\n**時間**：${data.date} ${data.time}`)], components: [] });
                }

                // 2. 鬧鐘階段
                if (data.status === 'approved' && !data.reminded && timeDiff <= alarmLeadTime * 60 * 1000 && timeDiff > 0) {
                    await db.collection('reservations').doc(data.id).update({ reminded: true });
                    needsBump = true; 

                    let finalPriceStr = `${prices[data.location] || '未設定'}萬`;
                    const rule = vipRules[data.location];
                    if (rule && rule.buy > 0) {
                        const userHistory = allRes.filter(r => r.discordId === data.discordId && r.location === data.location && (r.status === 'approved' || r.status === 'completed')).sort((a, b) => a.timestamp - b.timestamp);
                        const orderIndex = userHistory.findIndex(r => r.id === data.id);
                        if (orderIndex !== -1) {
                            const cycle = rule.buy + rule.free;
                            if ((orderIndex % cycle) >= rule.buy) finalPriceStr = `0萬 (💎 VIP滿件優惠)`;
                        }
                    }

                    const pre5MinTime = data.timestamp - 5 * 60 * 1000;
                    const twPre5Obj = new Date(pre5MinTime + 8 * 60 * 60 * 1000);
                    const pre5MinStr = String(twPre5Obj.getUTCHours()).padStart(2, '0') + ':' + String(twPre5Obj.getUTCMinutes()).padStart(2, '0');

                    try {
                        const user = await client.users.fetch(data.discordId);
                        await user.send(`🔔 **王團預約提醒鬧鐘**\n您預約的【${data.location}】將在 ${alarmLeadTime} 分鐘後（\`${data.date} ${data.time}\`）於 \`${displayChannel}\` 頻道施放迴響！\n*(請備妥 ${finalPriceStr} 楓幣給專員)*`);
                    } catch (e) {}

                    if (data.takenBy) {
                        try {
                            const adminUser = await client.users.fetch(data.takenBy);
                            await adminUser.send(`🔔 **王團預約提醒鬧鐘**\n<@${data.discordId}> 與您預約的【${data.location}】須於 ${alarmLeadTime} 分鐘後（\`${data.date} ${data.time}\`）於 \`${displayChannel}\` 頻道施放迴響！\n請記得於（\`${data.date} ${pre5MinStr}\`）上線並準備施放 **英雄的迴響** 喔！`);
                        } catch (e) {}
                    } else {
                        await broadcastToManagementAreas({ content: `🚨 **【緊急派單通知】**\n<@${data.discordId}> 預約的【${data.location}】將在 ${alarmLeadTime} 分鐘後出團，目前**尚未有專員接單**！\n請盡速點擊下方卡片的「✋ 我來接單」！` });
                    }
                }

                // 3. 【全新】開打時間一過，自動移除玩家 DM 的變更按鈕
                if (data.status === 'approved' && !data.buttonsRemoved && now >= data.timestamp) {
                    await editUserDM(data.discordId, data.userDmMsgId, { components: [] });
                    await db.collection('reservations').doc(data.id).update({ buttonsRemoved: true });
                }

                // 4. 結案階段
                if (data.status === 'approved' && data.reminded && !data.postChecked && now - data.timestamp >= 10 * 60 * 1000) {
                    let dmFailed = false;
                    if (data.takenBy) {
                        try {
                            const adminUser = await client.users.fetch(data.takenBy);
                            const row = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`complete_${data.id}`).setLabel('⭕ 順利完成').setStyle(ButtonStyle.Success),
                                new ButtonBuilder().setCustomId(`fail_${data.id}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                            );
                            await adminUser.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle('⏱️ 訂單結案確認').setDescription(`**玩家**：<@${data.discordId}>\n**地點**：${data.location}\n**頻道**：${displayChannel}\n**預約時間**：\`${data.date} ${data.time}\`\n\n*請問順利完成了嗎？*`)], components: [row] });
                        } catch (e) { dmFailed = true; }
                    }
                    await db.collection('reservations').doc(data.id).update({ postChecked: true, dmFailed });
                    needsBump = true;
                    data.postChecked = true; data.dmFailed = dmFailed;
                }

                // 5. 強制逾期結算
                if (data.status === 'approved' && data.postChecked && now - data.timestamp >= 12 * 60 * 60 * 1000) {
                    await db.collection('reservations').doc(data.id).update({ status: 'failed', closer: '系統自動結案' });
                    needsSync = true;
                    data.status = 'failed'; data.closer = '系統自動結案';
                }

                if (needsBump) {
                    const payload = buildTicketPayload(data.id, data);
                    const newRefs = await bumpManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                    await db.collection('reservations').doc(data.id).update({ ticketMsgs: newRefs });
                } else if (needsSync) {
                    const payload = buildTicketPayload(data.id, data);
                    await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                }
            }
            
            updateBoard();
            
        } catch (error) { console.error(error); }
    }, 60 * 1000); 
});

// 【核心防禦】加入 try-catch 保護所有指令互動
client.on('interactionCreate', async interaction => {
    try {
        // =====================================
        // 一般與管理設定指令
        // =====================================
        if (interaction.isChatInputCommand()) {
            // 【秒開技術】遇到預約，直接彈出，絕不延遲！
            if (interaction.commandName === '預約') {
                const location = interaction.options.getString('地點');
                const tw = getTaiwanTime();
                const modal = new ModalBuilder().setCustomId(`reserve_${location}`).setTitle(`📝 預約：${location}`);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel("日期 (可修改)").setStyle(TextInputStyle.Short).setValue(`${tw.yyyy}-${tw.mm}-${tw.dd}`).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel("時間 (24小時制)").setStyle(TextInputStyle.Short).setValue(`${tw.hh}:${tw.min}`).setMaxLength(5).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gameId').setLabel("預約者遊戲ID").setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel("幸運頻道").setStyle(TextInputStyle.Short).setRequired(false)), 
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel("備註").setStyle(TextInputStyle.Short).setRequired(false))
                );
                return interaction.showModal(modal);
            }

            // 其餘指令安全等待
            await interaction.deferReply({ ephemeral: true });

            if (interaction.commandName === '清理訊息') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const amount = interaction.options.getInteger('數量');
                try {
                    await interaction.channel.bulkDelete(amount, true);
                    return interaction.editReply({ content: `✅ 成功清理了 ${amount} 則訊息！` });
                } catch (e) {
                    return interaction.editReply({ content: `❌ 清理失敗，可能包含超過 14 天的舊訊息，Discord 系統限制無法直接刪除。` });
                }
            }
            else if (interaction.commandName === '迴響管理區') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const docRef = db.collection('settings').doc('managementArea');
                const doc = await docRef.get();
                let channels = doc.exists ? (doc.data().channels || []) : [];
                if (channels.includes(interaction.channelId)) {
                    channels = channels.filter(id => id !== interaction.channelId);
                    await docRef.set({ channels });
                    return interaction.editReply({ content: '✅ 已將此頻道從「迴響管理區」移除。' });
                } else {
                    channels.push(interaction.channelId);
                    await docRef.set({ channels });
                    return interaction.editReply({ content: '✅ **設定成功！** 此頻道將同步接收所有工單卡片。' });
                }
            }
            else if (interaction.commandName === '設定公開看板') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const docRef = db.collection('settings').doc('publicBoards');
                const doc = await docRef.get();
                let list = doc.exists ? (doc.data().list || []) : [];
                const existingIdx = list.findIndex(b => b.channelId === interaction.channelId);
                if (existingIdx !== -1) {
                    list.splice(existingIdx, 1);
                    await docRef.set({ list });
                    return interaction.editReply({ content: '✅ 已移除公開看板維護。' });
                } else {
                    const msg = await interaction.channel.send({ content: getBoardContentWithTime(), embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0x0099FF)], components: [reserveBtnRow] });
                    list.push({ channelId: interaction.channelId, messageId: msg.id });
                    await docRef.set({ list });
                    await interaction.editReply({ content: '✅ 公開看板設定成功！' });
                    updateBoard();
                }
            }
            else if (interaction.commandName === '設定管理看板') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const docRef = db.collection('settings').doc('adminBoards');
                const doc = await docRef.get();
                let list = doc.exists ? (doc.data().list || []) : [];
                const existingIdx = list.findIndex(b => b.channelId === interaction.channelId);
                if (existingIdx !== -1) {
                    list.splice(existingIdx, 1);
                    await docRef.set({ list });
                    return interaction.editReply({ content: '✅ 已移除真實名單看板。' });
                } else {
                    const tw = getTaiwanTime();
                    const msg = await interaction.channel.send({ content: `🔄 **最後刷新時間**：\`${tw.yyyy}-${tw.mm}-${tw.dd} ${tw.hh}:${tw.min}\``, embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0xFF0000)] });
                    list.push({ channelId: interaction.channelId, messageId: msg.id });
                    await docRef.set({ list });
                    await interaction.editReply({ content: '✅ 管理看板設定成功！' });
                    updateBoard();
                }
            }
            else if (interaction.commandName === '價格') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const loc = interaction.options.getString('地點');
                const price = interaction.options.getInteger('價格');
                await db.collection('settings').doc('prices').set({ [loc]: price }, { merge: true });
                await interaction.editReply({ content: `✅ 已將【${loc}】的價格設定為 **${price}萬**。` });
            }
            else if (interaction.commandName === '迴響鬧鐘') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const mins = interaction.options.getInteger('分鐘');
                await db.collection('settings').doc('alarm').set({ leadTime: mins }, { merge: true });
                await interaction.editReply({ content: `✅ 已設定鬧鐘提前 **${mins}分鐘** 發送。` });
            }
            else if (interaction.commandName === '優惠設定') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const loc = interaction.options.getString('地點');
                const buy = interaction.options.getInteger('滿幾次');
                const free = interaction.options.getInteger('送幾次');
                await db.collection('settings').doc('vipRules').set({ [loc]: { buy, free } }, { merge: true });
                await interaction.editReply({ content: `✅ 已設定【${loc}】優惠規則：滿 **${buy}** 送 **${free}**。` });
            }
            else if (interaction.commandName === '我的紀錄') {
                // 修正複合索引錯誤，改為撈取全部再由程式過濾
                const snapshot = await db.collection('reservations').where('discordId', '==', interaction.user.id).get();
                const tw = getTaiwanTime();
                const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;
                let total = 0, month = 0;
                snapshot.forEach(doc => { 
                    const d = doc.data();
                    if (d.status === 'approved' || d.status === 'completed') {
                        total++; 
                        if (d.date.startsWith(currentMonthPrefix)) month++; 
                    }
                });
                const userDoc = await db.collection('users').doc(interaction.user.id).get();
                let points = 0;
                let banStatus = '🟢 正常 (功能皆可使用)';
                if (userDoc.exists) {
                    const ud = userDoc.data();
                    points = ud.violationPoints || 0;
                    if (ud.bannedUntil && ud.bannedUntil > Date.now()) {
                        const bDate = new Date(ud.bannedUntil + 8 * 3600 * 1000);
                        banStatus = `🔴 預約休息中 (解除時間：${bDate.getUTCFullYear()}-${String(bDate.getUTCMonth()+1).padStart(2,'0')}-${String(bDate.getUTCDate()).padStart(2,'0')} ${String(bDate.getUTCHours()).padStart(2,'0')}:${String(bDate.getUTCMinutes()).padStart(2,'0')})`;
                    }
                }
                const statEmbed = new EmbedBuilder().setColor(0x9B59B6).setTitle(`📊 ${interaction.user.username} 的預約數據`)
                    .addFields({ name: '本月排單', value: `${month} 次`, inline: true }, { name: '歷史總單', value: `${total} 次`, inline: true }, { name: '臨時調整', value: `${points} / 3 次`, inline: false }, { name: '帳號狀態', value: banStatus, inline: false });
                await interaction.editReply({ embeds: [statEmbed] });
            }
            else if (interaction.commandName === '接單統計') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const allResSnapshot = await db.collection('reservations').get();
                const tw = getTaiwanTime();
                const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;
                const stats = {};
                allResSnapshot.forEach(doc => {
                    const r = doc.data();
                    if (r.takenBy && (r.status === 'completed' || r.status === 'failed')) {
                        if (!stats[r.takenBy]) stats[r.takenBy] = { total: 0, month: 0, failed: 0 };
                        if (r.status === 'completed') { stats[r.takenBy].total += 1; if (r.date.startsWith(currentMonthPrefix)) stats[r.takenBy].month += 1; } 
                        else if (r.status === 'failed') { stats[r.takenBy].failed += 1; }
                    }
                });
                if (Object.keys(stats).length === 0) return interaction.editReply({ content: '目前無專員結案紀錄喔！' });
                let desc = '';
                for (const [userId, s] of Object.entries(stats)) { desc += `**專員**：<@${userId}>\n> 本月完成：\`${s.month}\` 次\n> 歷史總完成：\`${s.total}\` 次\n> 失敗/取消數：\`${s.failed}\` 次\n\n`; }
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('📊 迴響專員接單績效').setDescription(desc)] });
            }
        }

        // =====================================
        // 預約按鈕觸發：【先 Defer 保平安】
        // =====================================
        else if (interaction.isButton() && interaction.customId === 'btn_reserve') {
            await interaction.deferReply({ ephemeral: true });
            
            const userDoc = await db.collection('users').doc(interaction.user.id).get();
            if (userDoc.exists && userDoc.data().bannedUntil > Date.now()) {
                return interaction.editReply({ content: `💡 **溫馨提醒**：您近期「臨時調整」達上限，權限暫停中喔！` });
            }
            
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('select_location').setPlaceholder('請選擇要預約的地點')
                .addOptions([ { label: '闇黑龍王', value: '闇黑龍王' }, { label: '艾畢奈亞', value: '艾畢奈亞' }, { label: '道館', value: '道館' }, { label: '其他', value: '其他' } ])
            );
            await interaction.editReply({ content: '👇 **請選擇您要預約的地點：**', components: [row] });
        }
        else if (interaction.isStringSelectMenu() && interaction.customId === 'select_location') {
            const location = interaction.values[0];
            const tw = getTaiwanTime();
            const modal = new ModalBuilder().setCustomId(`reserve_${location}`).setTitle(`📝 預約：${location}`);
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel("日期 (可修改)").setStyle(TextInputStyle.Short).setValue(`${tw.yyyy}-${tw.mm}-${tw.dd}`).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel("時間 (24小時制)").setStyle(TextInputStyle.Short).setValue(`${tw.hh}:${tw.min}`).setMaxLength(5).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gameId').setLabel("預約者遊戲ID").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel("幸運頻道").setStyle(TextInputStyle.Short).setRequired(false)), 
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel("備註").setStyle(TextInputStyle.Short).setRequired(false))
            );
            await interaction.showModal(modal);
        }

        // =====================================
        // 表單送出
        // =====================================
        else if (interaction.isModalSubmit() && interaction.customId.startsWith('reserve_')) {
            await interaction.deferReply({ ephemeral: true });
            
            // 使用者提交表單後，順便把選單那則訊息收起來，保持畫面乾淨
            if (interaction.message) await interaction.message.delete().catch(() => {});

            const location = interaction.customId.split('_')[1];
            const date = interaction.fields.getTextInputValue('date').replace(/\//g, '-');
            let time = interaction.fields.getTextInputValue('time');
            const gameId = interaction.fields.getTextInputValue('gameId');
            const channel = interaction.fields.getTextInputValue('channel') || ''; 
            const notes = interaction.fields.getTextInputValue('notes') || '無';
            
            if (time.length === 4 && time.indexOf(':') === 1) time = '0' + time;
            const newDateTime = new Date(`${date}T${time}:00+08:00`);

            if (isNaN(newDateTime.getTime())) return interaction.editReply({ content: '❌ **日期或時間格式錯誤**。' });
            if (newDateTime.getTime() <= Date.now()) return interaction.editReply({ content: '❌ **無法預約過去的時間**。' });

            const snapshot = await db.collection('reservations').get();
            let reservations = [];
            snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));

            const isConflict = reservations.some(res => res.location === location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000 && res.status === 'approved');
            if (isConflict) return interaction.editReply({ content: '❌ 此時段前後10分鐘已有排單，請重新調整喔。' });

            const data = {
                discordId: interaction.user.id, gameId, date, time, location, channel, notes,
                timestamp: newDateTime.getTime(), reminded: false, status: 'pending', takenBy: null, postChecked: false, userDmMsgId: null, buttonsRemoved: false
            };
            const docRef = await db.collection('reservations').add(data);
            data.id = docRef.id;

            const payload = buildTicketPayload(docRef.id, data);
            const sentMsgs = await broadcastToManagementAreas(payload);
            await docRef.update({ ticketMsgs: sentMsgs });

            const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cancel_${docRef.id}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger));
            const dmEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⏳ 預約等待審核中')
                .setDescription(`您的訂單已送出，等待管理員審核通過後才會加入排班表喔！\n**地點**：${location}\n**時間**：${date} ${time}`);

            try {
                const dmMsg = await interaction.user.send({ embeds: [dmEmbed], components: [cancelRow] });
                await docRef.update({ userDmMsgId: dmMsg.id });
                await interaction.editReply({ content: `✅ 預約已送出！請查看 DM 等待審核結果。` });
            } catch (error) {
                await interaction.editReply({ content: `✅ 預約已送出，正在等待管理員審核。\n⚠️ **請開啟接收私訊功能！**` });
            }
        }

        // =====================================
        // 管理按鈕
        // =====================================
        else if (interaction.isButton()) {
            const [action, docId] = interaction.customId.split('_');

            if (action === 'edit') {
                const docRef = db.collection('reservations').doc(docId);
                const doc = await docRef.get();
                if (!doc.exists) return interaction.reply({ content: '❌ 找不到此訂單。', ephemeral: true });
                const data = doc.data();
                
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
                return interaction.showModal(modal);
            }

            await interaction.deferUpdate();

            const docRef = db.collection('reservations').doc(docId);
            const doc = await docRef.get();
            if (!doc.exists) return interaction.followUp({ content: '❌ 找不到此訂單（可能已被刪除）。', ephemeral: true });
            let data = doc.data();

            if (action === 'approve' || action === 'reject') {
                if (data.status !== 'pending') return interaction.followUp({ content: '❌ 訂單已處理過囉！', ephemeral: true });
                data.status = action === 'approve' ? 'approved' : 'rejected';
                data.reviewer = interaction.user.id;
                await docRef.update({ status: data.status, reviewer: data.reviewer });
                
                const payload = buildTicketPayload(docId, data);
                await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                
                if (action === 'approve') {
                    const dmEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ 預約已通過').setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}`);
                    const btnRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`edit_${docId}`).setLabel('✏️ 變更登記資料').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`cancel_${docId}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger)
                    );
                    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [dmEmbed], components: [btnRow] });
                    updateBoard();
                } else {
                    const dmEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚫 預約未通過').setDescription(`管理員退回了您的申請。\n**地點**：${data.location}`);
                    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [dmEmbed], components: [] });
                }
                return;
            }

            if (action === 'takeOrder') {
                if (data.takenBy) return interaction.followUp({ content: '❌ 已經被接走囉！', ephemeral: true });
                data.takenBy = interaction.user.id;
                await docRef.update({ takenBy: data.takenBy });
                
                const payload = buildTicketPayload(docId, data);
                await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                return;
            }

            if (action === 'complete' || action === 'fail') {
                if (data.status === 'completed' || data.status === 'failed') return interaction.followUp({ content: '❌ 已經結案過了！', ephemeral: true });
                if (data.takenBy && data.takenBy !== interaction.user.id) return interaction.followUp({ content: `❌ 只有專員 <@${data.takenBy}> 才能確認結案！`, ephemeral: true });

                data.status = action === 'complete' ? 'completed' : 'failed';
                data.closer = interaction.user.id;
                if (!data.takenBy) data.takenBy = interaction.user.id;

                await docRef.update({ status: data.status, closer: data.closer, takenBy: data.takenBy });
                
                const payload = buildTicketPayload(docId, data);
                await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                try { await interaction.editReply({ components: [] }); } catch(e){}
                updateBoard();
                return;
            }

            if (data.timestamp < Date.now()) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x808080).setTitle('📜 歷史紀錄').setDescription(`預約時間已過。`)], components: [] });
            
            if (action === 'cancel') {
                const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;
                const wasApproved = data.status === 'approved';
                
                data.status = 'canceled';
                await docRef.update({ status: 'canceled' });
                
                const payload = buildTicketPayload(docId, data);
                await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);

                let replyText = '✅ **訂單已取消**。';
                if (isLastMinute && wasApproved) {
                    const { points, bannedUntil } = await addViolation(data.discordId);
                    if (bannedUntil) replyText += `\n💡 系統通知：暫停預約權限 7 天。`;
                    else replyText += `\n💡 溫馨提醒：已記錄一次臨時調整（目前：${points}/3）。`;
                }
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🚫 訂單已取消').setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}`)], components: [] });
                await interaction.followUp({ content: replyText, ephemeral: true });
                updateBoard();
            }
        }

        // =====================================
        // 修改表單送出
        // =====================================
        else if (interaction.isModalSubmit() && interaction.customId.startsWith('submitEdit_')) {
            await interaction.deferUpdate(); 
            
            const docId = interaction.customId.split('_')[1];
            const newDate = interaction.fields.getTextInputValue('newDate').replace(/\//g, '-');
            let newTime = interaction.fields.getTextInputValue('newTime');
            const newGameId = interaction.fields.getTextInputValue('gameId');
            const newChannel = interaction.fields.getTextInputValue('channel') || '';
            const newNotes = interaction.fields.getTextInputValue('notes') || '無';
            
            if (newTime.length === 4 && newTime.indexOf(':') === 1) newTime = '0' + newTime;
            const newDateTime = new Date(`${newDate}T${newTime}:00+08:00`);

            if (isNaN(newDateTime.getTime())) return interaction.followUp({ content: '❌ 格式錯誤。', ephemeral: true });
            if (newDateTime.getTime() <= Date.now()) return interaction.followUp({ content: '❌ 無法改為過去的時間。', ephemeral: true });

            const currentDoc = await db.collection('reservations').doc(docId).get();
            if (!currentDoc.exists) return interaction.followUp({ content: '❌ 找不到此訂單。', ephemeral: true });
            let data = currentDoc.data();
            const timeChanged = data.timestamp !== newDateTime.getTime();

            if (timeChanged) {
                const snapshot = await db.collection('reservations').get();
                let reservations = [];
                snapshot.forEach(doc => { if (doc.id !== docId) reservations.push({ id: doc.id, ...doc.data() }); });
                const isConflict = reservations.some(res => res.location === data.location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000 && res.status === 'approved');
                if (isConflict) return interaction.followUp({ content: '❌ 申請時間前後10分鐘已排單。', ephemeral: true });
            }

            const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;
            let replyText = `✅ **資料已更新，並已推進置底等待審核。**`;
            
            if (timeChanged && isLastMinute && data.status === 'approved') {
                const { points, bannedUntil } = await addViolation(interaction.user.id);
                if (bannedUntil) replyText += `\n💡 **系統通知**：因近期臨時調整達上限，暫停預約權限 7 天。`;
                else replyText += `\n💡 **溫馨小提醒**：距離原本開打不到 30 分鐘更改時間，已記錄一次臨時調整（目前：${points}/3）。`;
            }

            data.date = newDate; data.time = newTime; data.gameId = newGameId; data.channel = newChannel; data.notes = newNotes;
            data.timestamp = newDateTime.getTime(); data.status = 'pending'; data.reminded = false; data.postChecked = false; data.takenBy = null; data.dmFailed = false; data.buttonsRemoved = false;

            const payload = buildTicketPayload(docId, data);
            const newRefs = await bumpManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);

            await db.collection('reservations').doc(docId).update({ 
                date: newDate, time: newTime, gameId: newGameId, channel: newChannel, notes: newNotes,
                timestamp: newDateTime.getTime(), reminded: false, status: 'pending', takenBy: null, postChecked: false, dmFailed: false, buttonsRemoved: false, ticketMsgs: newRefs 
            });

            await interaction.followUp({ content: replyText, ephemeral: true });
            
            const dmEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⏳ 預約變更待審核中')
                .setDescription(`資料已變更，等待管理員重新審核。\n**地點**：${data.location}\n**時間**：${newDate} ${newTime}`);
            const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cancel_${docId}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger));
            await interaction.editReply({ embeds: [dmEmbed], components: [cancelRow] });

            updateBoard();
        }

    } catch (error) {
        console.error('Interaction 發生異常：', error);
        const errMsg = '❌ 系統處理時發生異常，請聯絡管理員或稍後再試。';
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: errMsg, ephemeral: true }).catch(() => {});
        } else if (interaction.isRepliable()) {
            await interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
