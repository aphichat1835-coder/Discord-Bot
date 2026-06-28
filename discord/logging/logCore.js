/*
 * Advanced Logging Core
 * Shared utilities for audit logging, routing, queueing, and safe text handling.
 * Designed for discord.js v13 and the existing Phomueangtai bot architecture.
 */

const config = require("../config.json");
const { sanitizeLogText, safeError } = require("../core/safeLogger");
const auditDeadLetter = require("./auditDeadLetter");

const LOG_CHANNEL_TYPES = Object.freeze({
    MESSAGE: "message",
    MEMBER: "member",
    VOICE: "voice",
    SERVER: "server",
    SECURITY: "security",
    MODERATION: "moderation"
});

const LOG_TYPES = Object.freeze({
    // Message
    MESSAGE_DELETE: "MESSAGE_DELETE",
    MESSAGE_EDIT: "MESSAGE_EDIT",
    MESSAGE_BULK_DELETE: "MESSAGE_BULK_DELETE",
    MESSAGE_PIN_UPDATE: "MESSAGE_PIN_UPDATE",
    MESSAGE_REACTION_ADD: "MESSAGE_REACTION_ADD",
    MESSAGE_REACTION_REMOVE: "MESSAGE_REACTION_REMOVE",

    // Member
    MEMBER_JOIN: "MEMBER_JOIN",
    MEMBER_LEAVE: "MEMBER_LEAVE",
    MEMBER_KICK: "MEMBER_KICK",
    MEMBER_BAN: "MEMBER_BAN",
    MEMBER_UNBAN: "MEMBER_UNBAN",
    MEMBER_ROLE_UPDATE: "MEMBER_ROLE_UPDATE",
    MEMBER_NICK_UPDATE: "MEMBER_NICK_UPDATE",
    MEMBER_TIMEOUT_UPDATE: "MEMBER_TIMEOUT_UPDATE",
    MEMBER_AVATAR_UPDATE: "MEMBER_AVATAR_UPDATE",

    // Voice
    VOICE_JOIN: "VOICE_JOIN",
    VOICE_LEAVE: "VOICE_LEAVE",
    VOICE_MOVE: "VOICE_MOVE",
    VOICE_STATE_UPDATE: "VOICE_STATE_UPDATE",

    // Server
    CHANNEL_CREATE: "CHANNEL_CREATE",
    CHANNEL_DELETE: "CHANNEL_DELETE",
    CHANNEL_UPDATE: "CHANNEL_UPDATE",
    CHANNEL_PERMISSION_UPDATE: "CHANNEL_PERMISSION_UPDATE",
    ROLE_CREATE: "ROLE_CREATE",
    ROLE_DELETE: "ROLE_DELETE",
    ROLE_UPDATE: "ROLE_UPDATE",
    ROLE_PERMISSION_UPDATE: "ROLE_PERMISSION_UPDATE",
    GUILD_UPDATE: "GUILD_UPDATE",
    INVITE_CREATE: "INVITE_CREATE",
    INVITE_DELETE: "INVITE_DELETE",
    WEBHOOK_UPDATE: "WEBHOOK_UPDATE",
    EMOJI_CREATE: "EMOJI_CREATE",
    EMOJI_DELETE: "EMOJI_DELETE",
    STICKER_CREATE: "STICKER_CREATE",
    STICKER_DELETE: "STICKER_DELETE",
    THREAD_CREATE: "THREAD_CREATE",
    THREAD_DELETE: "THREAD_DELETE",
    THREAD_UPDATE: "THREAD_UPDATE",

    // Moderation / Protection
    MOD_CASE_CREATE: "MOD_CASE_CREATE",
    MOD_CASE_UPDATE: "MOD_CASE_UPDATE",
    PROTECTION_TRIGGER: "PROTECTION_TRIGGER",
    PROTECTION_ACTION: "PROTECTION_ACTION",
    PROTECTION_ACTION_FAILED: "PROTECTION_ACTION_FAILED",
    BOT_ADDED: "BOT_ADDED"
});

