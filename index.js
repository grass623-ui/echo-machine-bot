require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { 
    Client, GatewayIntentBits, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionsBitField, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder 
} = require('discord.js');

// ==========================================
// 0. 授權伺服器白名單設定
// ==========================================
// ==========================================
// 0. 授權伺服器白名單設定
// ==========================================
// 將允許使用迴響機器人的「伺服器 ID」以字串填入陣列。
// 若保持空陣列 []，則代表不限制任何伺服器。
const ALLOWED_GUILDS = ['1466073297169940543', '1536011422323179631', '1536416054832799795']; 
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

// 全域記憶體快取
let allReservations = [];
let appSettings = {};

db.collection('reservations').onSnapshot(snapshot => {
    allReservations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
});
db.collection('settings').onSnapshot(snapshot => {
    snapshot.docs.forEach(doc => { appSettings[doc.id] = doc.data(); });
});

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

function isTimeFrozen(timeStr, frozenSlots) {
    if (!frozenSlots || frozenSlots.length === 0) return false;
    const [h, m] = timeStr.split(':').map(Number);
    const tMins = h * 60 + m;

    for (const slot of frozenSlots) {
        const [sh, sm] = slot.start.split(':').map(Number);
        const [eh, em] = slot.end.split(':').map(Number);
        const startMins = sh * 60 + sm;
        const endMins = eh * 60 + em;

        if (startMins <= endMins) {
            if (tMins >= startMins && tMins <= endMins) return true;
        } else {
            if (tMins >= startMins || tMins <= endMins) return true;
        }
    }
    return false;
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

async function checkIsAgent(userId, member) {
    if (member && member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    const doc = await db.collection('users').doc(userId).get();
    if (doc.exists && doc.data().isAgent === true) return true;
    return false;
}

async function broadcastToManagementAreas(payload) {
    const doc = appSettings['managementArea'];
    if (!doc) return [];
    const channels = doc.channels || [];
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

    const playerNameDisplay = data.discordName ? ` (${data.discordName})` : '';
    // 新增：顯示單號，方便管理員複製
    const baseDesc = `**單號**：\`${docId}\`\n**玩家**：<@${data.discordId}>${playerNameDisplay} (遊戲ID: ${data.gameId})\n**地點**：${data.location}\n**頻道**：${data.channel || '-'}\n**預約時間**：\`${data.date} ${data.time}\`\n**備註**：${data.notes || '無'}\n\n**📋 訂單時間線**：\n`;
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
        if (data.rejectReason) timeline += `> 📝 原因：${data.rejectReason}\n`;
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
                if (data.takenBy) { 
                    row.addComponents(new ButtonBuilder().setCustomId(`release_${docId}`).setLabel('🔄 釋出轉單').setStyle(ButtonStyle.Secondary));
                }
            } else if (data.reminded && !data.postChecked) {
                if (!data.takenBy) {
                    embed.setColor(0xFFA500).setTitle('🚨 準備出團 (等待接單)');
                    timeline += `> 🟡 鬧鐘已響，等待專員接單...\n`;
                    row.addComponents(new ButtonBuilder().setCustomId(`takeOrder_${docId}`).setLabel('✋ 我來接單').setStyle(ButtonStyle.Primary));
                } else {
                    embed.setColor(0x00FF00).setTitle('🟢 專員已接單');
                    timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
                    timeline += `> ⏳ 等待出團與結案...\n`;
                    row.addComponents(new ButtonBuilder().setCustomId(`release_${docId}`).setLabel('🔄 釋出轉單').setStyle(ButtonStyle.Secondary));
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
                            new ButtonBuilder().setCustomId(`free_${docId}`).setLabel('🎁 免單').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`fail_${docId}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                        );
                    }
                } else {
                    timeline += `> 🔴 警告：此單無人接手！\n`;
                    timeline += `> 🟡 等待任何專員幫忙補結案...\n`;
                    row.addComponents(
                        new ButtonBuilder().setCustomId(`complete_${docId}`).setLabel('⭕ 順利完成').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`free_${docId}`).setLabel('🎁 免單').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`fail_${docId}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                    );
                }
            }
        } else if (data.status === 'completed') {
            embed.setColor(0x00FF00).setTitle('⭕ 訂單已結案 (順利完成)');
            if (data.takenBy) timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
            timeline += `> ⭕ 順利完成 (確認：<@${data.closer || data.takenBy}>)\n`;
        } else if (data.status === 'free') {
            embed.setColor(0xFFD700).setTitle('🎁 訂單已結案 (免單)');
            if (data.takenBy) timeline += `> ✅ 專員接單 (專員：<@${data.takenBy}>)\n`;
            timeline += `> 🎁 免單 (確認：<@${data.closer || data.takenBy}>)\n`;
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

function generateScheduleEmbed(reservations, isAdmin = false, page = 1, isCommand = false) {
    const now = Date.now();
    const tw = getTaiwanTime();
    const todayStr = `${tw.yyyy}-${tw.mm}-${tw.dd}`;
    const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;

    const stats = {};
    reservations.forEach(r => {
        if (r.status !== 'approved' && r.status !== 'completed' && r.status !== 'free') return;
        if (!stats[r.discordId]) stats[r.discordId] = { total: 0, month: 0 };
        stats[r.discordId].total += 1;
        if (r.date.startsWith(currentMonthPrefix)) stats[r.discordId].month += 1;
    });

    let futureRes = reservations.filter(res => res.status === 'approved' && res.timestamp >= now).sort((a, b) => a.timestamp - b.timestamp);
    if (!isAdmin) futureRes = futureRes.filter(res => res.date === todayStr);

    const ITEMS_PER_PAGE = isCommand ? 8 : 30; 
    const totalItems = futureRes.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    const p = Math.max(1, Math.min(page, totalPages));

    let scheduleText = '';

    if (totalItems === 0) {
        scheduleText += isAdmin ? '目前沒有任何已通過的未來預約喔！\n\n' : '本日目前沒有已通過的預約喔！\n\n';
    } else {
        const startIdx = (p - 1) * ITEMS_PER_PAGE;
        const pageItems = futureRes.slice(startIdx, startIdx + ITEMS_PER_PAGE);
        const grouped = {};
        
        pageItems.forEach(res => {
            if (!grouped[res.date]) grouped[res.date] = [];
            grouped[res.date].push(res);
        });

        for (const [date, items] of Object.entries(grouped)) {
            scheduleText += `**📅 ${date}**\n\n`;
            items.forEach((res) => {
                const noteText = res.notes && res.notes !== '無' ? ` | 備註：${res.notes}` : '';
                let channelDisplay = '';
                let playerInfo = '';
                const playerNameDisplay = res.discordName ? ` (${res.discordName})` : '';
                
                if (isAdmin) {
                    const userStats = stats[res.discordId] || { month: 0, total: 0 };
                    channelDisplay = ` | 頻道：${res.channel || '當日決定'}`;
                    playerInfo = `ID：${res.gameId} | <@${res.discordId}>${playerNameDisplay} | 本月：${userStats.month}次 | 總：${userStats.total}次`;
                } else {
                    channelDisplay = ''; 
                    playerInfo = `👤 🔒 匿名玩家`;
                }
                scheduleText += `🕒 \`${res.time}\` ── **【${res.location}】**\n`;
                scheduleText += ` └─ ${playerInfo}${channelDisplay}${noteText}\n\n`;
            });
        }
        
        if (!isCommand && totalItems > ITEMS_PER_PAGE) {
            scheduleText += `\n⚠️ **由於篇幅限制，看板僅顯示近期 ${ITEMS_PER_PAGE} 筆預約。**\n*(管理員可使用 \`/查詢預約\` 指令進行分頁檢視)*\n\n`;
        }
    }

    if (!isCommand) {
        scheduleText += `🔄 **最後刷新時間**：\`${tw.yyyy}-${tw.mm}-${tw.dd} ${tw.hh}:${tw.min}\``;
    }

    const embed = new EmbedBuilder()
        .setColor(isAdmin ? 0xFF0000 : 0x0099FF)
        .setTitle(isAdmin ? (isCommand ? `👑【管理員】王團自動排班表 (第 ${p}/${totalPages} 頁)` : '👑【管理員】王團自動排班表') : '👤 迴響預約清單')
        .setDescription(scheduleText);
    
    return { embed, totalPages, currentPage: p };
}

async function updateBoard() {
    try {
        const reservations = allReservations;
        const boardContent = getBoardContentWithTime();

        const pubDoc = appSettings['publicBoards'] || {};
        let pubList = pubDoc.list || [];
        let validPubList = [];
        let pubChanged = false;
        
        for (let b of pubList) {
            try {
                const ch = await client.channels.fetch(b.channelId).catch(() => null);
                if (ch) {
                    const msg = await ch.messages.fetch(b.messageId).catch(() => null);
                    if (msg) {
                        const { embed } = generateScheduleEmbed(reservations, false, 1, false);
                        await msg.edit({ content: boardContent, embeds: [embed], components: [reserveBtnRow] });
                        validPubList.push(b);
                    } else {
                        const { embed } = generateScheduleEmbed(reservations, false, 1, false);
                        const newMsg = await ch.send({ content: boardContent, embeds: [embed], components: [reserveBtnRow] });
                        validPubList.push({ channelId: ch.id, messageId: newMsg.id });
                        pubChanged = true;
                    }
                } else pubChanged = true;
            } catch (e) { pubChanged = true; }
        }
        if (pubChanged || pubList.length !== validPubList.length) await db.collection('settings').doc('publicBoards').set({ list: validPubList });

        const admDoc = appSettings['adminBoards'] || {};
        let admList = admDoc.list || [];
        let validAdmList = [];
        let admChanged = false;

        for (let b of admList) {
            try {
                const ch = await client.channels.fetch(b.channelId).catch(() => null);
                if (ch) {
                    const msg = await ch.messages.fetch(b.messageId).catch(() => null);
                    const tw = getTaiwanTime();
                    if (msg) {
                        const { embed } = generateScheduleEmbed(reservations, true, 1, false);
                        await msg.edit({ content: null, embeds: [embed] });
                        validAdmList.push(b);
                    } else {
                        const { embed } = generateScheduleEmbed(reservations, true, 1, false);
                        const newMsg = await ch.send({ embeds: [embed] });
                        validAdmList.push({ channelId: ch.id, messageId: newMsg.id });
                        admChanged = true;
                    }
                } else admChanged = true;
            } catch (e) { admChanged = true; }
        }
        if (admChanged || admList.length !== validAdmList.length) await db.collection('settings').doc('adminBoards').set({ list: validAdmList });

    } catch (e) { console.log('看板更新失敗', e); }
}

async function processRejection(docId, reason, reviewerId, interaction) {
    const docRef = db.collection('reservations').doc(docId);
    let data = allReservations.find(r => r.id === docId);
    if (!data) return interaction.editReply({ content: '❌ 訂單已不存在', components: [] });
    if (data.status !== 'pending') return interaction.editReply({ content: '❌ 訂單已被處理過囉', components: [] });

    data.status = 'rejected';
    data.reviewer = reviewerId;
    data.rejectReason = reason;
    await docRef.update({ status: 'rejected', reviewer: reviewerId, rejectReason: reason });

    const payload = buildTicketPayload(docId, data);
    await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);

    const dmEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('🚫 預約未通過')
        .setDescription(`管理員退回了您的申請。\n**地點**：${data.location}\n**時間**：${data.date} ${data.time}\n**原因**：${reason}`);
    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [dmEmbed], components: [] });

    await interaction.editReply({ content: '✅ 訂單已拒絕，並已通知玩家。', components: [] });
}

