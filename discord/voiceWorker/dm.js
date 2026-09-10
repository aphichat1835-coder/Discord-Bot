"use strict";

const { getSessionShortId } = require("./session");
const { sanitizeLogText } = require("../core/safeLogger");
const dmService = require("../dm");
const { buildDmEmbed, profileFromUser, safeText, markdownText, code } = dmService.design;

const EVENT_VIEW = Object.freeze({
    VOICE_DISCONNECTED: { color: "#FFA500", title: "⚠️ การเชื่อมต่อช่องเสียงหลุด", status: "🟠 กำลังเริ่มกู้คืนอัตโนมัติ" },
    SESSION_READY: { color: "#57F287", title: "✅ เริ่มออนช่องเสียงแล้ว", status: "🟢 ออนไลน์ในช่องเป้าหมาย" },
    RECOVERY_DELAYED: { color: "#FEE75C", title: "🛠️ กำลังกู้คืนช่องเสียง", status: "🟠 การเชื่อมต่อยังไม่กลับมาปกติ" },
    SESSION_RECOVERED: { color: "#57F287", title: "✅ กลับมาออนช่องเสียงแล้ว", status: "🟢 ยืนยันแล้วว่าออนไลน์ในช่องเป้าหมาย" },
    RECOVERY_EXHAUSTED: { color: "#ED4245", title: "⛔ กู้คืนไม่สำเร็จ", status: "⚫ หยุดแล้วหลังลองเชื่อมต่อครบกำหนด" },
    TOKEN_INVALID: { color: "#ED4245", title: "🚫 Token ใช้งานไม่ได้", status: "🔴 เข้าสู่ระบบบัญชีไม่ได้" },
    LOGIN_FAILED: { color: "#ED4245", title: "❌ เข้าสู่ระบบไม่สำเร็จ", status: "🔴 ยังไม่ได้ออนช่องเสียง" },
    GUILD_NOT_FOUND: { color: "#ED4245", title: "🏠 ไม่พบเซิร์ฟเวอร์", status: "🔴 ยังไม่ได้ออนช่องเสียง" },
    CHANNEL_NOT_FOUND: { color: "#ED4245", title: "🔊 ไม่พบช่องเสียง", status: "🔴 ยังไม่ได้ออนช่องเสียง" },
    VOICE_PERMISSION_DENIED: { color: "#ED4245", title: "🔒 เข้าช่องเสียงไม่ได้", status: "🔴 สิทธิ์ไม่เพียงพอ" },
    VOICE_CONNECTION_FAILED: { color: "#ED4245", title: "📡 เชื่อมต่อช่องเสียงไม่สำเร็จ", status: "🔴 ยังยืนยันการออนไลน์ไม่ได้" },
    SESSION_STOPPED_IDLE: { color: "#FEE75C", title: "💤 หยุดการออนที่ไม่มีการใช้งาน", status: "⚫ หยุดแล้ว" },
    SESSION_STOPPED_MANUAL: { color: "#5865F2", title: "🛑 หยุดออนช่องเสียงแล้ว", status: "⚫ หยุดแล้วตามคำสั่ง" },
    STOP_FAILED: { color: "#ED4245", title: "⚠️ หยุด Session ไม่สมบูรณ์", status: "🔴 อาจยังค้างอยู่ในช่องเสียง" }
});

