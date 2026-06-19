/* eslint-disable complexity -- Audit event handlers are behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: Event listener structure — each listener maps to a specific
audit log channel from LogChannelMapModel.
DO NOT REMOVE: Any event listener — each one serves เฟส 25 requirements.
OVERHAUL v2.0: Added fetchAuditEntry, buildEmbed template, member state cache,
rate-limit queue, and 20+ new events (nickname, timeout, ban/unban, kick,
reaction, pin, invite, sticker, role color, channel perms, guild update,
thread, integration, camera, screen share, self mute/deafen)
================================================================================
*/

const { MessageEmbed } = require("discord.js");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: HELPERS — Cache, Queue, Embed Builder
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal LRU cache backed by a Map.
 * Map preserves insertion order; promoting an entry on access (delete + re-insert)
 * keeps the least-recently-used entry at the front for O(1) eviction.
 */
class LruCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this._map = new Map();
    }

    get size() { return this._map.size; }

    get(key) {
        if (!this._map.has(key)) return undefined;
        // Promote to most-recently-used position
        const value = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    set(key, value) {
        if (this._map.has(key)) this._map.delete(key); // promote
        this._map.set(key, value);
        if (this._map.size > this.maxSize) {
            // Evict least-recently-used (first entry)
            this._map.delete(this._map.keys().next().value);
        }
    }

    has(key) { return this._map.has(key); }

    delete(key) { return this._map.delete(key); }

    entries() { return this._map.entries(); }

    keys() { return this._map.keys(); }
}

// Channel cache (5 min TTL)
const auditChannelCache = new Map(); // guildId → { map, expiry }

// Member state cache for before/after tracking (LRU-evicted, TTL-cleaned)
const MEMBER_STATE_CACHE_MAX = 2000;
const MEMBER_STATE_TTL_MS = 60 * 60 * 1000;
const memberStateCache = new LruCache(MEMBER_STATE_CACHE_MAX); // `${guildId}_${userId}` → { nickname, avatarHash, updatedAt }

// Rate-limit queue per guild (prevents Discord 429 on bulk events)
const sendQueues = new Map(); // guildId → Promise
const sendQueueDepths = new Map(); // guildId → pending sends
const auditCircuit = new Map(); // `${guildId}:${type}` → { failures, openUntil }
const registeredClients = new WeakSet(); // prevent duplicate listener registration after reconnect-ready events
let auditCleanupTimer = null;
const AUDIT_MAX_QUEUE_PER_GUILD = Math.max(1, Number(process.env.AUDIT_MAX_QUEUE_PER_GUILD || 200) || 200);
const AUDIT_CIRCUIT_FAILURES = Math.max(1, Number(process.env.AUDIT_CIRCUIT_FAILURES || 5) || 5);
const AUDIT_CIRCUIT_OPEN_MS = Math.max(10000, Number(process.env.AUDIT_CIRCUIT_OPEN_MS || 60 * 1000) || 60 * 1000);
const LOG_DELETED_MESSAGE_CONTENT = String(process.env.AUDIT_LOG_DELETED_MESSAGE_CONTENT ?? "true").toLowerCase() !== "false";
const LOG_EDITED_MESSAGE_CONTENT = String(process.env.AUDIT_LOG_EDITED_MESSAGE_CONTENT ?? "true").toLowerCase() !== "false";
const AUDIT_REDACT_LINKS = String(process.env.AUDIT_REDACT_LINKS || "").toLowerCase() === "true";
const AUDIT_REDACT_MENTIONS = String(process.env.AUDIT_REDACT_MENTIONS || "").toLowerCase() === "true";
const AUDIT_MAX_CONTENT_LENGTH = Math.max(80, Math.min(1800, Number(process.env.AUDIT_MAX_CONTENT_LENGTH || 800) || 800));
const auditStats = {
    auditSendFailed: 0,
    auditDroppedQueueFull: 0,
    auditDroppedCircuitOpen: 0,
    auditChannelLookupFailed: 0,
    auditFetchFailed: 0,
    lastAuditSendError: null,
    lastAuditChannelError: null,
    lastAuditFetchError: null
};
const warnThrottles = new Map();

function isTokenChar(char) {
    return !!char && (
        (char >= "A" && char <= "Z") ||
        (char >= "a" && char <= "z") ||
        (char >= "0" && char <= "9") ||
        char === "_" ||
        char === "-"
    );
}

function readTokenSegment(text, start) {
    let end = start;
    while (end < text.length && isTokenChar(text[end])) end++;
    return {
        value: text.slice(start, end),
        end
    };
}

function redactDiscordTokenLikeValues(input) {
    const text = String(input || "");
    let output = "";
    let index = 0;

    while (index < text.length) {
        const first = readTokenSegment(text, index);
        const secondStart = first.end + 1;
        const second = text[first.end] === "." ? readTokenSegment(text, secondStart) : null;
        const thirdStart = second ? second.end + 1 : -1;
        const third = second && text[second.end] === "." ? readTokenSegment(text, thirdStart) : null;

        if (first.value.length >= 24 && second?.value.length >= 6 && third?.value.length >= 20) {
            output += "[REDACTED_TOKEN]";
            index = third.end;
            continue;
        }

        output += text[index];
        index++;
    }

    return output;
}

function safeAuditError(err) {
    return redactDiscordTokenLikeValues(err?.message || err?.name || err || "unknown")
        .slice(0, 240);
}

function warnRateLimited(key, message, err, intervalMs = 60000) {
    const now = Date.now();
    const last = warnThrottles.get(key) || 0;
    if (now - last < intervalMs) return;
    warnThrottles.set(key, now);
    console.warn(`${message}: ${safeAuditError(err)}`);
}

// ── Channel lookup ──
async function getAuditChannel(guild, sessionManager, type) {
    try {
        const now = Date.now();
        let cached = auditChannelCache.get(guild.id);
        if (!cached || now > cached.expiry) {
            const map = await sessionManager.getLogChannelMap(guild.id);
            cached = { map, expiry: now + 300000 };
            auditChannelCache.set(guild.id, cached);
        }
        if (!cached.map) return null;
        const channelId = cached.map[`${type}ChannelId`];
        if (!channelId) return null;
        return guild.channels.cache.get(channelId) || null;
    } catch (e) {
        auditStats.auditChannelLookupFailed += 1;
        auditStats.lastAuditChannelError = safeAuditError(e);
        warnRateLimited(`audit-channel:${guild.id}:${type}`, `[AUDIT] ⚠️ Channel lookup failed guild=${guild.id} type=${type}`, e);
        return null;
    }
}

