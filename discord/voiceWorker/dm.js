"use strict";

const { MessageEmbed, MessageActionRow, MessageButton } = require("../core/discordCompat");
const { IDS } = require("../commands/customIds");
const config = require("../config.json");
const { getSessionShortId } = require("./session");
const { sanitizeLogText } = require("../core/safeLogger");
const dmService = require("../dm");
const sessionManager = require("./sessionManager");
const { buildDmEmbed, profileFromUser, safeText, markdownText, code } = dmService.design;

function resolveEmoji(name, fallback = "") {
    return config.emojis?.[name] || fallback;
}

const TERMINAL_TITLES = Object.freeze({
    TOKEN_INVALID: "ระบบไม่สามารถล็อคอินได้ กรุณาลองใหม่เเละตรวจสอบToken",
    LOGIN_FAILED: "ระบบไม่สามารถล็อคอินได้ กรุณาลองใหม่เเละตรวจสอบToken",
    GUILD_NOT_FOUND: "บัญชีไม่พบเซิฟเวอร์ที่กำหนด กรุณาเช็คเเละลองใหม่",
    CHANNEL_NOT_FOUND: "บัญชีไม่พบช่องเสียงที่กำหนด กรุณาเช็คเเละลองใหม่",
    VOICE_PERMISSION_DENIED: "เกิดข้อผิดพลาด เชื่อมต่อช่องเสียงไม่สำเร็จ",
    VOICE_CONNECTION_FAILED: "เกิดข้อผิดพลาด เชื่อมต่อช่องเสียงไม่สำเร็จ",
    SESSION_STOPPED_IDLE: "เกินกำหนดเวลาที่ระบบออนให้เเล้ว",
    SESSION_STOPPED_MANUAL: "ระบบได้ทำการออกจากช่องเสียงเเล้ว จากคำสั่งหยุดของผู้ใช้",
    STOP_FAILED: "เกิดข้อผิดพลาดของToken โปรดตรวจเช็คว่าระบบได้ออกจากช่องเสียงยัง",
    RECOVERY_EXHAUSTED: "กู้คืนไม่สำเร็จ สิ้นสุดความพยายามเชื่อมต่อ"
});

const VOICE_COLORS = Object.freeze({
    success: "#2ECC71", // เขียว Classic Discord
    warning: "#E74C3C", // แดง Classic Discord (แทนที่ส้มตามคำสั่งผู้ใช้)
    danger: "#E74C3C"   // แดง Classic Discord
});

const EVENT_VIEW = Object.freeze({
    VOICE_DISCONNECTED: { color: VOICE_COLORS.warning, title: `${config.emojis?.alert || config.emojis?.warning || "⚠️"} การเชื่อมต่อช่องเสียงหลุด`, status: "🟠 กำลังเริ่มกู้คืนอัตโนมัติ" },
    SESSION_READY: { color: VOICE_COLORS.success, title: `${config.emojis?.check_alt || config.emojis?.success || "✅"} เริ่มออนช่องเสียงแล้ว`, status: `${config.emojis?.status_online || config.emojis?.armed_on || "🟢"} ออนไลน์ในช่องเป้าหมาย` },
    RECOVERY_DELAYED: { color: VOICE_COLORS.warning, title: `${config.emojis?.alarm || config.emojis?.warning || "⚠️"} กำลังกู้คืนช่องเสียง`, status: "🟠 การเชื่อมต่อยังไม่กลับมาปกติ" },
    SESSION_RECOVERED: { color: VOICE_COLORS.success, title: `${config.emojis?.check_alt || config.emojis?.success || "✅"} กลับมาออนช่องเสียงแล้ว`, status: `${config.emojis?.status_online || config.emojis?.armed_on || "🟢"} ยืนยันแล้วว่าออนไลน์ในช่องเป้าหมาย` },
    RECOVERY_EXHAUSTED: { color: VOICE_COLORS.danger, title: `${config.emojis?.no_entry || "⛔"} กู้คืนไม่สำเร็จ`, status: "⚫ หยุดแล้วหลังลองเชื่อมต่อครบกำหนด" },
    TOKEN_INVALID: { color: VOICE_COLORS.danger, title: `${config.emojis?.red_card || config.emojis?.error || "🚫"} Token ใช้งานไม่ได้`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} เข้าสู่ระบบบัญชีไม่ได้` },
    LOGIN_FAILED: { color: VOICE_COLORS.danger, title: `${config.emojis?.red_card || config.emojis?.error || "❌"} เข้าสู่ระบบไม่สำเร็จ`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} ยังไม่ได้ออนช่องเสียง` },
    GUILD_NOT_FOUND: { color: VOICE_COLORS.danger, title: `${config.emojis?.server_icon || "🏠"} ไม่พบเซิร์ฟเวอร์`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} ยังไม่ได้ออนช่องเสียง` },
    CHANNEL_NOT_FOUND: { color: VOICE_COLORS.danger, title: `${config.emojis?.voice_ch || "🔊"} ไม่พบช่องเสียง`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} ยังไม่ได้ออนช่องเสียง` },
    VOICE_PERMISSION_DENIED: { color: VOICE_COLORS.danger, title: `${config.emojis?.lock || "🔒"} เข้าช่องเสียงไม่ได้`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} สิทธิ์ไม่เพียงพอ` },
    VOICE_CONNECTION_FAILED: { color: VOICE_COLORS.danger, title: `${config.emojis?.critical || config.emojis?.error || "📡"} เชื่อมต่อช่องเสียงไม่สำเร็จ`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} ยังยืนยันการออนไลน์ไม่ได้` },
    SESSION_STOPPED_IDLE: { color: VOICE_COLORS.warning, title: `${config.emojis?.disable || "💤"} หยุดการออนที่ไม่มีการใช้งาน`, status: "⚫ หยุดแล้ว" },
    SESSION_STOPPED_MANUAL: { color: VOICE_COLORS.warning, title: `${config.emojis?.stop || "🛑"} หยุดออนช่องเสียงแล้ว`, status: "⚫ หยุดแล้วตามคำสั่ง" },
    STOP_FAILED: { color: VOICE_COLORS.danger, title: `${config.emojis?.warning || "⚠️"} หยุด Session ไม่สมบูรณ์`, status: `${config.emojis?.status_offline || config.emojis?.armed_off || "🔴"} อาจยังค้างอยู่ในช่องเสียง` }
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