const EVENT_COPY = Object.freeze({
    VOICE_DISCONNECTED: ["การเชื่อมต่อช่องเสียงหลุดออกจากเซิร์ฟเวอร์", "ระบบกำลังเริ่มกระบวนการกู้คืนและเชื่อมต่อใหม่อัตโนมัติ"],
    SESSION_READY: ["ระบบยืนยันแล้วว่าบัญชีอยู่ในช่องเสียงเป้าหมาย", "ไม่ต้องทำอะไร ระบบกำลังทำงานตามปกติ"],
    RECOVERY_DELAYED: ["การเชื่อมต่อหลุดและยังไม่กลับมาภายในเวลาผ่อนผัน", "ระบบกำลังกู้คืนอัตโนมัติ ไม่ต้องกดเริ่มซ้ำ"],
    SESSION_RECOVERED: ["ระบบกู้คืนสำเร็จและตรวจพบช่องเสียงตรงกับเป้าหมาย", "ไม่ต้องทำอะไร ระบบกลับมาทำงานตามปกติแล้ว"],
    RECOVERY_EXHAUSTED: ["ระบบลองเชื่อมต่อใหม่ครบจำนวนที่กำหนดแล้ว", "ตรวจสอบช่องเสียงและสิทธิ์ จากนั้นเริ่ม Session ใหม่"],
    TOKEN_INVALID: ["Discord ปฏิเสธ Token หรือยกเลิกการเข้าสู่ระบบบัญชี", "เปลี่ยน Token หรือใช้บัญชีอื่น แล้วเริ่ม Session ใหม่"],
    LOGIN_FAILED: ["ระบบเข้าสู่ระบบบัญชีไม่สำเร็จ", "รอสักครู่แล้วลองใหม่ หากยังไม่สำเร็จให้ตรวจสอบบัญชีและ Token"],
    GUILD_NOT_FOUND: ["บัญชีไม่พบเซิร์ฟเวอร์เป้าหมาย", "ตรวจสอบว่าบัญชียังอยู่ในเซิร์ฟเวอร์และ ID ถูกต้อง"],
    CHANNEL_NOT_FOUND: ["ไม่พบช่องเสียงเป้าหมาย หรือช่องถูกลบแล้ว", "เลือกช่องเสียงใหม่แล้วเริ่ม Session อีกครั้ง"],
    VOICE_PERMISSION_DENIED: ["บัญชีไม่มีสิทธิ์ดูหรือเข้าช่องเสียงเป้าหมาย", "อนุญาต View Channel และ Connect ให้บัญชีนี้"],
    VOICE_CONNECTION_FAILED: ["การเชื่อมต่อไม่ถึงสถานะพร้อมใช้งานภายในเวลาที่กำหนด", "ตรวจสอบเครือข่ายและช่องเสียง แล้วลองเริ่มใหม่"],
    SESSION_STOPPED_IDLE: ["ไม่มีการใช้งานบัญชีเกินเวลาที่ตั้งไว้ ระบบจึงหยุดให้อัตโนมัติ", "เริ่มออนใหม่เมื่อต้องการกลับมาใช้งาน"],
    SESSION_STOPPED_MANUAL: ["มีการสั่งหยุดการออนช่องเสียงด้วยตนเอง", "เริ่มออนใหม่เมื่อต้องการกลับมาใช้งาน"],
    STOP_FAILED: ["ระบบสั่งหยุดแล้ว แต่ยังยืนยันไม่ได้ว่าบัญชีออกจากช่องเสียง", "ตรวจสอบบัญชีในช่องเสียงและลองสั่งหยุดอีกครั้ง"]
});

function plain(value, fallback = "ไม่ทราบ") {
    const cleaned = String(value ?? "")
        .replaceAll("@", "＠")
        .replaceAll(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 180);
    return cleaned || fallback;
}

function duration(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds} วินาที`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
        return remainingSeconds > 0 ? `${minutes} นาที ${remainingSeconds} วินาที` : `${minutes} นาที`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours} ชั่วโมง ${remainingMinutes} นาที` : `${hours} ชั่วโมง`;
}

