/*
 * Audit helper utilities for discord.js v13.
 * Combines audit-log lookup, permission diffing, and message snapshot cache.
 */

const { safeAuditText, safeAuditError } = require("./logCore");

class LruCache {
    constructor(maxSize = 500) {
        this.maxSize = Math.max(1, Number(maxSize) || 500);
        this.map = new Map();
    }

    get size() { return this.map.size; }

    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.maxSize) {
            this.map.delete(this.map.keys().next().value);
        }
    }

    has(key) { return this.map.has(key); }
    delete(key) { return this.map.delete(key); }
    clear() { this.map.clear(); }
    values() { return this.map.values(); }
    entries() { return this.map.entries(); }
}

const auditCache = new LruCache(Math.max(50, Number(process.env.AUDIT_HELPER_CACHE_MAX || 500) || 500));
const DEFAULT_AUDIT_MAX_AGE_MS = Math.max(1000, Number(process.env.AUDIT_HELPER_MAX_AGE_MS || 15000) || 15000);
const DEFAULT_AUDIT_DELAY_MS = Math.max(0, Number(process.env.AUDIT_HELPER_DELAY_MS || 650) || 650);

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function compareText(a, b) {
    return String(a).localeCompare(String(b));
}

function normalizeId(value) {
    return value == null ? null : String(value);
}

function auditCacheKey(guildId, actionType, targetId) {
    return `${guildId}:${actionType || "ANY"}:${targetId || "ANY"}`;
}

function entryTargetId(entry) {
    return normalizeId(entry?.target?.id || entry?.targetId || entry?.target?.user?.id || entry?.extra?.channel?.id);
}

function entryChannelId(entry) {
    return normalizeId(entry?.extra?.channel?.id || entry?.target?.channelId || entry?.target?.id);
}

function isEntryFresh(entry, maxAgeMs) {
    const created = Number(entry?.createdTimestamp || entry?.createdAt?.getTime?.() || 0);
    return created > 0 && Date.now() - created <= maxAgeMs;
}

async function fetchAuditEntry(guild, actionType, targetId, options = {}) {
    if (!guild?.fetchAuditLogs) return null;

    const maxAgeMs = Math.max(1000, Number(options.maxAgeMs || DEFAULT_AUDIT_MAX_AGE_MS) || DEFAULT_AUDIT_MAX_AGE_MS);
    const delayMs = options.delayMs === undefined ? DEFAULT_AUDIT_DELAY_MS : Number(options.delayMs) || 0;
    const limit = Math.max(1, Math.min(10, Number(options.limit || 6) || 6));
    const channelId = normalizeId(options.channelId);
    const normalizedTargetId = normalizeId(targetId);
    const cacheKey = auditCacheKey(guild.id, actionType, normalizedTargetId || channelId);

    const cached = auditCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt <= maxAgeMs) return cached.entry;

    if (delayMs > 0) await wait(delayMs);

    try {
        const fetchOptions = actionType ? { type: actionType, limit } : { limit };
        const logs = await guild.fetchAuditLogs(fetchOptions);
        const entries = Array.from(logs?.entries?.values?.() || []);
        const matched = entries.find(entry => {
            if (!isEntryFresh(entry, maxAgeMs)) return false;
            const targetMatches = !normalizedTargetId || entryTargetId(entry) === normalizedTargetId;
            const channelMatches = !channelId || entryChannelId(entry) === channelId || entryTargetId(entry) === channelId;
            return targetMatches && channelMatches;
        }) || null;

        auditCache.set(cacheKey, { entry: matched, cachedAt: Date.now() });
        return matched;
    } catch (err) {
        console.warn(`[AUDIT_HELPER] fetchAuditEntry failed: ${safeAuditError(err, 240)}`);
        auditCache.set(cacheKey, { entry: null, cachedAt: Date.now() });
        return null;
    }
}

function permissionsToArray(permissions) {
    try {
        if (!permissions) return [];
        if (Array.isArray(permissions)) return [...new Set(permissions.map(String))].sort(compareText);
        if (typeof permissions.toArray === "function") return permissions.toArray().map(String).sort(compareText);
        if (permissions.allow || permissions.deny) return [];
    } catch {}
    return [];
}

function diffPermissionArrays(before = [], after = []) {
    const oldSet = new Set(before.map(String));
    const newSet = new Set(after.map(String));
    return {
        added: [...newSet].filter(p => !oldSet.has(p)).sort(compareText),
        removed: [...oldSet].filter(p => !newSet.has(p)).sort(compareText)
    };
}

function diffRolePermissions(oldRole, newRole) {
    const before = permissionsToArray(oldRole?.permissions);
    const after = permissionsToArray(newRole?.permissions);
    return diffPermissionArrays(before, after);
}

function serializeOverwrite(overwrite) {
    if (!overwrite) return null;
    return {
        id: String(overwrite.id),
        type: String(overwrite.type),
        allow: permissionsToArray(overwrite.allow).sort(compareText),
        deny: permissionsToArray(overwrite.deny).sort(compareText)
    };
}

function overwriteMap(collection) {
    const map = new Map();
    const values = collection?.values ? Array.from(collection.values()) : Array.from(collection || []);
    for (const overwrite of values) {
        const serialized = serializeOverwrite(overwrite);
        if (serialized) map.set(serialized.id, serialized);
    }
    return map;
}