const LOG_TYPE_CATEGORY = Object.freeze({
    [LOG_TYPES.MESSAGE_DELETE]: LOG_CHANNEL_TYPES.MESSAGE,
    [LOG_TYPES.MESSAGE_EDIT]: LOG_CHANNEL_TYPES.MESSAGE,
    [LOG_TYPES.MESSAGE_BULK_DELETE]: LOG_CHANNEL_TYPES.MESSAGE,
    [LOG_TYPES.MESSAGE_PIN_UPDATE]: LOG_CHANNEL_TYPES.MESSAGE,
    [LOG_TYPES.MESSAGE_REACTION_ADD]: LOG_CHANNEL_TYPES.MESSAGE,
    [LOG_TYPES.MESSAGE_REACTION_REMOVE]: LOG_CHANNEL_TYPES.MESSAGE,

    [LOG_TYPES.MEMBER_JOIN]: LOG_CHANNEL_TYPES.MEMBER,
    [LOG_TYPES.MEMBER_LEAVE]: LOG_CHANNEL_TYPES.MEMBER,
    [LOG_TYPES.MEMBER_KICK]: LOG_CHANNEL_TYPES.MODERATION,
    [LOG_TYPES.MEMBER_BAN]: LOG_CHANNEL_TYPES.MODERATION,
    [LOG_TYPES.MEMBER_UNBAN]: LOG_CHANNEL_TYPES.MODERATION,
    [LOG_TYPES.MEMBER_ROLE_UPDATE]: LOG_CHANNEL_TYPES.MEMBER,
    [LOG_TYPES.MEMBER_NICK_UPDATE]: LOG_CHANNEL_TYPES.MEMBER,
    [LOG_TYPES.MEMBER_TIMEOUT_UPDATE]: LOG_CHANNEL_TYPES.MODERATION,
    [LOG_TYPES.MEMBER_AVATAR_UPDATE]: LOG_CHANNEL_TYPES.MEMBER,

    [LOG_TYPES.VOICE_JOIN]: LOG_CHANNEL_TYPES.VOICE,
    [LOG_TYPES.VOICE_LEAVE]: LOG_CHANNEL_TYPES.VOICE,
    [LOG_TYPES.VOICE_MOVE]: LOG_CHANNEL_TYPES.VOICE,
    [LOG_TYPES.VOICE_STATE_UPDATE]: LOG_CHANNEL_TYPES.VOICE,

    [LOG_TYPES.CHANNEL_CREATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.CHANNEL_DELETE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.CHANNEL_UPDATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.CHANNEL_PERMISSION_UPDATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.ROLE_CREATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.ROLE_DELETE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.ROLE_UPDATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.ROLE_PERMISSION_UPDATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.GUILD_UPDATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.INVITE_CREATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.INVITE_DELETE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.WEBHOOK_UPDATE]: LOG_CHANNEL_TYPES.SECURITY,
    [LOG_TYPES.EMOJI_CREATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.EMOJI_DELETE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.STICKER_CREATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.STICKER_DELETE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.THREAD_CREATE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.THREAD_DELETE]: LOG_CHANNEL_TYPES.SERVER,
    [LOG_TYPES.THREAD_UPDATE]: LOG_CHANNEL_TYPES.SERVER,

    [LOG_TYPES.MOD_CASE_CREATE]: LOG_CHANNEL_TYPES.MODERATION,
    [LOG_TYPES.MOD_CASE_UPDATE]: LOG_CHANNEL_TYPES.MODERATION,
    [LOG_TYPES.PROTECTION_TRIGGER]: LOG_CHANNEL_TYPES.SECURITY,
    [LOG_TYPES.PROTECTION_ACTION]: LOG_CHANNEL_TYPES.SECURITY,
    [LOG_TYPES.PROTECTION_ACTION_FAILED]: LOG_CHANNEL_TYPES.SECURITY,
    [LOG_TYPES.BOT_ADDED]: LOG_CHANNEL_TYPES.SECURITY
});

const DEFAULT_MAX_TEXT = 1000;
const DEFAULT_MAX_QUEUE_PER_GUILD = Math.max(1, Number(process.env.LOG_CORE_MAX_QUEUE_PER_GUILD || 250) || 250);

