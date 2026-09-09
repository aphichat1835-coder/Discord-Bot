"use strict";

const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { st } = require("./state");
const { sanitizeLogText } = require("../core/safeLogger");
const { getSessionShortId, isSessionRunnable } = require("./session");
const dmService = require("../dm");

const MOVE_DEBOUNCE_MS = 3 * 60 * 1000; // 3 minutes trailing debounce

const moveTracking = new Map();

function formatTime(timestamp) {
    try {
        return new Date(timestamp).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok" });
    } catch {
        return new Date(timestamp).toLocaleTimeString();
    }
}

async function sendMoveNotification(sessionId, deps = {}) {
    const record = moveTracking.get(sessionId);
    if (!record) return null;

    moveTracking.delete(sessionId);

    if (!record.ownerId || st.isShuttingDown) return null;

    const { buildDmEmbed, markdownText, code } = dmService.design;
    const send = deps.sendDm || dmService.send.bind(dmService);

    const firstTime = formatTime(record.firstMovedAt);
    const lastTime = formatTime(record.lastMovedAt);
    const timeRange = record.firstMovedAt === record.lastMovedAt
        ? firstTime
        : `ตั้งแต่ ${firstTime} ถึง ${lastTime}`;

    const fields = [
        { name: "🏠 เซิร์ฟเวอร์", value: `**${markdownText(record.guildName)}**\n${code(record.guildId)}`, inline: true },
        { name: "🔊 ห้องเป้าหมาย", value: `**${markdownText(record.targetChannelName)}**\n${code(record.targetChannelId)}`, inline: true },
        { name: "📍 ห้องที่โดนลากไป (ล่าสุด)", value: `**${markdownText(record.lastMovedToChannelName)}**\n${code(record.lastMovedToChannelId)}`, inline: true },
        { name: "🔁 จำนวนครั้งที่โดนลาก", value: `**${record.moveCount}** ครั้ง`, inline: true },
        { name: "⏱️ เวลาที่เกิดเหตุ", value: timeRange, inline: true },
        { name: "🧩 รหัสการออน", value: code(getSessionShortId(sessionId)), inline: true }
    ];

    const embed = buildDmEmbed({
        tone: "warning",
        title: "🧲 แจ้งเตือน: ตรวจพบการย้ายห้องเสียง (ดึงกลับแล้ว)",
        summary: "ตรวจพบว่ามีคนย้ายบัญชีออกจากห้องเสียงเป้าหมาย และระบบได้ดึงกลับห้องเดิมเรียบร้อยแล้ว ขณะนี้สถานการณ์ในห้องเสียงกลับมานิ่งเกิน 3 นาทีแล้ว",
        profile: {
            id: record.accountId,
            displayName: record.accountName,
            username: record.accountName,
            avatarUrl: record.accountAvatar
        },
        fields,
        details: "ระบบทำการล็อกตำแหน่งและบินกลับห้องเป้าหมายเดิมทันทีทุกครั้ง และหน่วงเวลาส่งสรุป 3 นาทีหลังเหตุการณ์สงบลงเพื่อป้องกันข้อความสแปม",
        nextAction: "ไม่ต้องดำเนินการใดๆ บัญชียังคงออนไลน์อยู่ในห้องเป้าหมายตามปกติ หากมีการแกล้งลากบ่อยครั้ง อาจพิจารณาปรับสิทธิ์ Move Members ในเซิร์ฟเวอร์",
        referenceId: getSessionShortId(sessionId),
        timestamp: record.lastMovedAt,
        footer: "Phomueangtai • ระบบล็อกช่องเสียง"
    });

    const eventKey = `voice:moved:${sessionId}:${record.lastMovedAt}`;

    try {
        const result = await send({
            eventKey,
            recipientId: record.ownerId,
            category: "voice",
            priority: "normal",
            payload: { embeds: [embed] }
        });
        console.log(`[WORKER] 📬 Move incident notification sent for ${sanitizeLogText(sessionId)} (moved ${record.moveCount} times).`);
        return result;
    } catch (err) {
        console.error(`[WORKER] ❌ Failed to send move incident DM for ${sanitizeLogText(sessionId)}: ${err.message}`);
        return null;
    }
}