// ── Queued send (prevents 429 on burst events) ──
async function sendAuditLog(guild, sessionManager, type, embed) {
    const gid = guild.id;
    const depth = sendQueueDepths.get(gid) || 0;
    if (depth >= AUDIT_MAX_QUEUE_PER_GUILD) {
        auditStats.auditDroppedQueueFull += 1;
        return false;
    }

    const circuitKey = `${gid}:${type}`;
    const circuit = auditCircuit.get(circuitKey);
    if (circuit?.openUntil && circuit.openUntil > Date.now()) {
        auditStats.auditDroppedCircuitOpen += 1;
        return false;
    }

    sendQueueDepths.set(gid, depth + 1);

    const prev = sendQueues.get(gid) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
        const ch = await getAuditChannel(guild, sessionManager, type);
        if (!ch) return false;

        try {
            await ch.send({ embeds: [embed] });
            auditCircuit.delete(circuitKey);
            return true;
        } catch (err) {
            auditStats.auditSendFailed += 1;
            auditStats.lastAuditSendError = safeAuditError(err);
            const current = auditCircuit.get(circuitKey) || { failures: 0, openUntil: 0 };
            current.failures += 1;
            if (current.failures >= AUDIT_CIRCUIT_FAILURES) {
                current.openUntil = Date.now() + AUDIT_CIRCUIT_OPEN_MS;
            }
            auditCircuit.set(circuitKey, current);
            warnRateLimited(circuitKey, `[AUDIT] ⚠️ Send failed guild=${gid} type=${type}`, err);
            return false;
        }
    });
    sendQueues.set(gid, next);
    next.finally(() => {
        const currentDepth = Math.max(0, (sendQueueDepths.get(gid) || 1) - 1);
        if (currentDepth > 0) sendQueueDepths.set(gid, currentDepth);
        else sendQueueDepths.delete(gid);
        if (sendQueues.get(gid) === next) sendQueues.delete(gid);
    }).catch(() => {});
    return next;
}

// ── Fetch Audit Log entry (delay + filter by target + age) ──
async function fetchAuditEntry(guild, type, targetId, delayMs = 1500) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
        const logs = await guild.fetchAuditLogs({ type, limit: 5 });
        return logs.entries.find(e =>
            e.target?.id === targetId &&
            Date.now() - e.createdTimestamp < 8000
        ) || null;
    } catch (err) {
        auditStats.auditFetchFailed += 1;
        auditStats.lastAuditFetchError = safeAuditError(err);
        warnRateLimited(`audit-fetch:${guild.id}:${type}`, `[AUDIT] ⚠️ fetchAuditLogs failed guild=${guild.id} type=${type}`, err);
        return null;
    }
}

// ── Standard Embed Template (Koya-style) ──
function safeEmbedText(value, max) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, Math.max(0, max - 15))}... [TRUNCATED]` : text;
}

function normalizeEmbedFields(fields = []) {
    return fields
        .filter(field => field?.name !== undefined && field?.value !== undefined)
        .slice(0, 25)
        .map(field => ({
            ...field,
            name: safeEmbedText(field.name, 256) || "-",
            value: safeEmbedText(field.value, 1024) || "-"
        }));
}

function getEmbedTextSize(embed) {
    const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
    const fields = Array.isArray(data.fields) ? data.fields : [];
    return String(data.title || "").length +
        String(data.description || "").length +
        String(data.footer?.text || "").length +
        String(data.author?.name || "").length +
        fields.reduce((sum, field) => sum + String(field.name || "").length + String(field.value || "").length, 0);
}

function fitEmbedTotalSize(embed, maxSize = 5900) {
    let data = typeof embed.toJSON === "function" ? embed.toJSON() : {};
    while (getEmbedTextSize(embed) > maxSize && Array.isArray(data.fields) && data.fields.length > 0) {
        const fields = data.fields;
        const last = fields[fields.length - 1];
        if (String(last.value || "").length > 120) {
            last.value = safeEmbedText(last.value, Math.max(80, String(last.value).length - 300));
            embed.spliceFields(fields.length - 1, 1, last);
        } else {
            embed.spliceFields(fields.length - 1, 1);
        }
        data = embed.toJSON();
    }

    return embed;
}

function serializePermissionOverwrites(overwrites) {
    if (!overwrites) return "";
    return overwrites
        .map(ow => {
            const allow = ow.allow?.bitfield?.toString?.() || String(ow.allow || "0");
            const deny = ow.deny?.bitfield?.toString?.() || String(ow.deny || "0");
            return `${ow.id}:${ow.type}:${allow}:${deny}`;
        })
        .sort()
        .join("|");
}

function buildEmbed({ color, title, user, description, fields = [], footer, noThumb = false }) {
    const embed = new MessageEmbed().setColor(color).setTitle(safeEmbedText(title, 256));
    if (description) embed.setDescription(safeEmbedText(description, 4096));
    if (user && !noThumb) {
        const avatarUrl = user.displayAvatarURL?.({ dynamic: true, size: 128 })
            || user.defaultAvatarURL;
        embed.setAuthor({ name: user.tag || user.username, iconURL: avatarUrl });
        embed.setThumbnail(avatarUrl);
    }
    const safeFields = normalizeEmbedFields(fields);
    if (safeFields.length > 0) embed.addFields(safeFields);
    embed.setFooter({ text: safeEmbedText(footer || "Phomueangtai Enterprise", 2048) });
    embed.setTimestamp();
    return fitEmbedTotalSize(embed);
}

// ── Member state cache helpers ──
function cacheMember(member) {
    const key = `${member.guild.id}_${member.id}`;

    if (memberStateCache.has(key)) memberStateCache.delete(key);

    memberStateCache.set(key, {
        nickname:   member.nickname,
        avatarHash: member.avatar,
        updatedAt:  Date.now()
    });

    if (memberStateCache.size > MEMBER_STATE_CACHE_MAX) {
        const oldestKey = memberStateCache.keys().next().value;
        if (oldestKey) memberStateCache.delete(oldestKey);
    }
}
function getCachedMember(guildId, userId) {
    const key = `${guildId}_${userId}`;
    const cached = memberStateCache.get(key) || null;

    if (!cached) return null;

    memberStateCache.delete(key);
    const refreshed = { ...cached, updatedAt: Date.now() };
    memberStateCache.set(key, refreshed);

    return refreshed;
}


function cleanupAuditCaches() {
    const now = Date.now();

    for (const [key, value] of memberStateCache.entries()) {
        if (!value?.updatedAt || now - value.updatedAt > MEMBER_STATE_TTL_MS) {
            memberStateCache.delete(key);
        }
    }

    for (const [guildId, cached] of auditChannelCache.entries()) {
        if (!cached?.expiry || now > cached.expiry + 60000) {
            auditChannelCache.delete(guildId);
        }
    }
}

function startAuditCleanup() {
    if (auditCleanupTimer) return;

    auditCleanupTimer = setInterval(cleanupAuditCaches, 5 * 60 * 1000);
    auditCleanupTimer.unref?.();
}

function stopAuditCleanup() {
    if (!auditCleanupTimer) return;
    clearInterval(auditCleanupTimer);
    auditCleanupTimer = null;
}

function getAuditStats() {
    return {
        auditChannelCache: auditChannelCache.size,
        memberStateCache: memberStateCache.size,
        sendQueues: sendQueues.size,
        sendQueueDepths: Object.fromEntries(sendQueueDepths),
        auditCircuitOpen: [...auditCircuit.values()].filter(item => item.openUntil > Date.now()).length,
        cleanupTimerActive: !!auditCleanupTimer,
        ...auditStats
    };
}

// ── Truncate long strings ──
function trunc(str, max = 1000) {
    if (!str) return "*ว่างเปล่า*";
    return str.length > max ? str.substring(0, max) + "..." : str;
}

function redactAuditContent(value) {
    let text = String(value ?? "");
    if (AUDIT_REDACT_LINKS) {
        text = text.replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
    }
    if (AUDIT_REDACT_MENTIONS) {
        text = text
            .replace(/<@!?\d+>/g, "[REDACTED_MENTION]")
            .replace(/<@&\d+>/g, "[REDACTED_ROLE]")
            .replace(/<#\d+>/g, "[REDACTED_CHANNEL]");
    }
    return text;
}

function formatAuditMessageContent(value, kind) {
    const shouldLog = kind === "delete" ? LOG_DELETED_MESSAGE_CONTENT : LOG_EDITED_MESSAGE_CONTENT;
    if (!shouldLog) return "*ซ่อนเนื้อหาตามการตั้งค่า audit*";
    return trunc(redactAuditContent(value), AUDIT_MAX_CONTENT_LENGTH);
}


// ── Partial-safe helpers for message/reaction audit events ──
async function resolvePartial(value) {
    if (value?.partial && typeof value.fetch === "function") {
        return await value.fetch().catch(() => value);
    }

    return value;
}

function getMessageGuild(message) {
    return message?.guild || message?.channel?.guild || null;
}

function getChannelId(message) {
    return message?.channel?.id || message?.channelId || null;
}

function getChannelLabel(message) {
    const channelId = getChannelId(message);
    return channelId ? `<#${channelId}> (\`${channelId}\`)` : "ไม่ทราบห้อง";
}