client.once('ready', async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}!`);
    const commands = [
        { name: '預約', description: '開啟王團預約表單', options: [{ name: '地點', type: 3, description: '請選擇預約地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }] },
        { name: '我的紀錄', description: '查詢個人的預約統計與排單狀態' },
        { name: '接單統計', description: '查詢各專員的接單與完成數量 (管理員/專員)' },
        { name: '查詢預約', description: '分頁檢視未來的完整預約清單 (管理員)' },
        { name: '迴響機', description: '申請註冊成為專屬迴響專員 (需管理員審核)' },
        { name: '清理訊息', description: '批次清理頻道內的訊息 (管理員)', options: [{ name: '數量', type: 4, description: '要刪除的訊息數量 (1-100)', required: true }] },
        { name: '設定公開看板', description: '將此頻道加入或移除「公開看板區」' },
        { name: '設定管理看板', description: '將此頻道加入或移除「真實名單看板區」' },
        { name: '迴響管理區', description: '將此頻道加入或移除「迴響管理區」' },
        { name: '價格', description: '設定價格', options: [ { name: '地點', type: 3, description: '地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }, { name: '價格', type: 4, description: '萬', required: true } ] },
        { name: '迴響鬧鐘', description: '設定鬧鐘提前分鐘', options: [{ name: '分鐘', type: 4, description: '分鐘', required: true }] },
        { name: '優惠設定', description: '設定VIP規則', options: [ { name: '地點', type: 3, description: '地點', required: true, choices: [ { name: '闇黑龍王', value: '闇黑龍王' }, { name: '艾畢奈亞', value: '艾畢奈亞' }, { name: '道館', value: '道館' }, { name: '其他', value: '其他' } ] }, { name: '滿幾次', type: 4, description: '次數', required: true }, { name: '送幾次', type: 4, description: '次數', required: true } ] },
        { 
            name: '營運設定', description: '自動審核與凍結時段設定 (管理員)',
            options: [
                { name: '自動審核', type: 1, description: '開啟或關閉自動審核', options: [{ name: '狀態', type: 5, description: '是否開啟自動審核', required: true }] },
                { name: '新增凍結時段', type: 1, description: '新增無法預約的時間範圍 (24H制)', options: [{ name: '開始時間', type: 3, description: '例如 02:00', required: true }, { name: '結束時間', type: 3, description: '例如 10:00', required: true }] },
                { name: '清空凍結時段', type: 1, description: '清除所有已設定的凍結時段' },
                { name: '查看目前設定', type: 1, description: '查看自動審核狀態與凍結時段' }
            ]
        },
        {
            name: '玩家管理',
            description: '管理玩家的違規點數與封鎖狀態 (管理員)',
            options: [
                { name: '玩家', type: 6, description: '選擇目標玩家', required: true },
                { name: '動作', type: 3, description: '執行的動作', required: true, choices: [
                    { name: '解除封鎖 (解Ban)', value: 'unban' },
                    { name: '清除違規點數 (歸零)', value: 'clear_points' },
                    { name: '增加違規點數 (+1)', value: 'add_point' },
                    { name: '扣除違規點數 (-1)', value: 'remove_point' }
                ]}
            ]
        },
        {
            name: '刪除訂單',
            description: '列出近期歷史訂單以供刪除 (管理員)',
            options: [
                { name: '玩家', type: 6, description: '選擇玩家以縮小搜尋範圍 (選填)', required: false },
                { name: '訂單id', type: 3, description: '直接輸入訂單 ID 進行單獨刪除 (選填)', required: false }
            ]
        }
    ];
    await client.application.commands.set(commands);

    setInterval(async () => {
        const now = Date.now();
        try {
            const prices = appSettings['prices'] || {};
            const alarmLeadTime = appSettings['alarm']?.leadTime || 15;
            const vipRules = appSettings['vipRules'] || {};
            
            for (let data of allReservations) {
                const timeDiff = data.timestamp - now;
                let needsSync = false;
                let needsBump = false;
                const displayChannel = data.channel ? data.channel : '-'; 

                if (data.status === 'pending' && data.timestamp < now) {
                    await db.collection('reservations').doc(data.id).update({ status: 'expired' });
                    needsSync = true;
                    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [new EmbedBuilder().setColor(0x808080).setTitle('⏳ 預約已過期失效').setDescription(`您的預約因超過開打時間未審核，已自動失效。\n**地點**：${data.location}\n**時間**：${data.date} ${data.time}`)], components: [] });
                }

                if (data.status === 'approved' && !data.reminded && timeDiff <= alarmLeadTime * 60 * 1000 && timeDiff > 0) {
                    await db.collection('reservations').doc(data.id).update({ reminded: true });
                    needsBump = true; 

                    let finalPriceStr = `${prices[data.location] || '未設定'}萬`;
                    const rule = vipRules[data.location];
                    if (rule && rule.buy > 0) {
                        const userHistory = allReservations.filter(r => r.discordId === data.discordId && r.location === data.location && (r.status === 'approved' || r.status === 'completed' || r.status === 'free')).sort((a, b) => a.timestamp - b.timestamp);
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

                if (data.status === 'approved' && !data.buttonsRemoved && now >= data.timestamp) {
                    await editUserDM(data.discordId, data.userDmMsgId, { components: [] });
                    await db.collection('reservations').doc(data.id).update({ buttonsRemoved: true });
                }

                if (data.status === 'approved' && data.reminded && !data.postChecked && now - data.timestamp >= 10 * 60 * 1000) {
                    let dmFailed = false;
                    if (data.takenBy) {
                        try {
                            const adminUser = await client.users.fetch(data.takenBy);
                            const row = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`complete_${data.id}`).setLabel('⭕ 順利完成').setStyle(ButtonStyle.Success),
                                new ButtonBuilder().setCustomId(`free_${data.id}`).setLabel('🎁 免單').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`fail_${data.id}`).setLabel('❌ 未完成/取消').setStyle(ButtonStyle.Danger)
                            );
                            await adminUser.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle('⏱️ 訂單結案確認').setDescription(`**玩家**：<@${data.discordId}>\n**地點**：${data.location}\n**頻道**：${displayChannel}\n**預約時間**：\`${data.date} ${data.time}\`\n\n*請問順利完成了嗎？*`)], components: [row] });
                        } catch (e) { dmFailed = true; }
                    }
                    await db.collection('reservations').doc(data.id).update({ postChecked: true, dmFailed });
                    needsBump = true;
                    data.postChecked = true; data.dmFailed = dmFailed;
                }

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

