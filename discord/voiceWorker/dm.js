"use strict";

const { getSessionShortId } = require("./session");
const { sanitizeLogText } = require("../core/safeLogger");
const dmService = require("../dm");
const { buildDmEmbed, profileFromUser, safeText, markdownText, code } = dmService.design;

const EVENT_VIEW = Object.freeze({
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
    if (minutes < 60) return `${minutes} นาที ${seconds % 60} วินาที`;
    const hours = Math.floor(minutes / 60);
    return `${hours} ชั่วโมง ${minutes % 60} นาที`;
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
    if (["RECOVERY_DELAYED", "SESSION_STOPPED_IDLE"].includes(type)) return "warning";
    if (["SESSION_READY", "SESSION_RECOVERED"].includes(type)) return "success";
    return "info";
}

function buildVoiceEventEmbed(snapshot, profile = null) {
    const view = EVENT_VIEW[snapshot.type] || { color: "#5865F2", title: "🔔 แจ้งเตือนระบบช่องเสียง", status: "ℹ️ มีการเปลี่ยนแปลง" };
    const fields = [
        { name: "📍 สถานะ", value: view.status },
        { name: "🏠 เซิร์ฟเวอร์", value: `${markdownText(snapshot.guildName)}\n${code(snapshot.guildId)}`, inline: true },
        { name: "🔊 ช่องเป้าหมาย", value: `${markdownText(snapshot.targetChannelName)}\n${code(snapshot.targetChannelId)}`, inline: true }
    ];

    if (snapshot.actualChannelId) {
        const verified = snapshot.actualChannelSource === "voice_state";
        fields.push({
            name: verified ? "✅ ช่องที่อ่านจากสถานะเสียง" : "ℹ️ ช่องจากสถานะการเชื่อมต่อ",
            value: code(snapshot.actualChannelId),
            inline: true
        });
    }
    if (snapshot.outageDurationMs > 0) fields.push({ name: "⏱️ ระยะเวลาที่หลุด", value: duration(snapshot.outageDurationMs), inline: true });
    if (snapshot.attempts > 0) fields.push({ name: "🔁 จำนวนครั้งที่ลองกู้คืน", value: String(snapshot.attempts), inline: true });
    if (snapshot.onlineDurationMs > 0) fields.push({ name: "🟢 ออนไลน์ต่อเนื่องก่อนเหตุการณ์", value: duration(snapshot.onlineDurationMs), inline: true });
    fields.push({ name: "🧩 รหัสการออน", value: code(getSessionShortId(snapshot.sessionId)), inline: true });
    return buildDmEmbed({
        tone: voiceTone(snapshot.type),
        title: view.title,
        summary: snapshot.actualChannelSource === "connection_state"
            ? "สถานะนี้อ้างอิงการเชื่อมต่อที่พร้อมใช้งาน แต่ Discord ยังไม่ส่ง Voice State ที่ยืนยันช่องกลับมา"
            : "สรุปสถานะล่าสุดของบัญชีที่ระบบตรวจสอบได้ ณ เวลาที่ระบุ",
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

module.exports = {
    EVENT_VIEW,
    createVoiceSnapshot,
    buildVoiceEventEmbed,
    sendVoiceEventDM,
    sendVoiceDigestDM,
    sendSessionStoppedDM,
    sendTokenInvalidDM,
    sendSessionOnlineDM
};