function createVoiceSnapshot(session, type, context = {}) {
    const verifiedAt = Number(context.verifiedAt || Date.now());
    const copy = EVENT_COPY[type] || ["ระบบตรวจพบการเปลี่ยนแปลงของ Session", "ตรวจสอบสถานะผ่านแผงควบคุม"];
    const actualChannelId = context.actualChannelId || null;
    const onlineSince = Number(context.onlineSince ?? session.voiceReadyAt ?? 0);
    return Object.freeze({
        type,
        ownerId: String(session.ownerId || ""),
        sessionId: String(session.sessionId || ""),
        accountName: plain(session.accountTag || session.accountName, "บัญชีไม่ทราบชื่อ"),
        accountId: plain(session.accountId, "ไม่ทราบ"),
        accountAvatar: session.accountAvatar || null,
        guildName: plain(session.serverName, "เซิร์ฟเวอร์ไม่ทราบชื่อ"),
        guildId: plain(session.serverId, "ไม่ทราบ"),
        targetChannelName: plain(session.voiceName, "ช่องเสียงไม่ทราบชื่อ"),
        targetChannelId: plain(session.voiceId, "ไม่ทราบ"),
        actualChannelId: actualChannelId ? plain(actualChannelId) : null,
        actualChannelSource: actualChannelId ? plain(context.actualChannelSource, "voice_state") : null,
        verifiedAt,
        outageDurationMs: Number(context.outageDurationMs || 0),
        attempts: Number(context.attempts ?? session.recoveryState?.attempts ?? 0),
        onlineDurationMs: onlineSince ? Math.max(0, verifiedAt - onlineSince) : 0,
        reason: plain(context.reason, copy[0]),
        action: plain(context.action, copy[1]),
        notificationEventKey: plain(context.notificationEventKey, `${session.sessionId}:${type}:${verifiedAt}`),
        priority: plain(context.priority, "normal")
    });
}