client.on('interactionCreate', async interaction => {
    try {
        // ==========================================
        // 伺服器白名單檢查
        // ==========================================
        if (interaction.guildId && ALLOWED_GUILDS.length > 0 && !ALLOWED_GUILDS.includes(interaction.guildId)) {
            if (interaction.isRepliable()) {
                return interaction.reply({ content: '❌ 此伺服器尚未開通迴響機器人服務。', ephemeral: true }).catch(() => {});
            }
            return;
        }

        if (interaction.isChatInputCommand()) {
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

            await interaction.deferReply({ ephemeral: true });

            if (interaction.commandName === '迴響機') {
                const userRef = db.collection('users').doc(interaction.user.id);
                const userDoc = await userRef.get();
                let ud = userDoc.exists ? userDoc.data() : { violationPoints: 0, bannedUntil: null };
                
                if (ud.isAgent) {
                    return interaction.editReply('✅ 您已經是認證的迴響專員囉！可以開始接單服務了。');
                }
                if (ud.agentStatus === 'pending') {
                    return interaction.editReply('⏳ 您的專員申請正在審核中，請耐心等候管理員通知！');
                }

                ud.agentStatus = 'pending';
                await userRef.set(ud, { merge: true });

                const payload = {
                    embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle('📝 新專員認證申請')
                        .setDescription(`玩家 <@${interaction.user.id}> 申請註冊成為 **迴響專員**！\n請審核是否賦予接單權限：`)],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`approveAgent_${interaction.user.id}`).setLabel('✅ 通過認證').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`rejectAgent_${interaction.user.id}`).setLabel('❌ 拒絕申請').setStyle(ButtonStyle.Danger)
                    )]
                };
                await broadcastToManagementAreas(payload);
                return interaction.editReply('✅ **申請已送出！** 請等待管理員進行審核，審核結果將會私訊通知您。');
            }
            else if (interaction.commandName === '刪除訂單') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                
                const targetUser = interaction.options.getUser('玩家');
                const targetId = interaction.options.getString('訂單id');

                // 模式一：直接刪除 ID
                if (targetId) {
                    const docId = targetId.trim();
                    const targetOrder = allReservations.find(r => r.id === docId);
                    
                    if (!targetOrder) return interaction.editReply({ content: `❌ 找不到 ID 為 \`${docId}\` 的訂單。` });

                    await db.collection('reservations').doc(docId).delete();
                    if (targetOrder.ticketMsgs) {
                        for (const m of targetOrder.ticketMsgs) {
                            try {
                                const ch = await client.channels.fetch(m.channelId).catch(() => null);
                                if (ch) {
                                    const msg = await ch.messages.fetch(m.messageId).catch(() => null);
                                    if (msg) await msg.delete().catch(() => null);
                                }
                            } catch (e) {}
                        }
                    }
                    setTimeout(() => { updateBoard(); }, 1500); 
                    return interaction.editReply({ content: `✅ 已成功從資料庫徹底刪除訂單 \`${docId}\`！` });
                }

                // 模式二：拉出近期清單供選擇
                let userOrders = [];
                let displayMsg = '';
                
                if (targetUser) {
                    userOrders = allReservations
                        .filter(r => r.discordId === targetUser.id)
                        .sort((a, b) => b.timestamp - a.timestamp)
                        .slice(0, 25);
                    displayMsg = `🗑️ **刪除訂單系統**\n請在下方選擇要刪除 <@${targetUser.id}> 的歷史訂單：`;
                } else {
                    userOrders = allReservations
                        .sort((a, b) => b.timestamp - a.timestamp)
                        .slice(0, 25);
                    displayMsg = `🗑️ **刪除訂單系統 (近期所有紀錄)**\n請在下方選擇要刪除的歷史訂單：`;
                }

                if (userOrders.length === 0) return interaction.editReply({ content: `❌ 目前沒有找到任何訂單紀錄。` });

                const options = userOrders.map(o => {
                    let statusTw = '其他';
                    if (o.status === 'approved') statusTw = '排程中';
                    if (o.status === 'completed') statusTw = '完成';
                    if (o.status === 'free') statusTw = '免單';
                    if (o.status === 'failed') statusTw = '失敗';
                    if (o.status === 'canceled') statusTw = '取消';
                    if (o.status === 'pending') statusTw = '待審核';
                    if (o.status === 'rejected') statusTw = '已拒絕';
                    if (o.status === 'expired') statusTw = '過期';

                    const pName = o.discordName ? o.discordName.substring(0, 6) : '未知';
                    return {
                        label: `[${o.date}] ${o.location} - 玩家:${pName}`,
                        description: `狀態: ${statusTw} | ID: ${o.id}`,
                        value: o.id
                    };
                });

                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('select_delete_order')
                        .setPlaceholder('請選擇要從資料庫徹底刪除的訂單')
                        .addOptions(options)
                );
                return interaction.editReply({ content: `${displayMsg}\n*(注意：刪除後將無法恢復，並會自動修正報表統計)*`, components: [row] });
            }
            else if (interaction.commandName === '玩家管理') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const targetUser = interaction.options.getUser('玩家');
                const action = interaction.options.getString('動作');
                
                const userRef = db.collection('users').doc(targetUser.id);
                const userDoc = await userRef.get();
                let ud = userDoc.exists ? userDoc.data() : { violationPoints: 0, bannedUntil: null };

                if (action === 'unban') {
                    ud.bannedUntil = null;
                    await userRef.set(ud, { merge: true });
                    return interaction.editReply(`✅ 已成功解除 <@${targetUser.id}> 的預約封鎖狀態！`);
                } else if (action === 'clear_points') {
                    ud.violationPoints = 0;
                    await userRef.set(ud, { merge: true });
                    return interaction.editReply(`✅ 已將 <@${targetUser.id}> 的違規點數清空歸零。`);
                } else if (action === 'add_point') {
                    ud.violationPoints = (ud.violationPoints || 0) + 1;
                    if (ud.violationPoints >= 3) {
                        ud.bannedUntil = Date.now() + 7 * 24 * 60 * 60 * 1000;
                        ud.violationPoints = 0;
                        await userRef.set(ud, { merge: true });
                        return interaction.editReply(`✅ 已增加 <@${targetUser.id}> 的違規點數。目前達 3 點，已自動觸發封鎖 7 天！`);
                    }
                    await userRef.set(ud, { merge: true });
                    return interaction.editReply(`✅ 已增加 <@${targetUser.id}> 的違規點數。目前累積：${ud.violationPoints} / 3 點。`);
                } else if (action === 'remove_point') {
                    ud.violationPoints = Math.max(0, (ud.violationPoints || 0) - 1);
                    await userRef.set(ud, { merge: true });
                    return interaction.editReply(`✅ 已扣除 <@${targetUser.id}> 的違規點數。目前累積：${ud.violationPoints} / 3 點。`);
                }
            }
            else if (interaction.commandName === '查詢預約') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const { embed, totalPages, currentPage } = generateScheduleEmbed(allReservations, true, 1, true);
                
                const navRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('page_nav_prev_1').setLabel('◀ 上一頁').setStyle(ButtonStyle.Secondary).setDisabled(true),
                    new ButtonBuilder().setCustomId('page_nav_next_2').setLabel('下一頁 ▶').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1)
                );
                return interaction.editReply({ embeds: [embed], components: [navRow] });
            }
            else if (interaction.commandName === '營運設定') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const sub = interaction.options.getSubcommand();
                const docRef = db.collection('settings').doc('operationMode');
                let opData = appSettings['operationMode'] || { autoApprove: false, frozenSlots: [] };

                if (sub === '自動審核') {
                    const state = interaction.options.getBoolean('狀態');
                    opData.autoApprove = state;
                    await docRef.set(opData, { merge: true });
                    return interaction.editReply(`✅ 已將「自動審核」狀態設定為：**${state ? '🟢 開啟 (系統自動接單)' : '🔴 關閉 (維持人工審核)'}**`);
                } else if (sub === '新增凍結時段') {
                    const start = interaction.options.getString('開始時間');
                    const end = interaction.options.getString('結束時間');
                    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
                        return interaction.editReply('❌ 格式錯誤，請輸入例如 `02:00` 的格式喔！');
                    }
                    if (!opData.frozenSlots) opData.frozenSlots = [];
                    opData.frozenSlots.push({ start, end });
                    await docRef.set(opData, { merge: true });
                    return interaction.editReply(`✅ 已新增凍結時段：\`${start}\` 到 \`${end}\` 期間將自動阻擋預約。`);
                } else if (sub === '清空凍結時段') {
                    opData.frozenSlots = [];
                    await docRef.set(opData, { merge: true });
                    return interaction.editReply(`✅ 已清空所有凍結時段，全時段皆可預約。`);
                } else if (sub === '查看目前設定') {
                    let desc = `**自動審核狀態**：${opData.autoApprove ? '🟢 開啟 (系統自動接單)' : '🔴 關閉 (維持人工審核)'}\n\n**目前凍結時段**：\n`;
                    if (opData.frozenSlots && opData.frozenSlots.length > 0) {
                        opData.frozenSlots.forEach(s => desc += `> 🛑 \`${s.start}\` ~ \`${s.end}\`\n`);
                    } else {
                        desc += '> 無凍結時段';
                    }
                    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x0099FF).setTitle('⚙️ 營運模式設定').setDescription(desc)] });
                }
            }
            else if (interaction.commandName === '清理訊息') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                const amount = interaction.options.getInteger('數量');
                try {
                    await interaction.channel.bulkDelete(amount, true);
                    return interaction.editReply({ content: `✅ 成功清理了 ${amount} 則訊息！` });
                } catch (e) {
                    return interaction.editReply({ content: `❌ 清理失敗，可能包含超過 14 天的舊訊息。` });
                }
            }
            else if (interaction.commandName === '迴響管理區') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                let channels = appSettings['managementArea']?.channels || [];
                if (channels.includes(interaction.channelId)) {
                    channels = channels.filter(id => id !== interaction.channelId);
                    await db.collection('settings').doc('managementArea').set({ channels });
                    return interaction.editReply({ content: '✅ 已移除迴響管理區。' });
                } else {
                    channels.push(interaction.channelId);
                    await db.collection('settings').doc('managementArea').set({ channels });
                    return interaction.editReply({ content: '✅ **設定成功！**' });
                }
            }
            else if (interaction.commandName === '設定公開看板') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                let list = appSettings['publicBoards']?.list || [];
                const existingIdx = list.findIndex(b => b.channelId === interaction.channelId);
                if (existingIdx !== -1) {
                    list.splice(existingIdx, 1);
                    await db.collection('settings').doc('publicBoards').set({ list });
                    return interaction.editReply({ content: '✅ 已移除公開看板。' });
                } else {
                    const msg = await interaction.channel.send({ content: getBoardContentWithTime(), embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0x0099FF)], components: [reserveBtnRow] });
                    list.push({ channelId: interaction.channelId, messageId: msg.id });
                    await db.collection('settings').doc('publicBoards').set({ list });
                    await interaction.editReply({ content: '✅ 公開看板設定成功！' });
                    updateBoard();
                }
            }
            else if (interaction.commandName === '設定管理看板') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.editReply({ content: '❌ 權限不足' });
                let list = appSettings['adminBoards']?.list || [];
                const existingIdx = list.findIndex(b => b.channelId === interaction.channelId);
                if (existingIdx !== -1) {
                    list.splice(existingIdx, 1);
                    await db.collection('settings').doc('adminBoards').set({ list });
                    return interaction.editReply({ content: '✅ 已移除真實名單看板。' });
                } else {
                    const tw = getTaiwanTime();
                    const msg = await interaction.channel.send({ content: `🔄 **最後刷新時間**：\`${tw.yyyy}-${tw.mm}-${tw.dd} ${tw.hh}:${tw.min}\``, embeds: [new EmbedBuilder().setTitle('載入中...').setColor(0xFF0000)] });
                    list.push({ channelId: interaction.channelId, messageId: msg.id });
                    await db.collection('settings').doc('adminBoards').set({ list });
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
                const tw = getTaiwanTime();
                const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;
                let total = 0, month = 0;
                allReservations.forEach(d => { 
                    if (d.discordId === interaction.user.id && (d.status === 'approved' || d.status === 'completed' || d.status === 'free')) {
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
                        banStatus = `🔴 預約休息中 (解除：${bDate.getUTCFullYear()}-${String(bDate.getUTCMonth()+1).padStart(2,'0')}-${String(bDate.getUTCDate()).padStart(2,'0')} ${String(bDate.getUTCHours()).padStart(2,'0')}:${String(bDate.getUTCMinutes()).padStart(2,'0')})`;
                    }
                }
                const statEmbed = new EmbedBuilder().setColor(0x9B59B6).setTitle(`📊 ${interaction.user.username} 的預約數據`)
                    .addFields({ name: '本月排單', value: `${month} 次`, inline: true }, { name: '歷史總單', value: `${total} 次`, inline: true }, { name: '臨時調整', value: `${points} / 3 次`, inline: false }, { name: '帳號狀態', value: banStatus, inline: false });
                await interaction.editReply({ embeds: [statEmbed] });
            }
            else if (interaction.commandName === '接單統計') {
                const isAuthorized = await checkIsAgent(interaction.user.id, interaction.member);
                if (!isAuthorized) return interaction.editReply({ content: '❌ 權限不足，僅限管理員或專員查詢喔！' });

                const tw = getTaiwanTime();
                const currentMonthPrefix = `${tw.yyyy}-${tw.mm}`;
                const stats = {};
                allReservations.forEach(r => {
                    if (r.takenBy && (r.status === 'completed' || r.status === 'failed' || r.status === 'free')) {
                        if (!stats[r.takenBy]) stats[r.takenBy] = { total: 0, month: 0, totalFree: 0, monthFree: 0, failed: 0 };
                        if (r.status === 'completed') { 
                            stats[r.takenBy].total += 1; 
                            if (r.date.startsWith(currentMonthPrefix)) stats[r.takenBy].month += 1; 
                        } 
                        else if (r.status === 'free') {
                            stats[r.takenBy].totalFree += 1;
                            if (r.date.startsWith(currentMonthPrefix)) stats[r.takenBy].monthFree += 1; 
                        }
                        else if (r.status === 'failed') { 
                            stats[r.takenBy].failed += 1; 
                        }
                    }
                });
                if (Object.keys(stats).length === 0) return interaction.editReply({ content: '目前無專員結案紀錄喔！' });
                let desc = '';
                for (const [userId, s] of Object.entries(stats)) { 
                    desc += `**專員**：<@${userId}>\n> 本月完成：\`${s.month}\` 次 (總計 \`${s.total}\`)\n> 本月免單招待：\`${s.monthFree}\` 次 (總計 \`${s.totalFree}\`)\n> 失敗/取消數：\`${s.failed}\` 次\n\n`; 
                }
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('📊 迴響專員接單績效').setDescription(desc)] });
            }
        }

        else if (interaction.isButton() && interaction.customId.startsWith('page_nav_')) {
            await interaction.deferUpdate();
            const targetPage = parseInt(interaction.customId.split('_')[3]);
            const { embed, totalPages, currentPage } = generateScheduleEmbed(allReservations, true, targetPage, true);
            
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`page_nav_prev_${currentPage - 1}`).setLabel('◀ 上一頁').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
                new ButtonBuilder().setCustomId(`page_nav_next_${currentPage + 1}`).setLabel('下一頁 ▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages)
            );
            await interaction.editReply({ embeds: [embed], components: [navRow] });
        }

        else if (interaction.isButton() && interaction.customId === 'btn_reserve') {
            const userDoc = await db.collection('users').doc(interaction.user.id).get();
            if (userDoc.exists && userDoc.data().bannedUntil > Date.now()) {
                return interaction.reply({ content: `💡 **溫馨提醒**：您近期「臨時調整」達上限，權限暫停中喔！`, ephemeral: true });
            }
            
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('select_location').setPlaceholder('請選擇要預約的地點')
                .addOptions([ { label: '闇黑龍王', value: '闇黑龍王' }, { label: '艾畢奈亞', value: '艾畢奈亞' }, { label: '道館', value: '道館' }, { label: '其他', value: '其他' } ])
            );
            await interaction.reply({ content: '👇 **請選擇您要預約的地點：**', components: [row], ephemeral: true });
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

        else if (interaction.isStringSelectMenu() && interaction.customId === 'select_delete_order') {
            await interaction.deferUpdate();
            const docId = interaction.values[0];
            const targetOrder = allReservations.find(r => r.id === docId);
            
            await db.collection('reservations').doc(docId).delete();
            
            if (targetOrder && targetOrder.ticketMsgs) {
                for (const m of targetOrder.ticketMsgs) {
                    try {
                        const ch = await client.channels.fetch(m.channelId).catch(() => null);
                        if (ch) {
                            const msg = await ch.messages.fetch(m.messageId).catch(() => null);
                            if (msg) await msg.delete().catch(() => null);
                        }
                    } catch (e) {}
                }
            }
            
            setTimeout(() => { updateBoard(); }, 1500); 
            return interaction.editReply({ content: `✅ 已成功從資料庫徹底刪除該筆訂單紀錄！`, components: [] });
        }

        else if (interaction.isModalSubmit() && interaction.customId.startsWith('reserve_')) {
            await interaction.deferReply({ ephemeral: true });
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

            const isConflict = allReservations.some(res => res.location === location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000 && res.status === 'approved');
            if (isConflict) return interaction.editReply({ content: '❌ 此時段前後10分鐘已有排單，請重新調整喔。' });

            const opMode = appSettings['operationMode'] || {};
            const frozenSlots = opMode.frozenSlots || [];
            const autoApprove = opMode.autoApprove || false;

            if (isTimeFrozen(time, frozenSlots)) {
                return interaction.editReply({ content: `❌ **系統凍結時段**：此時段（${time}）暫不開放預約，請選擇其他時間喔！` });
            }

            const data = {
                discordId: interaction.user.id, 
                discordName: interaction.user.displayName || interaction.user.username,
                gameId, date, time, location, channel, notes,
                timestamp: newDateTime.getTime(), reminded: false, takenBy: null, postChecked: false, userDmMsgId: null, buttonsRemoved: false,
                status: autoApprove ? 'approved' : 'pending',
                reviewer: autoApprove ? '系統自動' : null
            };
            const docRef = await db.collection('reservations').add(data);
            data.id = docRef.id;

            const payload = buildTicketPayload(docRef.id, data);
            const sentMsgs = await broadcastToManagementAreas(payload);
            await docRef.update({ ticketMsgs: sentMsgs });

            const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cancel_${docRef.id}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger));
            
            if (autoApprove) {
                const btnRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`edit_${docRef.id}`).setLabel('✏️ 變更登記資料').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`cancel_${docRef.id}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger)
                );
                const dmEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ 預約已自動通過').setDescription(`系統已自動審核通過您的訂單，並排入班表！\n**地點**：${location}\n**時間**：${date} ${time}`);
                try {
                    const dmMsg = await interaction.user.send({ embeds: [dmEmbed], components: [btnRow] });
                    await docRef.update({ userDmMsgId: dmMsg.id });
                    await interaction.editReply({ content: `✅ **預約成功！** 系統已自動審核通過，請查看 DM 確認。` });
                } catch (error) {
                    await interaction.editReply({ content: `✅ 預約成功！系統已自動通過。\n⚠️ **請開啟接收私訊功能！**` });
                }
                updateBoard();
            } else {
                const dmEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⏳ 預約等待審核中').setDescription(`您的訂單已送出，等待管理員審核通過後才會加入排班表喔！\n**地點**：${location}\n**時間**：${date} ${time}`);
                try {
                    const dmMsg = await interaction.user.send({ embeds: [dmEmbed], components: [cancelRow] });
                    await docRef.update({ userDmMsgId: dmMsg.id });
                    await interaction.editReply({ content: `✅ 預約已送出！請查看 DM 等待審核結果。` });
                } catch (error) {
                    await interaction.editReply({ content: `✅ 預約已送出，正在等待審核。\n⚠️ **請開啟接收私訊功能！**` });
                }
            }
        }

        else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('rejectReason_')) {
            const docId = interaction.customId.split('_')[1];
            const reason = interaction.values[0];

            if (reason === 'custom') {
                const modal = new ModalBuilder().setCustomId(`submitReject_${docId}`).setTitle('輸入自訂拒絕原因');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel("拒絕原因").setStyle(TextInputStyle.Paragraph).setRequired(true))
                );
                return interaction.showModal(modal);
            }

            await interaction.deferUpdate();
            await processRejection(docId, reason, interaction.user.id, interaction);
        }

        else if (interaction.isButton()) {
            const [action, docId] = interaction.customId.split('_');

            if (action === 'approveAgent') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
                await db.collection('users').doc(docId).set({ isAgent: true, agentStatus: 'approved' }, { merge: true });
                await interaction.message.edit({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('✅ 專員申請已通過').setDescription(`<@${docId}> 已正式成為認證專員 (審核者：<@${interaction.user.id}>)`)], components: [] });
                try {
                    const targetUser = await client.users.fetch(docId);
                    await targetUser.send('🎉 **恭喜！管理員已通過您的申請，您現在正式成為【迴響專員】囉！**\n您可以開始至頻道接單了！');
                } catch(e) {}
                return interaction.reply({ content: '✅ 審核完成。', ephemeral: true });
            }

            if (action === 'rejectAgent') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ 權限不足', ephemeral: true });
                await db.collection('users').doc(docId).set({ isAgent: false, agentStatus: 'rejected' }, { merge: true });
                await interaction.message.edit({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 專員申請已拒絕').setDescription(`<@${docId}> 的申請已被拒絕 (審核者：<@${interaction.user.id}>)`)], components: [] });
                try {
                    const targetUser = await client.users.fetch(docId);
                    await targetUser.send('🚫 **抱歉，管理員退回了您的【迴響專員】申請。**');
                } catch(e) {}
                return interaction.reply({ content: '✅ 已拒絕。', ephemeral: true });
            }

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

            if (action === 'reject') {
                let data = allReservations.find(r => r.id === docId);
                if (!data || data.status !== 'pending') return interaction.reply({ content: '❌ 訂單已不存在或被處理過囉！', ephemeral: true });
                
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId(`rejectReason_${docId}`).setPlaceholder('請選擇拒絕這筆訂單的原因')
                    .addOptions([
                        { label: '時段衝突 (該時段已有安排)', value: '時段衝突，該時段已有其他安排' },
                        { label: '專員人力不足', value: '該時段專員人力不足' },
                        { label: '遊戲維護/連線不穩', value: '遊戲維護或伺服器連線不穩' },
                        { label: '✍️ 自訂其他原因...', value: 'custom' }
                    ])
                );
                return interaction.reply({ content: '請選擇拒絕這筆訂單的原因：', components: [row], ephemeral: true });
            }

            await interaction.deferUpdate();

            const docRef = db.collection('reservations').doc(docId);

            if (action === 'takeOrder') {
                const isAuthorized = await checkIsAgent(interaction.user.id, interaction.member);
                if (!isAuthorized) {
                    return interaction.followUp({ content: '❌ **權限不足！** 您尚未註冊成為「迴響專員」，請先使用 `/迴響機` 送出申請並等待審核。', ephemeral: true });
                }

                try {
                    await db.runTransaction(async (t) => {
                        const doc = await t.get(docRef);
                        if (!doc.exists) throw new Error('NOT_FOUND');
                        const data = doc.data();
                        if (data.takenBy) throw new Error('TAKEN'); 
                        
                        t.update(docRef, { takenBy: interaction.user.id });
                    });
                    
                    const latestDoc = await docRef.get();
                    const data = { id: latestDoc.id, ...latestDoc.data() };
                    const payload = buildTicketPayload(docId, data);
                    await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                    return interaction.followUp({ content: '✅ 成功接單！', ephemeral: true });
                    
                } catch (error) {
                    if (error.message === 'TAKEN') {
                        return interaction.followUp({ content: '❌ 慢了一步，已經被其他人接走囉！', ephemeral: true });
                    }
                    return interaction.followUp({ content: '❌ 找不到訂單或發生錯誤。', ephemeral: true });
                }
            }

            const doc = await docRef.get();
            if (!doc.exists) return interaction.followUp({ content: '❌ 找不到此訂單（可能已被刪除）。', ephemeral: true });
            let data = doc.data();
            data.id = doc.id;

            if (action === 'approve') {
                if (data.status !== 'pending') return interaction.followUp({ content: '❌ 訂單已處理過囉！', ephemeral: true });
                data.status = 'approved';
                data.reviewer = interaction.user.id;
                await docRef.update({ status: data.status, reviewer: data.reviewer });
                
                const payload = buildTicketPayload(docId, data);
                await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                
                const dmEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ 預約已通過').setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}`);
                const btnRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`edit_${docId}`).setLabel('✏️ 變更登記資料').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`cancel_${docId}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger)
                );
                await editUserDM(data.discordId, data.userDmMsgId, { embeds: [dmEmbed], components: [btnRow] });
                updateBoard();
                return;
            }

            if (action === 'release') {
                if (data.takenBy !== interaction.user.id) {
                    return interaction.followUp({ content: '❌ 只有目前的接單專員可以釋出此訂單！', ephemeral: true });
                }
                data.takenBy = null;
                await docRef.update({ takenBy: null });
                
                const payload = buildTicketPayload(docId, data);
                const newRefs = await bumpManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                await docRef.update({ ticketMsgs: newRefs });
                return interaction.followUp({ content: '✅ 已成功釋出訂單，等待其他專員接手。', ephemeral: true });
            }

            if (action === 'complete' || action === 'fail' || action === 'free') {
                if (data.status === 'completed' || data.status === 'failed' || data.status === 'free') {
                    return interaction.followUp({ content: '❌ 已經結案過了！', ephemeral: true });
                }
                if (data.takenBy && data.takenBy !== interaction.user.id) {
                    return interaction.followUp({ content: `❌ 只有專員 <@${data.takenBy}> 才能確認結案！`, ephemeral: true });
                }

                if (action === 'complete') data.status = 'completed';
                else if (action === 'free') data.status = 'free';
                else data.status = 'failed';

                data.closer = interaction.user.id;
                if (!data.takenBy) data.takenBy = interaction.user.id;

                await docRef.update({ status: data.status, closer: data.closer, takenBy: data.takenBy });
                
                const payload = buildTicketPayload(docId, data);
                await syncManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);
                try { await interaction.editReply({ components: [] }); } catch(e){}

                if (action === 'complete') {
                    const blessingEmbed = new EmbedBuilder().setColor(0xFFD700).setTitle('🎊 【訂單圓滿完成】')
                        .setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}\n\n感謝您的惠顧！\n祝您這趟王團 **寶物大豐收、掉寶順利** 🍀\n期待下次再為您服務喔～`);
                    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [blessingEmbed], components: [] });
                } else if (action === 'free') {
                    const freeEmbed = new EmbedBuilder().setColor(0xFFD700).setTitle('🎁 【專員招待！本次免單】')
                        .setDescription(`**地點**：${data.location}\n**時間**：${data.date} ${data.time}\n\n專員為您標記了本次服務為 **免單招待**！🎉\n祝您武運昌隆，期待下次再見！`);
                    await editUserDM(data.discordId, data.userDmMsgId, { embeds: [freeEmbed], components: [] });
                }

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

        else if (interaction.isModalSubmit() && interaction.customId.startsWith('submitReject_')) {
            await interaction.deferUpdate();
            const docId = interaction.customId.split('_')[1];
            const reason = interaction.fields.getTextInputValue('reason');
            await processRejection(docId, reason, interaction.user.id, interaction);
        }
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

            const opMode = appSettings['operationMode'] || {};
            const frozenSlots = opMode.frozenSlots || [];
            const autoApprove = opMode.autoApprove || false;

            if (isTimeFrozen(newTime, frozenSlots)) {
                return interaction.followUp({ content: `❌ **系統凍結時段**：此時段（${newTime}）暫不開放預約，請選擇其他時間喔！`, ephemeral: true });
            }

            const currentDoc = await db.collection('reservations').doc(docId).get();
            if (!currentDoc.exists) return interaction.followUp({ content: '❌ 找不到此訂單。', ephemeral: true });
            let data = currentDoc.data();
            const timeChanged = data.timestamp !== newDateTime.getTime();

            if (timeChanged) {
                const isConflict = allReservations.some(res => res.id !== docId && res.location === data.location && Math.abs(newDateTime.getTime() - res.timestamp) < 10 * 60 * 1000 && res.status === 'approved');
                if (isConflict) return interaction.followUp({ content: '❌ 申請時間前後10分鐘已排單。', ephemeral: true });
            }

            const isLastMinute = (data.timestamp - Date.now()) <= 30 * 60 * 1000;
            let replyText = autoApprove ? `✅ **資料已更新，系統已自動審核通過。**` : `✅ **資料已更新，並已推進置底等待審核。**`;
            
            if (timeChanged && isLastMinute && data.status === 'approved') {
                const { points, bannedUntil } = await addViolation(interaction.user.id);
                if (bannedUntil) replyText += `\n💡 **系統通知**：因近期臨時調整達上限，暫停預約權限 7 天。`;
                else replyText += `\n💡 **溫馨小提醒**：距離原本開打不到 30 分鐘更改時間，已記錄一次臨時調整（目前：${points}/3）。`;
            }

            data.discordName = interaction.user.displayName || interaction.user.username;
            data.date = newDate; data.time = newTime; data.gameId = newGameId; data.channel = newChannel; data.notes = newNotes;
            data.timestamp = newDateTime.getTime(); 
            data.status = autoApprove ? 'approved' : 'pending'; 
            data.reviewer = autoApprove ? '系統自動' : null;
            data.reminded = false; data.postChecked = false; data.takenBy = null; data.dmFailed = false; data.buttonsRemoved = false;

            const payload = buildTicketPayload(docId, data);
            const newRefs = await bumpManagementMessages(data.ticketMsgs, payload.embeds[0], payload.components);

            await db.collection('reservations').doc(docId).update({ 
                discordName: data.discordName,
                date: newDate, time: newTime, gameId: newGameId, channel: newChannel, notes: newNotes,
                timestamp: newDateTime.getTime(), reminded: false, status: data.status, reviewer: data.reviewer, takenBy: null, postChecked: false, dmFailed: false, buttonsRemoved: false, ticketMsgs: newRefs 
            });

            await interaction.followUp({ content: replyText, ephemeral: true });
            
            const dmEmbed = new EmbedBuilder().setColor(autoApprove ? 0x00FF00 : 0xFFA500).setTitle(autoApprove ? '✅ 預約已自動通過' : '⏳ 預約變更待審核中')
                .setDescription(autoApprove ? `系統已自動審核通過！\n**地點**：${data.location}\n**時間**：${newDate} ${newTime}` : `資料已變更，等待管理員重新審核。\n**地點**：${data.location}\n**時間**：${newDate} ${newTime}`);
            const btnRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`edit_${docId}`).setLabel('✏️ 變更登記資料').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`cancel_${docId}`).setLabel('🗑️ 取消預約').setStyle(ButtonStyle.Danger)
            );
            await interaction.editReply({ embeds: [dmEmbed], components: [btnRow] });

            updateBoard();
        }

    } catch (error) {
        console.error('Interaction 發生異常：', error);
        const errMsg = '❌ 系統處理時發生異常，請重試。';
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: errMsg, ephemeral: true }).catch(() => {});
        } else if (interaction.isRepliable()) {
            await interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