function resolveChannelContext(actualChannelId, actualChannelSource) {
    if (!actualChannelId) return { actualChannelId: null, actualChannelSource: null };
    return {
        actualChannelId: plain(actualChannelId),
        actualChannelSource: plain(actualChannelSource, "voice_state")
    };
}

function createVoiceSnapshot(session, type, context = {}) {
    const verifiedAt = Number(context.verifiedAt ?? Date.now());
    const copy = EVENT_COPY[type] || ["ระบบตรวจพบการเปลี่ยนแปลงของ Session", "ตรวจสอบสถานะผ่านแผงควบคุม"];
    const channelContext = resolveChannelContext(context.actualChannelId, context.actualChannelSource);
    const onlineSince = Number(context.onlineSince ?? session.voiceReadyAt ?? 0);
    const outageDurationMs = Number(context.outageDurationMs ?? 0);
    const attempts = Number(context.attempts ?? session.recoveryState?.attempts ?? 0);
    const onlineDurationMs = onlineSince ? Math.max(0, verifiedAt - onlineSince) : 0;

    return Object.freeze({
        type,
        ownerId: String(session.ownerId ?? ""),
        sessionId: String(session.sessionId ?? ""),
        accountName: plain(session.accountTag ?? session.accountName, "บัญชีไม่ทราบชื่อ"),
        accountId: plain(session.accountId, "ไม่ทราบ"),
        accountAvatar: session.accountAvatar ?? null,
        guildName: plain(session.serverName, "เซิร์ฟเวอร์ไม่ทราบชื่อ"),
        guildId: plain(session.serverId, "ไม่ทราบ"),
        targetChannelName: plain(session.voiceName, "ช่องเสียงไม่ทราบชื่อ"),
        targetChannelId: plain(session.voiceId, "ไม่ทราบ"),
        ...channelContext,
        verifiedAt,
        outageDurationMs,
        attempts,
        onlineDurationMs,
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
    const view = EVENT_VIEW[snapshot.type] || { color: VOICE_COLORS.warning, title: "🔔 แจ้งเตือนระบบช่องเสียง", status: "ℹ️ มีการเปลี่ยนแปลง" };
    const fields = [
        { name: "📍 สถานะ", value: view.status },
        { name: `${config.emojis?.server_icon || "🏠"} เซิร์ฟเวอร์`, value: formatGuildField(snapshot.guildName, snapshot.guildId), inline: true },
        { name: `${config.emojis?.voice_ch || "🔊"} ช่องเป้าหมาย`, value: formatChannelField(snapshot.targetChannelName, snapshot.targetChannelId, snapshot.guildId), inline: true }
    ];

    if (snapshot.actualChannelId) {
        const verified = snapshot.actualChannelSource === "voice_state";
        fields.push({
            name: verified ? `${config.emojis?.check_alt || config.emojis?.success || "✅"} ช่องที่อ่านจากสถานะเสียง` : `${config.emojis?.alert || "ℹ️"} ช่องจากสถานะการเชื่อมต่อ`,
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
            name: snapshot.type === "VOICE_DISCONNECTED"
                ? `${config.emojis?.status_online || config.emojis?.armed_on || "🟢"} ออนไลน์ต่อเนื่องก่อนหลุด`
                : `${config.emojis?.status_online || config.emojis?.armed_on || "🟢"} ออนไลน์ต่อเนื่องก่อนเหตุการณ์`,
            value: duration(snapshot.onlineDurationMs),
            inline: true
        });
    }
    fields.push({ name: "🧩 รหัสการออน", value: code(getSessionShortId(snapshot.sessionId)), inline: true });
    return buildDmEmbed({
        tone: voiceTone(snapshot.type),
        color: view.color,
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
        timestamp: snapshot.verifiedAt
    });
}

const TRACKER_PHASE_VIEW = Object.freeze({
    starting: {
        tone: "warning",
        color: VOICE_COLORS.warning,
        title: `${config.emojis?.loading_circle || config.emojis?.loading || "🔄"} กำลังกู้คืนช่องเสียงแบบเรียลไทม์`,
        summary: "ระบบกำลังดำเนินการกู้คืนการเชื่อมต่อให้อัตโนมัติ ข้อความนี้จะอัปเดตสถานะแบบเรียลไทม์",
        defaultStatus: `${config.emojis?.loading_circle || config.emojis?.loading || "🔄"} เริ่มกระบวนการกู้คืนและตรวจสอบช่องเสียง...`
    },
    attempt: {
        tone: "warning",
        color: VOICE_COLORS.warning,
        title: `${config.emojis?.loading_circle || config.emojis?.loading || "🔄"} กำลังกู้คืนช่องเสียงแบบเรียลไทม์`,
        summary: "ระบบกำลังดำเนินการกู้คืนการเชื่อมต่อให้อัตโนมัติ ข้อความนี้จะอัปเดตสถานะแบบเรียลไทม์",
        defaultStatus: `${config.emojis?.loading_circle || config.emojis?.loading || "🔄"} กำลังลองเชื่อมต่อเข้าสู่ช่องเสียง...`
    },
    hibernate: {
        tone: "warning",
        color: VOICE_COLORS.warning,
        title: "⏸️ อยู่ในช่วงพักกู้คืนช่องเสียง",
        summary: "ระบบเข้าสู่โหมดพักรอเพื่อป้องกันการถูกจำกัดสัญญาณ และจะเริ่มพยายามใหม่อัตโนมัติเมื่อครบกำหนด",
        defaultStatus: "⏸️ พักรอชั่วคราวก่อนเริ่มรอบถัดไป"
    },
    recovered: {
        tone: "success",
        color: VOICE_COLORS.success,
        title: `${config.emojis?.check_alt || config.emojis?.success || "✅"} กู้คืนการเชื่อมต่อสำเร็จเรียบร้อย`,
        summary: "ระบบกู้คืนการเชื่อมต่อช่องเสียงสำเร็จ และตรวจสอบยืนยันสถานะการออนไลน์ในห้องเสียงเรียบร้อยแล้ว",
        defaultStatus: `${config.emojis?.status_online || config.emojis?.armed_on || "🟢"} ยืนยันแล้วว่าออนไลน์ในช่องเป้าหมาย`
    },
    exhausted: {
        tone: "danger",
        color: VOICE_COLORS.danger,
        title: `${config.emojis?.no_entry || "⛔"} กู้คืนไม่สำเร็จ (สิ้นสุดความพยายาม)`,
        summary: "ระบบลองกู้คืนครบตามจำนวนที่กำหนดแล้ว แต่ยังไม่สามารถเชื่อมต่อได้",
        defaultStatus: "⚫ หยุดแล้วหลังลองเชื่อมต่อครบกำหนด"
    },
    terminal: {
        tone: "danger",
        color: VOICE_COLORS.danger,
        title: `${config.emojis?.stop || "🛑"} ยกเลิกการกู้คืนช่องเสียง`,
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
        color: phaseView.color,
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
        timestamp: Date.now()
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🚀  REGION: RENOVATED CENTRAL LIVE LOG & TERMINAL DM SYSTEM
// ════════════════════════════════════════════════════════════════════════════

function buildTerminalAlertEmbed(type) {
    const crossEmoji = resolveEmoji("error", "<a:CROSS_pmt:1553833049135906816>");
    const titleText = TERMINAL_TITLES[type] || "เกิดข้อผิดพลาดในการเชื่อมต่อช่องเสียง";
    const color = VOICE_COLORS.danger;
    return new MessageEmbed()
        .setColor(color)
        .setTitle(`${crossEmoji} ${titleText}`);
}

async function sendVoiceTerminalDM(ownerId, type, sessionId = null) {
    if (!ownerId) return { status: "skipped", reason: "owner_missing" };
    try {
        const embed = buildTerminalAlertEmbed(type);
        const eventKey = `voice:terminal:${ownerId}:${type}:${sessionId || Date.now()}:${Date.now()}`;
        return await dmService.send({
            eventKey,
            recipientId: String(ownerId),
            category: "voice_terminal",
            priority: "high",
            payload: { embeds: [embed] }
        });
    } catch (error) {
        return { status: "failed", reason: plain(error?.code || error?.message, "UNKNOWN") };
    }
}

function groupSessionsByToken(sessionList) {
    if (!Array.isArray(sessionList)) return [];
    return [...sessionList].sort((a, b) => {
        const tokenA = a.tokenHash || a.accountId || a.sessionId || "";
        const tokenB = b.tokenHash || b.accountId || b.sessionId || "";
        const cmp = String(tokenA).localeCompare(String(tokenB));
        if (cmp !== 0) return cmp;
        const guildA = String(a.serverId || a.guildId || "");
        const guildB = String(b.serverId || b.guildId || "");
        return guildA.localeCompare(guildB);
    });
}

function resolveTroubleStatus(session, loadingEmoji) {
    const rec = session?.recoveryState || {};
    const phase = rec.phase;
    const attempts = Number(rec.attempts || 0);
    const maxAttempts = Number(config.voice_worker?.maxReconnectAttempts || 15);

    if (phase === "hibernate") {
        return "ช่วงพักก่อนลองพยามเชื่อมต่อใหม่";
    }
    if (phase === "attempt" || (attempts > 0 && session?.reconnecting)) {
        return `กำลังกู้คืน ${loadingEmoji} (${attempts}/${maxAttempts})`;
    }
    if (rec.delayed || attempts > 0) {
        return "ระยะเวลาที่รอพยายามเชื่อมต่อ";
    }
    return `กำลังกู้คืน ${loadingEmoji} (${Math.max(1, attempts)}/${maxAttempts})`;
}

function formatSessionLines(onlineSessions = [], troubledSessions = []) {
    const bell = resolveEmoji("bell_pmt", resolveEmoji("bell", "<a:bell_pmt:1559247893343248438>"));
    const g03 = resolveEmoji("g03_pmt", resolveEmoji("status_online", "<a:g03_pmt:1553832998468714516>"));
    const r04fpt = resolveEmoji("r04fpt_pmt", resolveEmoji("status_offline", "<a:r04fpt_pmt:1553833007532474519>"));
    const grej = resolveEmoji("Grej_pmt", resolveEmoji("dot_green", "<:Grej_pmt:1560405771978547340>"));
    const reddj = resolveEmoji("reddj_pmt", resolveEmoji("dot_red", "<:reddj_pmt:1560405803792465940>"));
    const grep = resolveEmoji("Grep_pmt", resolveEmoji("arrow_left_green", "<a:Grep_pmt:1560411233214009454>"));
    const loading = resolveEmoji("loading", "<a:Loadingg_pmt:1553844457856827393>");

    const lines = [
        `# ${bell} Logระบบออนช่องเสียง`,
        `${g03} บัญชีที่กำลังออนอยู่\n`
    ];

    const sortedOnline = groupSessionsByToken(onlineSessions);
    if (sortedOnline.length > 0) {
        for (const s of sortedOnline) {
            const name = plain(s.accountTag || s.accountName || s.accountUsername, "บัญชีไม่ทราบชื่อ");
            const guildId = s.serverId || s.guildId || "";
            const channelId = s.voiceId || s.channelId || "";
            const channelUrl = `https://discord.com/channels/${guildId}/${channelId}`;
            const channelLabel = s.voiceName ? `[${plain(s.voiceName)}](${channelUrl})` : channelUrl;
            lines.push(`${grej} ชื่อบัญชี ${name}${grep} ${channelLabel}`);
        }
    } else {
        lines.push("- ไม่มีรายการ");
    }

    const sortedTroubled = groupSessionsByToken(troubledSessions);
    if (sortedTroubled.length > 0) {
        lines.push("", `${r04fpt} บัญชีที่กำลังเกิดปัญหา\n`);
        for (const s of sortedTroubled) {
            const name = plain(s.accountTag || s.accountName || s.accountUsername, "บัญชีไม่ทราบชื่อ");
            const status = resolveTroubleStatus(s, loading);
            lines.push(`${reddj} ชื่อบัญชี ${name}`, `${grep} ${status}`);
        }
    }

    return lines;
}

function clampDescription(lines, maxDesc = 4096) {
    const summaryReserve = `\n… และอีก ${lines.length} บรรทัด`.length;
    let description = "";
    let omitted = 0;
    for (const line of lines) {
        const candidate = description ? `${description}\n${line}` : line;
        if (candidate.length + summaryReserve > maxDesc) {
            omitted++;
            continue;
        }
        description = candidate;
    }
    if (omitted > 0) description += `\n… และอีก ${omitted} บรรทัด`;
    return description || "ไม่มีข้อมูล";
}

function buildVoiceLogEmbed(onlineSessions = [], troubledSessions = []) {
    const lines = formatSessionLines(onlineSessions, troubledSessions);
    const description = clampDescription(lines, 4096);

    return new MessageEmbed()
        .setColor(VOICE_COLORS.success)
        .setDescription(description);
}

function buildVoiceLogButtonRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_STATUS)
            .setLabel("สถานะ & จัดการ")
            .setEmoji(config.emojis?.ping || "🏓")
            .setStyle("PRIMARY")
    );
}

function getOwnerActiveSessions(ownerId, customMap = null) {
    const all = customMap
        ? Array.from(customMap.values())
        : Array.from(sessionManager.getAllSessions().values());
    const strOwnerId = String(ownerId || "");
    return all.filter(s => {
        if (!s || String(s.ownerId || "") !== strOwnerId) return false;
        if (s.state === "stopped" || s.state === "failed" || s.tokenInvalid === true) return false;
        if (s.recoveryState?.phase === "terminal") return false;
        return true;
    });
}

function categorizeSessions(sessionList) {
    const online = [];
    const troubled = [];
    for (const s of sessionList) {
        const rec = s?.recoveryState || {};
        const isDegraded = rec.phase === "degraded"
            || rec.phase === "attempt"
            || rec.phase === "hibernate"
            || s?.reconnecting === true;

        if (isDegraded) {
            troubled.push(s);
        } else {
            online.push(s);
        }
    }
    return { online, troubled };
}

const ownerLogTrackers = new Map();

function syncVoiceLogDM(ownerId, options = {}) {
    if (!ownerId) return Promise.resolve({ status: "skipped", reason: "owner_missing" });
    const strOwnerId = String(ownerId);
    let tracker = ownerLogTrackers.get(strOwnerId);
    if (!tracker) {
        tracker = {
            ownerId: strOwnerId,
            message: null,
            timer: null,
            inFlight: null,
            waiters: []
        };
        ownerLogTrackers.set(strOwnerId, tracker);
    }

    if (!tracker.waiters) tracker.waiters = [];

    if (tracker.timer) {
        clearTimeout(tracker.timer);
        tracker.timer = null;
    }

    const MAX_WAIT_MS = 2000;
    if (!tracker.waiters.length) tracker.firstQueuedAt = Date.now();
    const waited = Date.now() - Number(tracker.firstQueuedAt || Date.now());
    const delayMs = options.immediate ? 0 : Math.max(0, Math.min(500, MAX_WAIT_MS - waited));
    return new Promise((resolve) => {
        tracker.waiters.push(resolve);
        tracker.timer = setTimeout(() => {
            tracker.timer = null;
            tracker.firstQueuedAt = null;
            const waiters = tracker.waiters.splice(0);
            const done = (r) => {
                for (const w of waiters) {
                    try {
                        w(r);
                    } catch {}
                }
            };
            const prev = tracker.inFlight || Promise.resolve();
            const op = prev
                .catch(() => {})
                .then(() => flushVoiceLogDM(strOwnerId, options))
                .then(done, done);
            tracker.inFlight = op;
        }, delayMs);
        tracker.timer?.unref?.();
    });
}

async function cleanUpEmptyOwnerTracker(tracker, strOwnerId) {
    if (tracker?.message && typeof tracker.message.delete === "function") {
        try {
            await tracker.message.delete().catch(() => {});
        } catch {}
        tracker.message = null;
    }
    if (!tracker?.timer && !(tracker?.waiters?.length)) {
        ownerLogTrackers.delete(strOwnerId);
    }
    return { status: "deleted" };
}

async function flushVoiceLogDM(ownerId, options = {}) {
    const strOwnerId = String(ownerId);
    const activeSessions = getOwnerActiveSessions(strOwnerId, options.allSessions);
    let tracker = ownerLogTrackers.get(strOwnerId);
    if (!tracker && activeSessions.length > 0) {
        tracker = {
            ownerId: strOwnerId,
            message: null,
            timer: null,
            inFlight: null,
            waiters: []
        };
        ownerLogTrackers.set(strOwnerId, tracker);
    }

    if (activeSessions.length === 0) {
        return cleanUpEmptyOwnerTracker(tracker, strOwnerId);
    }

    const { online, troubled } = categorizeSessions(activeSessions);
    const embed = buildVoiceLogEmbed(online, troubled);
    const row = buildVoiceLogButtonRow();
    const payload = {
        embeds: [embed],
        components: [row]
    };

    if (tracker?.message && typeof tracker.message.edit === "function") {
        try {
            await tracker.message.edit(payload);
            return { status: "updated", message: tracker.message };
        } catch {
            tracker.message = null;
        }
    }

    try {
        const eventKey = `voice:log:${strOwnerId}:${Date.now()}`;
        const result = await dmService.send({
            eventKey,
            recipientId: strOwnerId,
            category: "voice_log",
            priority: "high",
            payload
        });
        if (result?.status === "sent" && result.message) {
            if (tracker) tracker.message = result.message;
        }
        return result;
    } catch (err) {
        return { status: "failed", reason: plain(err?.message, "SEND_FAILED") };
    }
}

async function sendVoiceEventDM(snapshot) {
    try {
        if (!snapshot?.ownerId) return { status: "skipped", reason: "owner_missing" };
        if (TERMINAL_TITLES[snapshot.type]) {
            const alertResult = await sendVoiceTerminalDM(snapshot.ownerId, snapshot.type, snapshot.sessionId);
            await syncVoiceLogDM(snapshot.ownerId, { immediate: true });
            return alertResult;
        }
        await syncVoiceLogDM(snapshot.ownerId, { immediate: false });
        return { status: "sent" };
    } catch (error) {
        const errCode = plain(error?.code || error?.name, "UNKNOWN");
        console.error(`[WORKER] ❌ Voice DM failed. session=${sanitizeLogText(snapshot.sessionId)} code=${sanitizeLogText(errCode)}`);
        return { status: "failed", reason: errCode };
    }
}

async function sendVoiceDigestDM(ownerId) {
    syncVoiceLogDM(ownerId).catch(() => {});
    return { status: "sent", reason: "digest_retired" };
}

async function sendVoiceRecoveryTrackerDM(snapshot, trackerState = {}) {
    await syncVoiceLogDM(snapshot.ownerId, { immediate: false });
    return { status: "sent", message: ownerLogTrackers.get(String(snapshot.ownerId))?.message || null };
}

async function editVoiceRecoveryTrackerDM(trackerRef, snapshot, trackerState = {}) {
    await syncVoiceLogDM(snapshot.ownerId, { immediate: false });
    return { status: "updated" };
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
    EVENT_COPY,
    TRACKER_PHASE_VIEW,
    TERMINAL_TITLES,
    createVoiceSnapshot,
    buildVoiceEventEmbed,
    buildVoiceTrackerEmbed,
    buildTerminalAlertEmbed,
    sendVoiceTerminalDM,
    buildVoiceLogEmbed,
    buildVoiceLogButtonRow,
    groupSessionsByToken,
    resolveTroubleStatus,
    getOwnerActiveSessions,
    categorizeSessions,
    ownerLogTrackers,
    syncVoiceLogDM,
    flushVoiceLogDM,
    sendVoiceEventDM,
    sendVoiceDigestDM,
    sendVoiceRecoveryTrackerDM,
    editVoiceRecoveryTrackerDM,
    sendSessionStoppedDM,
    sendTokenInvalidDM,
    sendSessionOnlineDM
};