function recordMoveIncident(sessionId, session, client, oldState, newState, deps = {}) {
    const debounceMs = Number.isFinite(Number(deps.debounceMs)) ? Number(deps.debounceMs) : MOVE_DEBOUNCE_MS;
    let record = moveTracking.get(sessionId);

    const now = Date.now();
    const toChannelName = newState.channel?.name || newState.channelId || "ห้องเสียงไม่ทราบชื่อ";

    if (record) {
        if (record.timer) clearTimeout(record.timer);
        record.moveCount++;
        record.lastMovedAt = now;
        record.lastMovedToChannelId = newState.channelId;
        record.lastMovedToChannelName = toChannelName;
    } else {
        record = {
            sessionId,
            ownerId: session.ownerId,
            accountId: client.user?.id || session.accountId,
            accountName: client.user?.tag || session.accountTag || session.accountName || "บัญชีไม่ทราบชื่อ",
            accountAvatar: typeof client.user?.displayAvatarURL === "function" ? client.user.displayAvatarURL() : session.accountAvatar || null,
            guildId: session.serverId,
            guildName: session.serverName || newState.guild?.name || "เซิร์ฟเวอร์ไม่ทราบชื่อ",
            targetChannelId: session.voiceId,
            targetChannelName: session.voiceName || "ช่องเป้าหมาย",
            lastMovedToChannelId: newState.channelId,
            lastMovedToChannelName: toChannelName,
            moveCount: 1,
            firstMovedAt: now,
            lastMovedAt: now,
            timer: null
        };
    }

    const setTimer = deps.setTimeout || setTimeout;
    record.timer = setTimer(() => {
        sendMoveNotification(sessionId, deps).catch(() => {});
    }, debounceMs);
    record.timer.unref?.();

    moveTracking.set(sessionId, record);
    return record;
}

function handleVoiceStateUpdate(sessionId, client, oldState, newState, deps = {}) {
    if (st.isShuttingDown) return false;

    // Must be the self-client user
    const selfUserId = client?.user?.id;
    if (!selfUserId || String(newState?.id || "") !== String(selfUserId)) {
        return false;
    }

    const getSession = deps.getSession || (id => sessionManager.getSession(id));
    const session = getSession(sessionId);
    const runnable = deps.isSessionRunnable || isSessionRunnable;
    if (!session || !runnable(session)) {
        return false;
    }

    // Must match the session's guild
    if (String(newState.guild?.id || "") !== String(session.serverId || "")) {
        return false;
    }

    // Disconnect from voice completely is handled by VoiceConnectionStatus.Disconnected
    if (!newState.channelId) {
        return false;
    }

    // Already in target channel
    if (String(newState.channelId) === String(session.voiceId)) {
        return false;
    }

    // Bot was moved to a different voice channel in the guild!
    const fromName = oldState?.channel?.name || oldState?.channelId || "ห้องเดิม";
    const toName = newState.channel?.name || newState.channelId || "ห้องใหม่";
    console.log(`[WORKER] 🧲 Bot moved from ${fromName} to ${toName} — flying back to target channel ${session.voiceName || session.voiceId} (${sanitizeLogText(sessionId)})`);

    // Immediate Flyback
    const conn = session.connection;
    if (conn && conn.state?.status !== VoiceConnectionStatus.Destroyed) {
        try {
            conn.rejoin({
                channelId: session.voiceId,
                selfMute: true,
                selfDeaf: true
            });
        } catch (err) {
            console.warn(`[WORKER] ⚠️ Flyback rejoin failed for ${sanitizeLogText(sessionId)}: ${err.message}`);
        }
    }

    // Record incident and schedule 3-minute trailing debounce notification
    recordMoveIncident(sessionId, session, client, oldState, newState, deps);
    return true;
}

function cancelMoveTracking(sessionId) {
    const record = moveTracking.get(sessionId);
    if (record) {
        if (record.timer) clearTimeout(record.timer);
        moveTracking.delete(sessionId);
        return true;
    }
    return false;
}

function clearAllMoveTrackers() {
    for (const record of moveTracking.values()) {
        if (record.timer) clearTimeout(record.timer);
    }
    moveTracking.clear();
}

function getMoveTracking(sessionId) {
    return moveTracking.get(sessionId) || null;
}

module.exports = {
    MOVE_DEBOUNCE_MS,
    handleVoiceStateUpdate,
    recordMoveIncident,
    sendMoveNotification,
    cancelMoveTracking,
    clearAllMoveTrackers,
    getMoveTracking,
    _test: {
        moveTracking,
        formatTime
    }
};
