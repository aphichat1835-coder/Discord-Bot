"use strict";

const { MessageEmbed } = require("discord.js");
const { st } = require("./state");
const { getSessionShortId } = require("./session");
const { sanitizeLogText } = require("../core/safeLogger");

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
    SESSION_STOPPED_IDLE: { color: "#FEE75C", title: "💤 หยุด Session ที่ไม่มีการใช้งาน", status: "⚫ หยุดแล้ว" },
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
    SESSION_STOPPED_IDLE: ["Session ไม่มี activity เกินเวลาที่ตั้งไว้", "เริ่ม Session ใหม่เมื่อต้องการกลับมาใช้งาน"],
    SESSION_STOPPED_MANUAL: ["มีการสั่งหยุด Session ด้วยตนเอง", "เริ่ม Session ใหม่เมื่อต้องการกลับมาใช้งาน"],
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
    const actualChannelId = context.actualChannelId || (type === "SESSION_READY" || type === "SESSION_RECOVERED" ? session.voiceId : null);
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
        verifiedAt,
        outageDurationMs: Number(context.outageDurationMs || 0),
        attempts: Number(context.attempts || session.recoveryState?.attempts || 0),
        onlineDurationMs: session.voiceReadyAt ? Math.max(0, verifiedAt - Number(session.voiceReadyAt)) : 0,
        reason: plain(context.reason, copy[0]),
        action: plain(context.action, copy[1])
    });
}

function buildVoiceEventEmbed(snapshot) {
    const view = EVENT_VIEW[snapshot.type] || { color: "#5865F2", title: "🔔 แจ้งเตือนระบบช่องเสียง", status: "ℹ️ มีการเปลี่ยนแปลง" };
    const fields = [
        { name: "📍 สถานะที่ยืนยัน", value: view.status },
        { name: "🏠 เซิร์ฟเวอร์", value: `${snapshot.guildName}\n\`${snapshot.guildId}\``, inline: true },
        { name: "🔊 ช่องเป้าหมาย", value: `${snapshot.targetChannelName}\n\`${snapshot.targetChannelId}\``, inline: true },
        { name: "👤 บัญชี", value: `${snapshot.accountName}\n\`${snapshot.accountId}\``, inline: true }
    ];

    if (snapshot.actualChannelId) fields.push({ name: "✅ ช่องที่ตรวจพบจริง", value: `\`${snapshot.actualChannelId}\``, inline: true });
    if (snapshot.outageDurationMs > 0) fields.push({ name: "⏱️ ระยะเวลาที่หลุด", value: duration(snapshot.outageDurationMs), inline: true });
    if (snapshot.attempts > 0) fields.push({ name: "🔁 จำนวนครั้งที่ลองกู้คืน", value: String(snapshot.attempts), inline: true });
    if (snapshot.onlineDurationMs > 0) fields.push({ name: "🟢 ออนไลน์ต่อเนื่องก่อนเหตุการณ์", value: duration(snapshot.onlineDurationMs), inline: true });
    fields.push(
        { name: "📋 รายละเอียด", value: snapshot.reason },
        { name: "💡 แนะนำ", value: snapshot.action },
        { name: "🧩 Session", value: `\`${getSessionShortId(snapshot.sessionId)}\``, inline: true },
        { name: "🕒 ตรวจสอบเมื่อ", value: `<t:${Math.floor(snapshot.verifiedAt / 1000)}:F>`, inline: true }
    );

    const embed = new MessageEmbed()
        .setColor(view.color)
        .setTitle(view.title)
        .setDescription("รายงานนี้อ้างอิงสถานะที่ระบบตรวจสอบได้จริง ณ เวลาที่ระบุด้านล่าง")
        .addFields(fields)
        .setTimestamp(snapshot.verifiedAt)
        .setFooter({ text: "Phomueangtai Enterprise • Voice Monitor" });
    if (snapshot.accountAvatar) embed.setThumbnail(snapshot.accountAvatar);
    return embed;
}

async function fetchOwner(ownerId) {
    if (!st.mainClient || !ownerId) return null;
    return st.mainClient.users.fetch(ownerId).catch(() => null);
}

async function sendVoiceEventDM(snapshot) {
    try {
        const owner = await fetchOwner(snapshot.ownerId);
        if (!owner) return { status: "skipped", reason: "owner_unavailable" };
        await owner.send({ embeds: [buildVoiceEventEmbed(snapshot)], allowedMentions: { parse: [] } });
        return { status: "sent" };
    } catch (error) {
        const code = plain(error?.code || error?.name, "UNKNOWN");
        console.error(`[WORKER] ❌ Voice DM failed. session=${sanitizeLogText(snapshot.sessionId)} code=${sanitizeLogText(code)}`);
        return { status: "failed", reason: code };
    }
}

async function sendVoiceDigestDM(ownerId, items, metadata = {}) {
    try {
        const owner = await fetchOwner(ownerId);
        if (!owner) return { status: "skipped", reason: "owner_unavailable" };
        const counts = new Map(Object.entries(metadata.counts || {}));
        if (counts.size === 0) {
            for (const item of items) counts.set(item.type, (counts.get(item.type) || 0) + 1);
        }
        const total = Number(metadata.total || items.length);
        const summary = [...counts].map(([type, count]) => `• ${EVENT_VIEW[type]?.title || type}: ${count}`).join("\n");
        const examples = items.slice(0, 5).map(item => `• ${item.guildName} / ${item.targetChannelName}`).join("\n");
        const embed = new MessageEmbed()
            .setColor("#5865F2")
            .setTitle("📬 สรุปเหตุการณ์ช่องเสียง")
            .setDescription(`ระบบรวม ${total} เหตุการณ์ไว้ในข้อความเดียว เพื่อไม่ให้ DM รบกวนเกินไป`)
            .addFields(
                { name: "📊 เหตุการณ์", value: summary.slice(0, 1024) || "ไม่มีรายละเอียด" },
                { name: "🔎 ตัวอย่าง Session", value: examples.slice(0, 1024) || "ไม่มีรายละเอียด" }
            )
            .setTimestamp()
            .setFooter({ text: "Phomueangtai Enterprise • Voice Monitor" });
        await owner.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return { status: "sent" };
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