function diffPermissionOverwrites(oldOverwrites, newOverwrites) {
    const oldMap = overwriteMap(oldOverwrites);
    const newMap = overwriteMap(newOverwrites);
    const ids = new Set([...oldMap.keys(), ...newMap.keys()]);
    const result = [];

    for (const id of ids) {
        const before = oldMap.get(id);
        const after = newMap.get(id);
        if (!before && after) {
            result.push({ id, type: after.type, change: "created", allowAdded: after.allow, denyAdded: after.deny, allowRemoved: [], denyRemoved: [] });
            continue;
        }
        if (before && !after) {
            result.push({ id, type: before.type, change: "deleted", allowAdded: [], denyAdded: [], allowRemoved: before.allow, denyRemoved: before.deny });
            continue;
        }
        const allow = diffPermissionArrays(before.allow, after.allow);
        const deny = diffPermissionArrays(before.deny, after.deny);
        if (allow.added.length || allow.removed.length || deny.added.length || deny.removed.length) {
            result.push({
                id,
                type: after.type,
                change: "updated",
                allowAdded: allow.added,
                allowRemoved: allow.removed,
                denyAdded: deny.added,
                denyRemoved: deny.removed
            });
        }
    }

    return result;
}

function formatPermissionList(values = [], max = 12) {
    if (!values.length) return "-";
    const shown = values.slice(0, max).map(v => `\`${safeAuditText(v, 64)}\``);
    if (values.length > max) shown.push(`...+${values.length - max}`);
    return shown.join(", ");
}

function formatOverwriteDiff(diff = []) {
    if (!diff.length) return [];
    return diff.slice(0, 8).map(item => {
        const lines = [`Target: \`${item.id}\` (${item.type})`, `Change: \`${item.change}\``];
        if (item.allowAdded?.length) lines.push(`Allow + ${formatPermissionList(item.allowAdded)}`);
        if (item.allowRemoved?.length) lines.push(`Allow - ${formatPermissionList(item.allowRemoved)}`);
        if (item.denyAdded?.length) lines.push(`Deny + ${formatPermissionList(item.denyAdded)}`);
        if (item.denyRemoved?.length) lines.push(`Deny - ${formatPermissionList(item.denyRemoved)}`);
        return lines.join("\n");
    });
}

class MessageSnapshotCache {
    constructor({ maxSize = 1000, ttlMs = 60 * 60 * 1000, maxContent = 1800 } = {}) {
        this.maxSize = Math.max(20, Number(maxSize) || 1000);
        this.ttlMs = Math.max(60000, Number(ttlMs) || 60 * 60 * 1000);
        this.maxContent = Math.max(200, Number(maxContent) || 1800);
        this.cache = new LruCache(this.maxSize);
    }

    key(guildId, messageId) {
        return `${guildId || "dm"}:${messageId}`;
    }

    snapshot(message) {
        if (!message?.id) return null;
        const guildId = message.guild?.id || message.channel?.guild?.id || null;
        const attachments = Array.from(message.attachments?.values?.() || []).map(a => ({
            id: a.id || null,
            name: a.name || a.filename || "attachment",
            url: a.url || null,
            proxyURL: a.proxyURL || null,
            size: a.size || null,
            contentType: a.contentType || null
        }));

        const snapshot = {
            messageId: message.id,
            guildId,
            channelId: message.channel?.id || null,
            authorId: message.author?.id || null,
            authorTag: message.author?.tag || message.author?.username || null,
            content: safeAuditText(message.content || "", this.maxContent),
            attachments,
            embeds: Array.isArray(message.embeds) ? message.embeds.length : 0,
            replyTo: message.reference?.messageId || null,
            createdAt: message.createdTimestamp || Date.now(),
            editedAt: message.editedTimestamp || null,
            cachedAt: Date.now()
        };

        this.cache.set(this.key(guildId, message.id), snapshot);
        return snapshot;
    }

    get(guildId, messageId) {
        const snapshot = this.cache.get(this.key(guildId, messageId));
        if (!snapshot) return null;
        if (Date.now() - snapshot.cachedAt > this.ttlMs) {
            this.cache.delete(this.key(guildId, messageId));
            return null;
        }
        return snapshot;
    }

    delete(guildId, messageId) {
        return this.cache.delete(this.key(guildId, messageId));
    }

    cleanup(now = Date.now()) {
        for (const [key, value] of this.cache.entries()) {
            if (now - value.cachedAt > this.ttlMs) this.cache.delete(key);
        }
    }

    stats() {
        return { size: this.cache.size, maxSize: this.maxSize, ttlMs: this.ttlMs };
    }
}

const defaultMessageSnapshots = new MessageSnapshotCache({
    maxSize: Math.max(100, Number(process.env.MESSAGE_SNAPSHOT_CACHE_MAX || 1000) || 1000),
    ttlMs: Math.max(60000, Number(process.env.MESSAGE_SNAPSHOT_CACHE_TTL_MS || 60 * 60 * 1000) || 60 * 60 * 1000)
});

module.exports = {
    LruCache,
    fetchAuditEntry,
    auditCache,
    permissionsToArray,
    diffPermissionArrays,
    diffRolePermissions,
    diffPermissionOverwrites,
    formatPermissionList,
    formatOverwriteDiff,
    MessageSnapshotCache,
    defaultMessageSnapshots,
    wait
};