function getUserFieldValue(user) {
    return user?.id ? `<@${user.id}> (\`${user.id}\`)` : "ไม่ทราบผู้ใช้";
}

function getMessageLink(message, guild) {
    if (message?.url) return message.url;

    const channelId = getChannelId(message);
    if (guild?.id && channelId && message?.id) {
        return `https://discord.com/channels/${guild.id}/${channelId}/${message.id}`;
    }

    return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  📝  REGION 2: MESSAGE EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerMessageEvents(client, sessionManager) {
    const config = require("./config.json");

    // กัน messageDelete ซ้ำหลัง bulk
    const recentBulkChannels = new Map();

    // ── ลบข้อความ ──
    client.on("messageDelete", async (message) => {
        message = await resolvePartial(message);
        const guild = getMessageGuild(message);
        if (!guild) return;

        const author = message.author || null;
        if (author?.bot) return;

        const channelId = getChannelId(message);
        const bulkTs = channelId ? recentBulkChannels.get(channelId) : null;
        if (bulkTs && Date.now() - bulkTs < 3000) return;

        // ลองดึงว่าใครลบ (ถ้าไม่ใช่เจ้าของ)
        let deleter = null;
        try {
            if (author?.id) {
                const entry = await fetchAuditEntry(guild, "MESSAGE_DELETE", author.id);
                if (entry && (!channelId || entry.extra?.channel?.id === channelId)) {
                    deleter = entry.executor;
                }
            }
        } catch {}

        const fields = [
            { name: "👤 ผู้ส่ง",    value: getUserFieldValue(author), inline: true },
            { name: "📌 ห้อง",      value: getChannelLabel(message), inline: true },
            { name: "🆔 Message ID", value: message.id ? `\`${message.id}\`` : "ไม่ทราบ", inline: true },
        ];

        if (message.content) fields.push({ name: "📄 เนื้อหา", value: formatAuditMessageContent(message.content, "delete"), inline: false });
        else fields.push({ name: "📄 เนื้อหา", value: "*ไม่มีข้อมูลในแคชหรือดึงไม่ได้*", inline: false });

        if (message.attachments?.size > 0) fields.push({ name: "📎 ไฟล์แนบ", value: `${message.attachments.size} ไฟล์`, inline: true });
        if (deleter && deleter.id !== author?.id) fields.push({ name: "🗑️ ลบโดย", value: `<@${deleter.id}> (\`${deleter.tag}\`)`, inline: true });

        const footerTime = message.createdTimestamp
            ? new Date(message.createdTimestamp).toLocaleString("th-TH")
            : "ไม่ทราบเวลาเดิม";

        const embed = buildEmbed({
            color:       config.system.themeColors.error,
            title:       `${config.emojis.trash} ข้อความถูกลบ`,
            user:        author,
            fields,
            footer:      `ส่งเมื่อ ${footerTime}`
        });

        await sendAuditLog(guild, sessionManager, "message", embed);
    });

    // ── แก้ไขข้อความ ──
    client.on("messageUpdate", async (oldMsg, newMsg) => {
        oldMsg = await resolvePartial(oldMsg);
        newMsg = await resolvePartial(newMsg);

        const guild = getMessageGuild(newMsg) || getMessageGuild(oldMsg);
        if (!guild) return;

        const author = newMsg.author || oldMsg.author || null;
        if (author?.bot) return;

        const oldContent = oldMsg.content ?? null;
        const newContent = newMsg.content ?? null;
        if (oldContent != null && newContent != null && oldContent === newContent) return;

        const link = getMessageLink(newMsg, guild);
        const fields = [
            { name: "👤 ผู้ส่ง",    value: getUserFieldValue(author), inline: true },
            { name: "📌 ห้อง",      value: getChannelLabel(newMsg), inline: true },
            { name: "🆔 Message ID", value: newMsg.id ? `\`${newMsg.id}\`` : "ไม่ทราบ", inline: true },
            { name: "📄 ก่อน",      value: formatAuditMessageContent(oldContent || "*ไม่มีข้อมูลเดิม*", "edit"), inline: false },
            { name: "✏️ หลัง",      value: formatAuditMessageContent(newContent || "*ไม่มีข้อมูลใหม่*", "edit"), inline: false }
        ];

        if (link) fields.push({ name: "🔗 ลิงก์", value: `[Jump to Message](${link})`, inline: true });

        const embed = buildEmbed({
            color:  config.system.themeColors.warning,
            title:  `${config.emojis.pencil} ข้อความถูกแก้ไข`,
            user:   author,
            fields
        });

        await sendAuditLog(guild, sessionManager, "message", embed);
    });

    // ── Bulk Delete ──
    client.on("messageDeleteBulk", async (messages) => {
        const first = messages.first();
        if (!first?.guild) return;
        recentBulkChannels.set(first.channel.id, Date.now());
        setTimeout(() => recentBulkChannels.delete(first.channel.id), 3000);

        // ดึงว่าใคร Clear
        let executor = null;
        try {
            const entry = await fetchAuditEntry(first.guild, "MESSAGE_BULK_DELETE", first.channel.id, 1000);
            if (entry) executor = entry.executor;
        } catch {}

        const fields = [
            { name: "📌 ห้อง",   value: `<#${first.channel.id}> (\`${first.channel.id}\`)`, inline: true },
            { name: "🔢 จำนวน", value: `${messages.size} ข้อความ`, inline: true },
        ];
        if (executor) fields.push({ name: "🗑️ ลบโดย", value: `<@${executor.id}> (\`${executor.tag}\`)`, inline: true });

        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   `${config.emojis.broom} ลบข้อความหมู่ (Bulk Delete)`,
            fields,
            noThumb: true
        });

        await sendAuditLog(first.guild, sessionManager, "message", embed);
    });

    // ── Pin/Unpin ──
    client.on("channelPinsUpdate", async (channel, time) => {
        if (!channel.guild) return;
        await new Promise(r => setTimeout(r, 1500));

        let executor = null, action = "เปลี่ยนแปลง Pin";
        try {
            const logs = await channel.guild.fetchAuditLogs({ limit: 3 });
            const entry = logs.entries.find(e =>
                (e.action === "MESSAGE_PIN" || e.action === "MESSAGE_UNPIN") &&
                e.extra?.channel?.id === channel.id &&
                Date.now() - e.createdTimestamp < 8000
            );
            if (entry) {
                executor = entry.executor;
                action   = entry.action === "MESSAGE_PIN" ? "📌 Pin ข้อความ" : "📌 Unpin ข้อความ";
            }
        } catch {}

        const fields = [
            { name: "📌 ห้อง", value: `<#${channel.id}>`, inline: true },
        ];
        if (executor) fields.push({ name: "👤 โดย", value: `<@${executor.id}>`, inline: true });

        const embed = buildEmbed({
            color:   config.system.themeColors.info,
            title:   action,
            fields,
            noThumb: true
        });

        await sendAuditLog(channel.guild, sessionManager, "message", embed);
    });

    // ── Reaction เพิ่ม ──
    client.on("messageReactionAdd", async (reaction, user) => {
        if (user?.bot) return;

        reaction = await resolvePartial(reaction);
        const msg = await resolvePartial(reaction.message);
        const guild = getMessageGuild(msg);
        if (!guild) return;

        const link = getMessageLink(msg, guild);
        const fields = [
            { name: "👤 ผู้กด",      value: getUserFieldValue(user), inline: true },
            { name: "📌 ห้อง",       value: getChannelLabel(msg), inline: true },
            { name: "😀 Reaction",  value: `${reaction.emoji}`, inline: true },
            { name: "🆔 Message ID", value: msg.id ? `\`${msg.id}\`` : "ไม่ทราบ", inline: true }
        ];

        if (link) fields.push({ name: "🔗 ลิงก์", value: `[Jump](${link})`, inline: true });

        const embed = buildEmbed({
            color:  config.system.themeColors.success,
            title:  "➕ Reaction เพิ่ม",
            user,
            fields
        });

        await sendAuditLog(guild, sessionManager, "message", embed);
    });

    // ── Reaction ลบ ──
    client.on("messageReactionRemove", async (reaction, user) => {
        if (user?.bot) return;

        reaction = await resolvePartial(reaction);
        const msg = await resolvePartial(reaction.message);
        const guild = getMessageGuild(msg);
        if (!guild) return;

        const embed = buildEmbed({
            color:  config.system.themeColors.warning,
            title:  "➖ Reaction ลบ",
            user,
            fields: [
                { name: "👤 ผู้ลบ",     value: getUserFieldValue(user), inline: true },
                { name: "📌 ห้อง",      value: getChannelLabel(msg), inline: true },
                { name: "😀 Reaction", value: `${reaction.emoji}`, inline: true },
                { name: "🆔 Message ID", value: msg.id ? `\`${msg.id}\`` : "ไม่ทราบ", inline: true }
            ]
        });

        await sendAuditLog(guild, sessionManager, "message", embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  👥  REGION 3: MEMBER EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerMemberEvents(client, sessionManager) {
    const config = require("./config.json");

    // ── สมาชิกเข้า ──
    client.on("guildMemberAdd", async (member) => {
        if (member.user.bot) return; // handled by security
        const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
        const isNew   = ageDays < config.risk_thresholds.newAccountAgeDays;

        const embed = buildEmbed({
            color:  isNew ? config.system.themeColors.error : config.system.themeColors.success,
            title:  `${config.emojis.success} สมาชิกใหม่เข้าร่วม`,
            user:   member.user,
            fields: [
                { name: "👤 ผู้ใช้",       value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
                { name: "🏷️ Tag",           value: `\`${member.user.tag}\``, inline: true },
                { name: "🎂 สร้างบัญชีเมื่อ", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                ...(isNew ? [{ name: `${config.emojis.warning} ⚠️ บัญชีใหม่มาก`, value: `${ageDays} วัน — HIGH RISK`, inline: true }] : [])
            ]
        });

        cacheMember(member);
        await sendAuditLog(member.guild, sessionManager, "member", embed);
    });

    // ── สมาชิกออก / ถูก Kick ──
    client.on("guildMemberRemove", async (member) => {
        if (member.user.bot) return;

        // ลองดู Audit Log ว่าถูก Kick ไหม
        let kicker = null;
        try {
            const entry = await fetchAuditEntry(member.guild, "MEMBER_KICK", member.id);
            if (entry) kicker = entry.executor;
        } catch {}

        const joinedTs = member.joinedTimestamp
            ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
            : "ไม่ทราบ";

        const fields = [
            { name: "👤 ผู้ใช้",      value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
            { name: "🏷️ Tag",          value: `\`${member.user.tag}\``, inline: true },
            { name: "📅 เข้าร่วมเมื่อ", value: joinedTs, inline: true }
        ];
        if (kicker) {
            fields.push({ name: "👢 ถูก Kick โดย", value: `<@${kicker.id}> (\`${kicker.tag}\`)`, inline: true });
        }

        const embed = buildEmbed({
            color:  kicker ? config.system.themeColors.error : config.system.themeColors.warning,
            title:  kicker ? `${config.emojis.error} สมาชิกถูก Kick` : `${config.emojis.wave} สมาชิกออกจากเซิร์ฟเวอร์`,
            user:   member.user,
            fields
        });

        await sendAuditLog(member.guild, sessionManager, "member", embed);
    });

    // ── Ban ──
    client.on("guildBanAdd", async (ban) => {
        const entry = await fetchAuditEntry(ban.guild, "MEMBER_BAN_ADD", ban.user.id);

        const embed = buildEmbed({
            color:  config.system.themeColors.error,
            title:  `🔨 สมาชิกถูก Ban`,
            user:   ban.user,
            fields: [
                { name: "👤 ผู้ถูก Ban",  value: `<@${ban.user.id}> (\`${ban.user.id}\`)`, inline: true },
                { name: "🏷️ Tag",         value: `\`${ban.user.tag}\``, inline: true },
                { name: "📋 เหตุผล",      value: ban.reason || "ไม่ระบุ", inline: true },
                ...(entry ? [{ name: "🔨 Ban โดย", value: `<@${entry.executor.id}> (\`${entry.executor.tag}\`)`, inline: true }] : [])
            ]
        });

        await sendAuditLog(ban.guild, sessionManager, "member", embed);
    });

    // ── Unban ──
    client.on("guildBanRemove", async (ban) => {
        const entry = await fetchAuditEntry(ban.guild, "MEMBER_BAN_REMOVE", ban.user.id);

        const embed = buildEmbed({
            color:  config.system.themeColors.success,
            title:  `✅ Ban ถูกยกเลิก (Unban)`,
            user:   ban.user,
            fields: [
                { name: "👤 ผู้ถูก Unban", value: `<@${ban.user.id}> (\`${ban.user.id}\`)`, inline: true },
                { name: "🏷️ Tag",           value: `\`${ban.user.tag}\``, inline: true },
                ...(entry ? [{ name: "✅ Unban โดย", value: `<@${entry.executor.id}> (\`${entry.executor.tag}\`)`, inline: true }] : [])
            ]
        });

        await sendAuditLog(ban.guild, sessionManager, "member", embed);
    });

    // ── Member Update (Role / Nickname / Timeout / Avatar) ──
    client.on("guildMemberUpdate", async (oldMember, newMember) => {
        const addedRoles   = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
        const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
        const nickChanged  = oldMember.nickname !== newMember.nickname;
        const oldTimeout   = oldMember.communicationDisabledUntilTimestamp;
        const newTimeout   = newMember.communicationDisabledUntilTimestamp;
        const timeoutChanged = oldTimeout !== newTimeout;
        const avatarChanged  = oldMember.avatar !== newMember.avatar;

        // ── ยศเปลี่ยน ──
        if (addedRoles.size > 0 || removedRoles.size > 0) {
            const entry = await fetchAuditEntry(newMember.guild, "MEMBER_ROLE_UPDATE", newMember.id);
            const fields = [
                { name: "👤 สมาชิก", value: `<@${newMember.id}> (\`${newMember.id}\`)`, inline: true },
                ...(entry ? [{ name: "👮 โดย", value: `<@${entry.executor.id}>`, inline: true }] : []),
                ...(addedRoles.size > 0 ? [{ name: "✅ เพิ่มยศ", value: addedRoles.map(r => r.toString()).join(", "), inline: false }] : []),
                ...(removedRoles.size > 0 ? [{ name: "❌ ลบยศ", value: removedRoles.map(r => r.toString()).join(", "), inline: false }] : [])
            ];

            const embed = buildEmbed({
                color:  config.system.themeColors.info,
                title:  `${config.emojis.role_icon} ยศสมาชิกเปลี่ยน`,
                user:   newMember.user,
                fields
            });
            await sendAuditLog(newMember.guild, sessionManager, "member", embed);
        }

        // ── Nickname เปลี่ยน ──
        if (nickChanged) {
            const entry = await fetchAuditEntry(newMember.guild, "MEMBER_UPDATE", newMember.id);
            const embed = buildEmbed({
                color:  config.system.themeColors.warning,
                title:  "✏️ Nickname เปลี่ยน",
                user:   newMember.user,
                fields: [
                    { name: "👤 สมาชิก", value: `<@${newMember.id}> (\`${newMember.id}\`)`, inline: true },
                    ...(entry ? [{ name: "👮 โดย", value: `<@${entry.executor.id}>`, inline: true }] : []),
                    { name: "📛 ก่อน",  value: `\`${oldMember.nickname || "*ไม่มี*"}\``, inline: false },
                    { name: "📛 หลัง",  value: `\`${newMember.nickname || "*ไม่มี*"}\``, inline: false }
                ]
            });
            await sendAuditLog(newMember.guild, sessionManager, "member", embed);
        }

        // ── Timeout เปลี่ยน ──
        if (timeoutChanged) {
            const isAdded = newTimeout && newTimeout > Date.now();
            const embed = buildEmbed({
                color:  isAdded ? config.system.themeColors.error : config.system.themeColors.success,
                title:  isAdded ? `⏱️ Timeout เพิ่ม` : `⏱️ Timeout หมดอายุ/ถูกยกเลิก`,
                user:   newMember.user,
                fields: [
                    { name: "👤 สมาชิก",     value: `<@${newMember.id}> (\`${newMember.id}\`)`, inline: true },
                    ...(isAdded ? [{ name: "⏰ หมดอายุ", value: `<t:${Math.floor(newTimeout / 1000)}:R>`, inline: true }] : [])
                ]
            });
            await sendAuditLog(newMember.guild, sessionManager, "member", embed);
        }

        // ── Avatar เปลี่ยน (Server Avatar) ──
        if (avatarChanged && newMember.avatar) {
            const embed = buildEmbed({
                color:  config.system.themeColors.info,
                title:  "🖼️ Server Avatar เปลี่ยน",
                user:   newMember.user,
                fields: [
                    { name: "👤 สมาชิก", value: `<@${newMember.id}> (\`${newMember.id}\`)`, inline: true }
                ]
            });
            embed.setImage(newMember.displayAvatarURL({ dynamic: true, size: 256 }));
            await sendAuditLog(newMember.guild, sessionManager, "member", embed);
        }

        // อัปเดต cache
        cacheMember(newMember);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  REGION 4: VOICE EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerVoiceEvents(client, sessionManager) {
    const config = require("./config.json");

    client.on("voiceStateUpdate", async (oldState, newState) => {
        const member = newState.member || oldState.member;
        if (!member || member.user.bot) return;

        const user = member.user;

        // ── เข้าห้อง ──
        if (!oldState.channelId && newState.channelId) {
            const embed = buildEmbed({
                color:  config.system.themeColors.success,
                title:  `${config.emojis.voice_ch} เข้าห้องเสียง`,
                user,
                fields: [
                    { name: "👤 ผู้ใช้",   value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
                    { name: "🔊 ห้อง",    value: `<#${newState.channelId}> (\`${newState.channelId}\`)`, inline: true }
                ]
            });
            return sendAuditLog(newState.guild, sessionManager, "voice", embed);
        }

        // ── ออกห้อง ──
        if (oldState.channelId && !newState.channelId) {
            const embed = buildEmbed({
                color:  config.system.themeColors.error,
                title:  `${config.emojis.voice_leave} ออกจากห้องเสียง`,
                user,
                fields: [
                    { name: "👤 ผู้ใช้",   value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
                    { name: "🔇 ห้องเดิม", value: `<#${oldState.channelId}> (\`${oldState.channelId}\`)`, inline: true }
                ]
            });
            return sendAuditLog(oldState.guild, sessionManager, "voice", embed);
        }

        // ── ย้ายห้อง ──
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            const embed = buildEmbed({
                color:  config.system.themeColors.info,
                title:  `${config.emojis.voice_move} ย้ายห้องเสียง`,
                user,
                fields: [
                    { name: "👤 ผู้ใช้",    value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
                    { name: "📤 จากห้อง",   value: `<#${oldState.channelId}> (\`${oldState.channelId}\`)`, inline: true },
                    { name: "📥 ไปห้อง",   value: `<#${newState.channelId}> (\`${newState.channelId}\`)`, inline: true }
                ]
            });
            return sendAuditLog(newState.guild, sessionManager, "voice", embed);
        }

        // ── รวม micro-state changes (mute/deaf/cam/stream) ──
        const changes = [];

        if (!oldState.serverMute && newState.serverMute)    changes.push({ emoji: "🔇", text: "ถูก Server Mute",       color: config.system.themeColors.error });
        if (oldState.serverMute  && !newState.serverMute)   changes.push({ emoji: "🔊", text: "ยกเลิก Server Mute",    color: config.system.themeColors.success });
        if (!oldState.serverDeaf && newState.serverDeaf)    changes.push({ emoji: "🔕", text: "ถูก Server Deafen",      color: config.system.themeColors.error });
        if (oldState.serverDeaf  && !newState.serverDeaf)   changes.push({ emoji: "🔔", text: "ยกเลิก Server Deafen",  color: config.system.themeColors.success });
        if (!oldState.selfMute   && newState.selfMute)      changes.push({ emoji: "🎤", text: "Self Mute เปิด",         color: config.system.themeColors.warning });
        if (oldState.selfMute    && !newState.selfMute)     changes.push({ emoji: "🎤", text: "Self Mute ปิด",          color: config.system.themeColors.success });
        if (!oldState.selfDeaf   && newState.selfDeaf)      changes.push({ emoji: "🎧", text: "Self Deafen เปิด",       color: config.system.themeColors.warning });
        if (oldState.selfDeaf    && !newState.selfDeaf)     changes.push({ emoji: "🎧", text: "Self Deafen ปิด",        color: config.system.themeColors.success });
        if (!oldState.selfVideo  && newState.selfVideo)     changes.push({ emoji: "📷", text: "เปิดกล้อง (Camera)",     color: config.system.themeColors.info });
        if (oldState.selfVideo   && !newState.selfVideo)    changes.push({ emoji: "📷", text: "ปิดกล้อง (Camera)",      color: config.system.themeColors.warning });
        if (!oldState.streaming  && newState.streaming)     changes.push({ emoji: "🖥️", text: "เริ่ม Screen Share",      color: config.system.themeColors.info });
        if (oldState.streaming   && !newState.streaming)    changes.push({ emoji: "🖥️", text: "หยุด Screen Share",       color: config.system.themeColors.warning });

        for (const ch of changes) {
            const embed = buildEmbed({
                color:  ch.color,
                title:  `${ch.emoji} ${ch.text}`,
                user,
                fields: [
                    { name: "👤 ผู้ใช้", value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
                    { name: "🔊 ห้อง",  value: newState.channelId ? `<#${newState.channelId}>` : "ไม่ได้อยู่ในห้อง", inline: true }
                ]
            });
            await sendAuditLog(newState.guild, sessionManager, "voice", embed);
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 5: SERVER EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerServerEvents(client, sessionManager) {
    const config = require("./config.json");

    // ── ห้องถูกสร้าง ──
    client.on("channelCreate", async (channel) => {
        if (!channel.guild) return;
        const entry = await fetchAuditEntry(channel.guild, "CHANNEL_CREATE", channel.id);

        const embed = buildEmbed({
            color:   config.system.themeColors.success,
            title:   `${config.emojis.plus} ห้องใหม่ถูกสร้าง`,
            noThumb: true,
            fields: [
                { name: "📌 ชื่อ",        value: `\`${channel.name}\``, inline: true },
                { name: "📂 ประเภท",       value: `\`${channel.type}\``, inline: true },
                { name: "🆔 Channel ID",   value: `\`${channel.id}\``, inline: true },
                ...(entry ? [{ name: "👤 สร้างโดย", value: `<@${entry.executor.id}>`, inline: true }] : [])
            ]
        });
        await sendAuditLog(channel.guild, sessionManager, "server", embed);
    });

    // ── ห้องถูกลบ ──
    client.on("channelDelete", async (channel) => {
        if (!channel.guild) return;
        const entry = await fetchAuditEntry(channel.guild, "CHANNEL_DELETE", channel.id);

        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   `${config.emojis.trash} ห้องถูกลบ`,
            noThumb: true,
            fields: [
                { name: "📌 ชื่อ",       value: `\`${channel.name}\``, inline: true },
                { name: "📂 ประเภท",      value: `\`${channel.type}\``, inline: true },
                { name: "🆔 Channel ID",  value: `\`${channel.id}\``, inline: true },
                ...(entry ? [{ name: "👤 ลบโดย", value: `<@${entry.executor.id}>`, inline: true }] : [])
            ]
        });
        await sendAuditLog(channel.guild, sessionManager, "server", embed);
    });

    // ── ห้องถูกแก้ไข (Permission / ชื่อ) ──
    client.on("channelUpdate", async (oldChannel, newChannel) => {
        if (!newChannel.guild) return;

        const changes = [];

        // ชื่อเปลี่ยน
        if (oldChannel.name !== newChannel.name) {
            changes.push({ name: "📛 ชื่อ", value: `\`${oldChannel.name}\` → \`${newChannel.name}\`` });
        }

        // Permission overwrites เปลี่ยน
        const oldPerms = oldChannel.permissionOverwrites?.cache;
        const newPerms = newChannel.permissionOverwrites?.cache;
        if (oldPerms && newPerms && serializePermissionOverwrites(oldPerms) !== serializePermissionOverwrites(newPerms)) {
            changes.push({ name: "🔒 Permission Overwrite", value: `เปลี่ยนจาก ${oldPerms.size} รายการ เป็น ${newPerms.size} รายการ` });
        }

        if (changes.length === 0) return;

        const entry = await fetchAuditEntry(newChannel.guild, "CHANNEL_UPDATE", newChannel.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.warning,
            title:   `⚙️ ห้องถูกแก้ไข`,
            noThumb: true,
            fields: [
                { name: "📌 ห้อง",     value: `<#${newChannel.id}> (\`${newChannel.id}\`)`, inline: true },
                ...(entry ? [{ name: "👤 แก้ไขโดย", value: `<@${entry.executor.id}>`, inline: true }] : []),
                ...changes.map(c => ({ name: c.name, value: c.value, inline: false }))
            ]
        });
        await sendAuditLog(newChannel.guild, sessionManager, "server", embed);
    });

    // ── ยศถูกสร้าง ──
    client.on("roleCreate", async (role) => {
        const entry = await fetchAuditEntry(role.guild, "ROLE_CREATE", role.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.success,
            title:   `${config.emojis.role_icon} ยศใหม่ถูกสร้าง`,
            noThumb: true,
            fields: [
                { name: "🎭 ชื่อ",    value: `\`${role.name}\``, inline: true },
                { name: "🎨 สี",      value: role.hexColor !== "#000000" ? `\`${role.hexColor}\`` : "ไม่มีสี", inline: true },
                { name: "🆔 Role ID", value: `\`${role.id}\``, inline: true },
                ...(entry ? [{ name: "👤 สร้างโดย", value: `<@${entry.executor.id}>`, inline: true }] : [])
            ]
        });
        await sendAuditLog(role.guild, sessionManager, "server", embed);
    });

    // ── ยศถูกลบ ──
    client.on("roleDelete", async (role) => {
        const entry = await fetchAuditEntry(role.guild, "ROLE_DELETE", role.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   `${config.emojis.trash} ยศถูกลบ`,
            noThumb: true,
            fields: [
                { name: "🎭 ชื่อ",    value: `\`${role.name}\``, inline: true },
                { name: "🎨 สีเดิม",  value: role.hexColor !== "#000000" ? `\`${role.hexColor}\`` : "ไม่มีสี", inline: true },
                { name: "🆔 Role ID", value: `\`${role.id}\``, inline: true },
                ...(entry ? [{ name: "👤 ลบโดย", value: `<@${entry.executor.id}>`, inline: true }] : [])
            ]
        });
        await sendAuditLog(role.guild, sessionManager, "server", embed);
    });

    // ── ยศถูกแก้ไข (Color / Perms / Hoist / Mentionable) ──
    client.on("roleUpdate", async (oldRole, newRole) => {
        const changes = [];

        if (oldRole.name !== newRole.name)
            changes.push({ name: "📛 ชื่อ", value: `\`${oldRole.name}\` → \`${newRole.name}\`` });

        if (oldRole.color !== newRole.color)
            changes.push({ name: "🎨 สี", value: `\`${oldRole.hexColor}\` → \`${newRole.hexColor}\`` });

        if (oldRole.hoist !== newRole.hoist)
            changes.push({ name: "📌 แสดงแยก (Hoist)", value: `\`${oldRole.hoist}\` → \`${newRole.hoist}\`` });

        if (oldRole.mentionable !== newRole.mentionable)
            changes.push({ name: "🔔 Mention ได้", value: `\`${oldRole.mentionable}\` → \`${newRole.mentionable}\`` });

        // Permission bits
        const oldBit = oldRole.permissions.bitfield;
        const newBit = newRole.permissions.bitfield;
        if (oldBit !== newBit) {
            const added   = newRole.permissions.toArray().filter(p => !oldRole.permissions.has(p));
            const removed = oldRole.permissions.toArray().filter(p => !newRole.permissions.has(p));
            // รวม permission เพิ่ม/ลด ถ้าไม่เกิน 10 รายการ
            if (added.length > 0)   changes.push({ name: "✅ Permission เพิ่ม", value: added.slice(0, 10).map(p => `\`${p}\``).join(", ") });
            if (removed.length > 0) changes.push({ name: "❌ Permission ลด",   value: removed.slice(0, 10).map(p => `\`${p}\``).join(", ") });
        }

        if (changes.length === 0) return;

        const entry = await fetchAuditEntry(newRole.guild, "ROLE_UPDATE", newRole.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.warning,
            title:   `${config.emojis.role_icon} ยศถูกแก้ไข`,
            noThumb: true,
            fields: [
                { name: "🎭 ยศ",     value: `\`${newRole.name}\` (\`${newRole.id}\`)`, inline: true },
                ...(entry ? [{ name: "👤 แก้ไขโดย", value: `<@${entry.executor.id}>`, inline: true }] : []),
                ...changes.map(c => ({ name: c.name, value: c.value, inline: false }))
            ]
        });
        await sendAuditLog(newRole.guild, sessionManager, "server", embed);
    });

    // ── อิโมจิเพิ่ม ──
    client.on("emojiCreate", async (emoji) => {
        const entry = await fetchAuditEntry(emoji.guild, "EMOJI_CREATE", emoji.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.success,
            title:   `${config.emojis.emoji_icon} อิโมจิใหม่ถูกเพิ่ม`,
            noThumb: true,
            fields: [
                { name: "😀 ชื่อ",    value: `\`${emoji.name}\``, inline: true },
                { name: "🆔 Emoji ID", value: `\`${emoji.id}\``, inline: true },
                ...(entry ? [{ name: "👤 เพิ่มโดย", value: `<@${entry.executor.id}>`, inline: true }] : [])
            ]
        });
        if (emoji.url) embed.setThumbnail(emoji.url);
        await sendAuditLog(emoji.guild, sessionManager, "server", embed);
    });

    // ── อิโมจิถูกลบ ──
    client.on("emojiDelete", async (emoji) => {
        const entry = await fetchAuditEntry(emoji.guild, "EMOJI_DELETE", emoji.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   `${config.emojis.trash} อิโมจิถูกลบ`,
            noThumb: true,
            fields: [
                { name: "😀 ชื่อ",    value: `\`${emoji.name}\``, inline: true },
                { name: "🆔 Emoji ID", value: `\`${emoji.id}\``, inline: true },
                ...(entry ? [{ name: "👤 ลบโดย", value: `<@${entry.executor.id}>`, inline: true }] : [])
            ]
        });
        await sendAuditLog(emoji.guild, sessionManager, "server", embed);
    });

    // ── เซิร์ฟเวอร์อัปเดต (ชื่อ / Icon / Banner) ──
    client.on("guildUpdate", async (oldGuild, newGuild) => {
        const changes = [];
        if (oldGuild.name !== newGuild.name)
            changes.push({ name: "🏷️ ชื่อเซิร์ฟ", value: `\`${oldGuild.name}\` → \`${newGuild.name}\`` });
        if (oldGuild.icon !== newGuild.icon)
            changes.push({ name: "🖼️ Icon", value: "เปลี่ยนแล้ว" });
        if (oldGuild.banner !== newGuild.banner)
            changes.push({ name: "🎨 Banner", value: "เปลี่ยนแล้ว" });
        if (oldGuild.description !== newGuild.description)
            changes.push({ name: "📄 คำอธิบาย", value: `${oldGuild.description || "*ว่าง*"} → ${newGuild.description || "*ว่าง*"}` });
        if (changes.length === 0) return;

        const entry = await fetchAuditEntry(newGuild, "GUILD_UPDATE", newGuild.id);
        const embed = buildEmbed({
            color:   config.system.themeColors.warning,
            title:   "⚙️ เซิร์ฟเวอร์ถูกแก้ไข",
            noThumb: true,
            fields: [
                ...(entry ? [{ name: "👤 แก้ไขโดย", value: `<@${entry.executor.id}>`, inline: true }] : []),
                ...changes.map(c => ({ name: c.name, value: c.value, inline: false }))
            ]
        });
        if (newGuild.iconURL()) embed.setThumbnail(newGuild.iconURL({ dynamic: true }));
        await sendAuditLog(newGuild, sessionManager, "server", embed);
    });

    // ── Invite สร้าง ──
    client.on("inviteCreate", async (invite) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.success,
            title:   "🔗 Invite ถูกสร้าง",
            noThumb: true,
            fields: [
                { name: "🔗 Code",     value: `\`${invite.code}\``, inline: true },
                { name: "📌 ห้อง",    value: `<#${invite.channel.id}>`, inline: true },
                { name: "👤 สร้างโดย", value: invite.inviter ? `<@${invite.inviter.id}>` : "ไม่ทราบ", inline: true },
                { name: "⏰ หมดอายุ", value: invite.expiresAt ? `<t:${Math.floor(invite.expiresAt / 1000)}:R>` : "ไม่หมดอายุ", inline: true },
                { name: "🔢 ใช้ได้", value: invite.maxUses ? `${invite.maxUses} ครั้ง` : "ไม่จำกัด", inline: true }
            ]
        });
        await sendAuditLog(invite.guild, sessionManager, "server", embed);
    });

    // ── Invite ลบ ──
    client.on("inviteDelete", async (invite) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   "🔗 Invite ถูกลบ",
            noThumb: true,
            fields: [
                { name: "🔗 Code",  value: `\`${invite.code}\``, inline: true },
                { name: "📌 ห้อง", value: `<#${invite.channel.id}>`, inline: true }
            ]
        });
        await sendAuditLog(invite.guild, sessionManager, "server", embed);
    });

    // ── Sticker เพิ่ม ──
    client.on("stickerCreate", async (sticker) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.success,
            title:   "🪄 Sticker ใหม่ถูกเพิ่ม",
            noThumb: true,
            fields: [
                { name: "🪄 ชื่อ",       value: `\`${sticker.name}\``, inline: true },
                { name: "🆔 Sticker ID", value: `\`${sticker.id}\``, inline: true }
            ]
        });
        await sendAuditLog(sticker.guild, sessionManager, "server", embed);
    });

    // ── Sticker ลบ ──
    client.on("stickerDelete", async (sticker) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   "🪄 Sticker ถูกลบ",
            noThumb: true,
            fields: [
                { name: "🪄 ชื่อ",       value: `\`${sticker.name}\``, inline: true },
                { name: "🆔 Sticker ID", value: `\`${sticker.id}\``, inline: true }
            ]
        });
        await sendAuditLog(sticker.guild, sessionManager, "server", embed);
    });

    // ── Thread สร้าง ──
    client.on("threadCreate", async (thread) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.success,
            title:   "🧵 Thread ถูกสร้าง",
            noThumb: true,
            fields: [
                { name: "🧵 ชื่อ",       value: `\`${thread.name}\``, inline: true },
                { name: "📌 ห้องหลัก",   value: thread.parentId ? `<#${thread.parentId}>` : "ไม่ทราบ", inline: true },
                { name: "🆔 Thread ID",  value: `\`${thread.id}\``, inline: true }
            ]
        });
        await sendAuditLog(thread.guild, sessionManager, "server", embed);
    });

    // ── Thread ลบ ──
    client.on("threadDelete", async (thread) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   "🧵 Thread ถูกลบ",
            noThumb: true,
            fields: [
                { name: "🧵 ชื่อ",       value: `\`${thread.name}\``, inline: true },
                { name: "📌 ห้องหลัก",   value: thread.parentId ? `<#${thread.parentId}>` : "ไม่ทราบ", inline: true },
                { name: "🆔 Thread ID",  value: `\`${thread.id}\``, inline: true }
            ]
        });
        await sendAuditLog(thread.guild, sessionManager, "server", embed);
    });

    // ── Webhook เปลี่ยน (Security risk) ──
    client.on("webhookUpdate", async (channel) => {
        const embed = buildEmbed({
            color:   config.system.themeColors.error,
            title:   `${config.emojis.alert} Webhook ในห้องเปลี่ยนแปลง`,
            noThumb: true,
            fields: [
                { name: "📌 ห้อง", value: `<#${channel.id}> (\`${channel.id}\`)`, inline: true },
                { name: "⚠️ คำเตือน", value: "มีการสร้าง/แก้ไข/ลบ Webhook — ตรวจสอบทันที!", inline: false }
            ]
        });
        await sendAuditLog(channel.guild, sessionManager, "security", embed);
    });

    // ── Integration เปลี่ยน ──
    client.on("guildIntegrationsUpdate", async (guild) => {
        await new Promise(r => setTimeout(r, 1500));
        try {
            const logs = await guild.fetchAuditLogs({ limit: 3 });
            const entry = logs.entries.find(e =>
                (e.action === "INTEGRATION_CREATE" || e.action === "INTEGRATION_DELETE" || e.action === "INTEGRATION_UPDATE") &&
                Date.now() - e.createdTimestamp < 8000
            );
            if (!entry) return;

            const isAdd = entry.action === "INTEGRATION_CREATE";
            const isDel = entry.action === "INTEGRATION_DELETE";

            const embed = buildEmbed({
                color:   isAdd ? config.system.themeColors.success : isDel ? config.system.themeColors.error : config.system.themeColors.warning,
                title:   isAdd ? "🔌 Integration เพิ่ม" : isDel ? "🔌 Integration ลบ" : "🔌 Integration แก้ไข",
                noThumb: true,
                fields: [
                    { name: "👤 โดย", value: `<@${entry.executor.id}>`, inline: true },
                    { name: "📌 ชื่อ", value: entry.target?.name || "ไม่ทราบ", inline: true }
                ]
            });
            await sendAuditLog(guild, sessionManager, "security", embed);
        } catch {}
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🚨  REGION 6: SECURITY EVENTS
// ════════════════════════════════════════════════════════════════════════════
function registerSecurityEvents(client, sessionManager) {
    const config = require("./config.json");

    // ── บอทถูกเชิญเข้า ──
    client.on("guildMemberAdd", async (member) => {
        if (!member.user.bot) return;
        if (member.user.id === client.user?.id) return;

        const entry = await fetchAuditEntry(member.guild, "BOT_ADD", member.id);
        const embed = buildEmbed({
            color:  config.system.themeColors.error,
            title:  `${config.emojis.robot} บอทใหม่ถูกเชิญเข้าเซิร์ฟเวอร์`,
            user:   member.user,
            fields: [
                { name: "🤖 บอท",           value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
                { name: "✅ Verified",       value: member.user.flags?.has("VERIFIED_BOT") ? "✅ ใช่" : "❌ ไม่ได้ยืนยัน — ระวัง!", inline: true },
                ...(entry ? [{ name: "👤 เชิญโดย", value: `<@${entry.executor.id}> (\`${entry.executor.tag}\`)`, inline: true }] : [])
            ]
        });
        await sendAuditLog(member.guild, sessionManager, "security", embed);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 7: REGISTER ALL + EXPORT
// ════════════════════════════════════════════════════════════════════════════
function register(client, sessionManager) {
    startAuditCleanup();

    if (registeredClients.has(client)) {
        console.log("[AUDIT] ℹ️ Audit Logger already registered for this client — skipped duplicate listeners.");
        return;
    }

    registeredClients.add(client);

    registerMessageEvents(client, sessionManager);
    registerMemberEvents(client, sessionManager);
    registerVoiceEvents(client, sessionManager);
    registerServerEvents(client, sessionManager);
    registerSecurityEvents(client, sessionManager);
    console.log("[AUDIT] ✅ Audit Logger v2.0 registered — 35+ events active.");
}

module.exports = {
    register,
    sendAuditLog,
    getAuditStats,
    stopAuditCleanup,
    invalidateAuditCache: (guildId) => auditChannelCache.delete(guildId)
};