function voiceTone(type) {
    if (["TOKEN_INVALID", "RECOVERY_EXHAUSTED", "STOP_FAILED"].includes(type)) return "danger";
    if (["LOGIN_FAILED", "GUILD_NOT_FOUND", "CHANNEL_NOT_FOUND", "VOICE_PERMISSION_DENIED", "VOICE_CONNECTION_FAILED"].includes(type)) return "action";
    if (["VOICE_DISCONNECTED", "RECOVERY_DELAYED", "SESSION_STOPPED_IDLE"].includes(type)) return "warning";
    if (["SESSION_READY", "SESSION_RECOVERED"].includes(type)) return "success";
    return "info";
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function formatGuildField(guildName, guildId) {
    const safeName = markdownText(guildName, "เซิร์ฟเวอร์ไม่ทราบชื่อ");
    if (SNOWFLAKE_PATTERN.test(String(guildId || ""))) {
        return `[🏠 ${safeName}](https://discord.com/channels/${guildId})\n${code(guildId)}`;
    }
    return `${safeName}\n${code(guildId)}`;
}

function formatChannelField(channelName, channelId, guildId) {
    const safeName = markdownText(channelName, "ช่องเสียงไม่ทราบชื่อ");
    const isChanSnowflake = SNOWFLAKE_PATTERN.test(String(channelId || ""));
    const isGuildSnowflake = SNOWFLAKE_PATTERN.test(String(guildId || ""));

    if (isChanSnowflake && isGuildSnowflake) {
        return `<#${channelId}> ([🔊 ${safeName}](https://discord.com/channels/${guildId}/${channelId}))\n${code(channelId)}`;
    }
    if (isChanSnowflake) {
        return `<#${channelId}>\n${code(channelId)}`;
    }
    return `${safeName}\n${code(channelId)}`;
}

function formatActualChannelField(actualChannelId, guildId) {
    const isChanSnowflake = SNOWFLAKE_PATTERN.test(String(actualChannelId || ""));
    const isGuildSnowflake = SNOWFLAKE_PATTERN.test(String(guildId || ""));
    if (isChanSnowflake && isGuildSnowflake) {
        return `<#${actualChannelId}> ([🔊 ลิงก์ห้อง](https://discord.com/channels/${guildId}/${actualChannelId}))\n${code(actualChannelId)}`;
    }
    if (isChanSnowflake) {
        return `<#${actualChannelId}>\n${code(actualChannelId)}`;
    }
    return code(actualChannelId);
}

function getVoiceSummary(snapshot) {
    if (snapshot.actualChannelSource === "connection_state") {
        return "สถานะนี้อ้างอิงการเชื่อมต่อที่พร้อมใช้งาน แต่ Discord ยังไม่ส่ง Voice State ที่ยืนยันช่องกลับมา";
    }
    if (snapshot.type === "VOICE_DISCONNECTED") {
        return "ระบบตรวจพบว่าการเชื่อมต่อช่องเสียงหลุดออก และกำลังเริ่มกู้คืนให้อัตโนมัติ";
    }
    if (snapshot.type === "SESSION_RECOVERED") {
        return "ระบบกู้คืนการเชื่อมต่อช่องเสียงสำเร็จ และตรวจสอบยืนยันสถานะการออนไลน์ในห้องเสียงเรียบร้อยแล้ว";
    }
    if (snapshot.type === "SESSION_READY") {
        return "ระบบเริ่มการออนช่องเสียงสำเร็จ และยืนยันสถานะเรียบร้อยแล้ว";
    }
    return "สรุปสถานะล่าสุดของบัญชีที่ระบบตรวจสอบได้ ณ เวลาที่ระบุ";
}

function buildVoiceEventEmbed(snapshot, profile = null) {
    const view = EVENT_VIEW[snapshot.type] || { color: "#5865F2", title: "🔔 แจ้งเตือนระบบช่องเสียง", status: "ℹ️ มีการเปลี่ยนแปลง" };
    const fields = [
        { name: "📍 สถานะ", value: view.status },
        { name: "🏠 เซิร์ฟเวอร์", value: formatGuildField(snapshot.guildName, snapshot.guildId), inline: true },
        { name: "🔊 ช่องเป้าหมาย", value: formatChannelField(snapshot.targetChannelName, snapshot.targetChannelId, snapshot.guildId), inline: true }
    ];

    if (snapshot.actualChannelId) {
        const verified = snapshot.actualChannelSource === "voice_state";
        fields.push({
            name: verified ? "✅ ช่องที่อ่านจากสถานะเสียง" : "ℹ️ ช่องจากสถานะการเชื่อมต่อ",
            value: formatActualChannelField(snapshot.actualChannelId, snapshot.guildId),
            inline: true
        });
    }
    if (snapshot.outageDurationMs > 0) {
        fields.push({ name: "⏱️ ระยะเวลาที่หลุด", value: duration(snapshot.outageDurationMs), inline: true });
    }
    if (snapshot.attempts > 0) {
        fields.push({ name: "🔁 จำนวนครั้งที่ลองกู้คืน", value: `${snapshot.attempts} ครั้ง`, inline: true });
    }
    if (snapshot.onlineDurationMs > 0) {
        fields.push({
            name: snapshot.type === "VOICE_DISCONNECTED" ? "🟢 ออนไลน์ต่อเนื่องก่อนหลุด" : "🟢 ออนไลน์ต่อเนื่องก่อนเหตุการณ์",
            value: duration(snapshot.onlineDurationMs),
            inline: true
        });
    }
    fields.push({ name: "🧩 รหัสการออน", value: code(getSessionShortId(snapshot.sessionId)), inline: true });
    return buildDmEmbed({
        tone: voiceTone(snapshot.type),
        title: view.title,
        summary: getVoiceSummary(snapshot),
        profile: profile || profileFromUser(null, {
            id: snapshot.accountId,
            displayName: snapshot.accountName,
            username: snapshot.accountName,
            avatarUrl: snapshot.accountAvatar
        }),
        fields,
        details: snapshot.reason,
        nextAction: snapshot.action,
        referenceId: getSessionShortId(snapshot.sessionId),
        timestamp: snapshot.verifiedAt,
        footer: "Phomueangtai • ระบบออนช่องเสียง"
    });
}

async function sendVoiceEventDM(snapshot) {
    try {
        const profile = await dmService.resolveProfile(snapshot.accountId, {
            id: snapshot.accountId,
            displayName: snapshot.accountName,
            username: snapshot.accountName,
            avatarUrl: snapshot.accountAvatar
        });
        return dmService.send({
            eventKey: `voice:${snapshot.notificationEventKey}`,
            recipientId: snapshot.ownerId,
            category: "voice",
            priority: snapshot.priority,
            payload: { embeds: [buildVoiceEventEmbed(snapshot, profile)] }
        });
    } catch (error) {
        const code = plain(error?.code || error?.name, "UNKNOWN");
        console.error(`[WORKER] ❌ Voice DM failed. session=${sanitizeLogText(snapshot.sessionId)} code=${sanitizeLogText(code)}`);
        return { status: "failed", reason: code };
    }
}

async function sendVoiceDigestDM(ownerId, items, metadata = {}) {
    try {
        const counts = new Map(Object.entries(metadata.counts || {}));
        if (counts.size === 0) {
            for (const item of items) counts.set(item.type, (counts.get(item.type) || 0) + 1);
        }
        const total = Number(metadata.total || items.length);
        const summary = [...counts].map(([type, count]) => `• ${EVENT_VIEW[type]?.title || type}: ${count}`).join("\n");
        const examples = items.slice(0, 5).map(item =>
            `• ${markdownText(item.accountName)} — ${markdownText(item.guildName)} / ${markdownText(item.targetChannelName)}\n  ${markdownText(item.reason)}`
        ).join("\n");
        const profile = await dmService.resolveProfile(ownerId);
        const digestReference = `digest-${Date.now().toString(36)}`;
        const embed = buildDmEmbed({
            tone: "info",
            title: "📬 สรุปเหตุการณ์ช่องเสียง",
            summary: `รวม ${total} เหตุการณ์ทั่วไปไว้ในข้อความเดียวเพื่อลดการรบกวน เหตุการณ์เร่งด่วนจะส่งแยกทันที`,
            profile,
            fields: [
                { name: "📊 จำนวนแยกตามเหตุการณ์", value: summary.slice(0, 1024) || "ไม่มีรายละเอียด" },
                { name: "🔎 รายการล่าสุด", value: safeText(examples, "ไม่มีรายละเอียด", 1024) }
            ],
            nextAction: "ตรวจสอบเฉพาะรายการที่ยังไม่กลับสู่สถานะปกติจากหน้า Dashboard",
            referenceId: digestReference,
            footer: "Phomueangtai • สรุประบบออนช่องเสียง"
        });
        return dmService.send({
            eventKey: `voice:${ownerId}:${digestReference}`,
            recipientId: ownerId,
            category: "voice_digest",
            priority: "low",
            payload: { embeds: [embed] }
        });
    } catch (error) {
        return { status: "failed", reason: plain(error?.code || error?.name, "UNKNOWN") };
    }
}

function sendSessionStoppedDM(sessionId, reason) {
    const notifications = require("./notifications");
    let type = notifications.EVENTS.RECOVERY_EXHAUSTED;
    if (reason === "idle") type = notifications.EVENTS.SESSION_STOPPED_IDLE;
    else if (reason === "manual") type = notifications.EVENTS.SESSION_STOPPED_MANUAL;
    return notifications.markTerminal(sessionId, type, { reason });
}

function sendTokenInvalidDM(sessionId) {
    const notifications = require("./notifications");
    return notifications.markTerminal(sessionId, notifications.EVENTS.TOKEN_INVALID);
}

function sendSessionOnlineDM(sessionId) {
    return require("./notifications").markReady(sessionId);
}

const TRACKER_PHASE_VIEW = Object.freeze({
    starting: {
        tone: "warning",
        title: "🔄 กำลังกู้คืนช่องเสียงแบบเรียลไทม์",
        summary: "ระบบกำลังดำเนินการกู้คืนการเชื่อมต่อให้อัตโนมัติ ข้อความนี้จะอัปเดตสถานะแบบเรียลไทม์",
        defaultStatus: "🔄 เริ่มกระบวนการกู้คืนและตรวจสอบช่องเสียง..."
    },
    attempt: {
        tone: "warning",
        title: "🔄 กำลังกู้คืนช่องเสียงแบบเรียลไทม์",
        summary: "ระบบกำลังดำเนินการกู้คืนการเชื่อมต่อให้อัตโนมัติ ข้อความนี้จะอัปเดตสถานะแบบเรียลไทม์",
        defaultStatus: "🔄 กำลังลองเชื่อมต่อเข้าสู่ช่องเสียง..."
    },
    hibernate: {
        tone: "warning",
        title: "⏸️ อยู่ในช่วงพักกู้คืนช่องเสียง",
        summary: "ระบบเข้าสู่โหมดพักรอเพื่อป้องกันการถูกจำกัดสัญญาณ และจะเริ่มพยายามใหม่อัตโนมัติเมื่อครบกำหนด",
        defaultStatus: "⏸️ พักรอชั่วคราวก่อนเริ่มรอบถัดไป"
    },
    recovered: {
        tone: "success",
        title: "✅ กู้คืนการเชื่อมต่อสำเร็จเรียบร้อย",
        summary: "ระบบกู้คืนการเชื่อมต่อช่องเสียงสำเร็จ และตรวจสอบยืนยันสถานะการออนไลน์ในห้องเสียงเรียบร้อยแล้ว",
        defaultStatus: "🟢 ยืนยันแล้วว่าออนไลน์ในช่องเป้าหมาย"
    },
    exhausted: {
        tone: "danger",
        title: "⛔ กู้คืนไม่สำเร็จ (สิ้นสุดความพยายาม)",
        summary: "ระบบลองกู้คืนครบตามจำนวนที่กำหนดแล้ว แต่ยังไม่สามารถเชื่อมต่อได้",
        defaultStatus: "⚫ หยุดแล้วหลังลองเชื่อมต่อครบกำหนด"
    },
    terminal: {
        tone: "danger",
        title: "🛑 ยกเลิกการกู้คืนช่องเสียง",
        summary: "การกู้คืนช่องเสียงสิ้นสุดลงเนื่องจากเซสชันถูกสั่งหยุดหรือโทเคนหมดอายุ",
        defaultStatus: "⚫ การกู้คืนสิ้นสุดลง"
    }
});

function buildTrackerFields(snapshot, trackerState, phaseView) {
    const statusText = trackerState.statusText || phaseView.defaultStatus;
    const fields = [
        { name: "📍 สถานะปัจจุบัน", value: statusText },
        { name: "🏠 เซิร์ฟเวอร์", value: formatGuildField(snapshot.guildName, snapshot.guildId), inline: true },
        { name: "🔊 ช่องเป้าหมาย", value: formatChannelField(snapshot.targetChannelName, snapshot.targetChannelId, snapshot.guildId), inline: true }
    ];

    const openedAt = Number(trackerState.openedAt || snapshot.verifiedAt || 0);
    if (openedAt > 0) {
        const elapsed = Math.max(0, Date.now() - openedAt);
        fields.push({ name: "⏱️ ระยะเวลาที่พยายาม", value: duration(elapsed), inline: true });
    }

    if (trackerState.attempts !== undefined || trackerState.cycle !== undefined) {
        const attempts = Number(trackerState.attempts || 0);
        const maxAttempts = Number(trackerState.maxAttempts || 15);
        let attemptText = `${attempts}/${maxAttempts} ครั้ง`;
        if (trackerState.cycle > 0) {
            attemptText += ` (พักรอบที่ ${trackerState.cycle}/2)`;
        }
        fields.push({ name: "🔁 รอบความพยายาม", value: attemptText, inline: true });
    }

    fields.push({ name: "🧩 รหัสการออน", value: code(getSessionShortId(snapshot.sessionId)), inline: true });
    return fields;
}

function resolveTrackerAction(phase) {
    if (phase === "recovered") return "ไม่ต้องทำอะไร ระบบกลับมาทำงานตามปกติแล้ว";
    if (phase === "exhausted") return "ตรวจสอบช่องเสียงและสิทธิ์ จากนั้นเริ่ม Session ใหม่";
    return "ไม่ต้องกดเริ่มซ้ำ ระบบกำลังดูแลการเชื่อมต่อให้อัตโนมัติ";
}

function buildVoiceTrackerEmbed(snapshot, trackerState = {}, profile = null) {
    const phase = trackerState.phase || "starting";
    const phaseView = TRACKER_PHASE_VIEW[phase] || TRACKER_PHASE_VIEW.starting;
    const fields = buildTrackerFields(snapshot, trackerState, phaseView);

    const isDone = ["recovered", "exhausted", "terminal"].includes(phase);
    const details = trackerState.details || (isDone ? "กระบวนการกู้คืนเสร็จสิ้นแล้ว" : "ระบบจะอัปเดตสถานะในข้อความนี้ต่อเนื่องแบบเรียลไทม์");
    const nextAction = resolveTrackerAction(phase);

    return buildDmEmbed({
        tone: phaseView.tone,
        title: phaseView.title,
        summary: phaseView.summary,
        profile: profile || profileFromUser(null, {
            id: snapshot.accountId,
            displayName: snapshot.accountName,
            username: snapshot.accountName,
            avatarUrl: snapshot.accountAvatar
        }),
        fields,
        details,
        nextAction,
        referenceId: `track-${getSessionShortId(snapshot.sessionId)}`,
        timestamp: Date.now(),
        footer: "Phomueangtai • Live Recovery Tracker"
    });
}

async function sendVoiceRecoveryTrackerDM(snapshot, trackerState = {}) {
    try {
        const profile = await dmService.resolveProfile(snapshot.accountId, {
            id: snapshot.accountId,
            displayName: snapshot.accountName,
            username: snapshot.accountName,
            avatarUrl: snapshot.accountAvatar
        });
        const eventKey = `voice:tracker:${snapshot.sessionId}:${trackerState.incidentId || Date.now()}`;
        const embed = buildVoiceTrackerEmbed(snapshot, trackerState, profile);
        const result = await dmService.send({
            eventKey,
            recipientId: snapshot.ownerId,
            category: "voice_tracker",
            priority: "high",
            payload: { embeds: [embed] }
        });
        return {
            status: result?.status || "failed",
            message: result?.message || null
        };
    } catch (error) {
        return { status: "failed", reason: plain(error?.code || error?.name, "UNKNOWN") };
    }
}

async function editVoiceRecoveryTrackerDM(trackerRef, snapshot, trackerState = {}) {
    if (!trackerRef) return { status: "skipped", reason: "tracker_missing" };
    try {
        const profile = await dmService.resolveProfile(snapshot.accountId, {
            id: snapshot.accountId,
            displayName: snapshot.accountName,
            username: snapshot.accountName,
            avatarUrl: snapshot.accountAvatar
        });
        const embed = buildVoiceTrackerEmbed(snapshot, trackerState, profile);
        if (trackerRef.message && typeof trackerRef.message.edit === "function") {
            await trackerRef.message.edit({ embeds: [embed] });
            return { status: "updated" };
        }
        return { status: "skipped", reason: "no_edit_method" };
    } catch (error) {
        return { status: "failed", reason: plain(error?.code || error?.name, "UNKNOWN") };
    }
}

module.exports = {
    EVENT_VIEW,
    TRACKER_PHASE_VIEW,
    createVoiceSnapshot,
    buildVoiceEventEmbed,
    buildVoiceTrackerEmbed,
    sendVoiceEventDM,
    sendVoiceDigestDM,
    sendVoiceRecoveryTrackerDM,
    editVoiceRecoveryTrackerDM,
    sendSessionStoppedDM,
    sendTokenInvalidDM,
    sendSessionOnlineDM
};