function safeAuditText(value, max = DEFAULT_MAX_TEXT) {
    const limit = Math.max(1, Number(max) || DEFAULT_MAX_TEXT);
    const clean = sanitizeLogText(String(value ?? ""));
    if (clean.length <= limit) return clean || "-";
    const suffix = "... [TRUNCATED]";
    if (limit <= suffix.length) return suffix.slice(0, limit);
    return `${clean.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function safeAuditError(err, max = 500) {
    return safeAuditText(safeError(err), max);
}

function resolveLogCategory(type, fallback = LOG_CHANNEL_TYPES.SERVER) {
    return LOG_TYPE_CATEGORY[type] || fallback;
}

function normalizeCategory(category) {
    if (!category) return null;
    const raw = String(category).toLowerCase();
    return Object.values(LOG_CHANNEL_TYPES).includes(raw) ? raw : null;
}

function buildLogEvent(input = {}) {
    const type = input.type || "UNKNOWN";
    const category = normalizeCategory(input.category) || resolveLogCategory(type);
    return {
        type,
        category,
        severity: input.severity || "info",
        guildId: input.guildId || input.guild?.id || null,
        actorId: input.actorId || input.actor?.id || null,
        targetId: input.targetId || input.target?.id || null,
        channelId: input.channelId || input.channel?.id || null,
        messageId: input.messageId || input.message?.id || null,
        roleId: input.roleId || input.role?.id || null,
        source: input.source || "discord_event",
        reason: input.reason || null,
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
        createdAt: input.createdAt || Date.now()
    };
}

function getConfiguredChannelName(category) {
    return config.audit_channels?.[category] || null;
}

function findTextChannelByName(guild, channelName) {
    if (!guild || !channelName) return null;
    const channels = typeof guild.channels.cache.find === "function"
        ? guild.channels.cache
        : Array.from(guild.channels.cache?.values?.() || []);
    const find = typeof channels.find === "function"
        ? channels.find.bind(channels)
        : predicate => Array.from(channels || []).find(channel => predicate(channel));
    return find(channel =>
        channel?.name === channelName &&
        isSendCapableTextChannel(channel)
    ) || null;
}

function isSendCapableTextChannel(channel) {
    if (!channel || typeof channel.send !== "function") return false;
    if (typeof channel.isText === "function") return channel.isText();
    if (channel.type === undefined || channel.type === null) return true;
    return channel.type === "GUILD_TEXT" || channel.type === "text";
}

async function getLogChannel(guild, sessionManager, category) {
    const normalized = normalizeCategory(category);
    if (!guild || !sessionManager || !normalized) return null;

    try {
        const map = await sessionManager.getLogChannelMap(guild.id);
        let channelId = map?.[`${normalized}ChannelId`];

        // Backward-compatible fallback until moderationChannelId is added to old guild maps.
        if (!channelId && normalized === LOG_CHANNEL_TYPES.MODERATION) {
            channelId = map?.memberChannelId || map?.securityChannelId || null;
        }

        if (channelId) {
            const channel = guild.channels.cache.get(channelId);
            if (isSendCapableTextChannel(channel)) return channel;
        }

        const configuredName = getConfiguredChannelName(normalized);
        const namedChannel = findTextChannelByName(guild, configuredName);
        if (namedChannel) return namedChannel;
    } catch (err) {
        console.warn(`[LOG_CORE] Failed to resolve log channel: ${safeAuditError(err, 240)}`);
        return null;
    }

    return null;
}

class GuildLogQueue {
    constructor({ maxDepth = DEFAULT_MAX_QUEUE_PER_GUILD } = {}) {
        this.maxDepth = Math.max(1, Number(maxDepth) || DEFAULT_MAX_QUEUE_PER_GUILD);
        this.queues = new Map();
        this.depths = new Map();
        this.debounce = new Map();
    }

    isDebounced(key, ttlMs) {
        if (!key || !ttlMs) return false;
        const now = Date.now();
        const last = this.debounce.get(key) || 0;
        if (now - last < ttlMs) return true;
        this.debounce.set(key, now);
        return false;
    }

    enqueue(guildId, task) {
        if (!guildId || typeof task !== "function") return false;
        const depth = this.depths.get(guildId) || 0;
        if (depth >= this.maxDepth) return false;

        this.depths.set(guildId, depth + 1);
        const previous = this.queues.get(guildId) || Promise.resolve();
        const next = previous.catch(() => {}).then(task);
        this.queues.set(guildId, next);

        next.finally(() => {
            const current = Math.max(0, (this.depths.get(guildId) || 1) - 1);
            if (current > 0) this.depths.set(guildId, current);
            else this.depths.delete(guildId);
            if (this.queues.get(guildId) === next) this.queues.delete(guildId);
        }).catch(() => {});

        return next;
    }

    stats() {
        return {
            guildQueues: this.queues.size,
            depths: Object.fromEntries(this.depths),
            debounceKeys: this.debounce.size,
            maxDepth: this.maxDepth
        };
    }
}

const defaultQueue = new GuildLogQueue();

async function saveLogFailure({ sessionManager, guild, category, reason, detail, embed }) {
    return auditDeadLetter.saveDeadLetter(sessionManager, {
        guildId: guild?.id,
        category,
        actionType: reason,
        reason,
        payload: {
            detail: safeAuditText(detail || reason, 300),
            title: embed?.title || embed?.data?.title || null,
            description: embed?.description || embed?.data?.description || null
        }
    }).catch(() => null);
}

async function routeAndSendLog({ guild, sessionManager, category, embed, content = null, debounceKey = null, debounceMs = 0 }) {
    if (!guild || !embed) return false;
    if (defaultQueue.isDebounced(debounceKey, debounceMs)) return false;

    const queued = defaultQueue.enqueue(guild.id, async () => {
        const channel = await getLogChannel(guild, sessionManager, category);
        if (!channel) {
            await saveLogFailure({ sessionManager, guild, category, reason: "missing_log_channel", detail: category, embed });
            return false;
        }
        try {
            await channel.send({ content: content || undefined, embeds: [embed] });
            return true;
        } catch (err) {
            console.warn(`[LOG_CORE] Failed to send log: ${safeAuditError(err, 240)}`);
            await saveLogFailure({ sessionManager, guild, category, reason: "send_failed", detail: safeAuditError(err, 240), embed });
            return false;
        }
    });

    if (!queued) {
        await saveLogFailure({ sessionManager, guild, category, reason: "queue_full", detail: defaultQueue.stats().maxDepth, embed });
        return false;
    }

    return queued;
}

module.exports = {
    LOG_CHANNEL_TYPES,
    LOG_TYPES,
    LOG_TYPE_CATEGORY,
    GuildLogQueue,
    defaultQueue,
    safeAuditText,
    safeAuditError,
    resolveLogCategory,
    normalizeCategory,
    buildLogEvent,
    getConfiguredChannelName,
    findTextChannelByName,
    isSendCapableTextChannel,
    getLogChannel,
    saveLogFailure,
    routeAndSendLog
};
