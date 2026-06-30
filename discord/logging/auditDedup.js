const DEFAULT_TTL_MS = Math.max(1000, Number(process.env.AUDIT_DEDUP_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
const DEFAULT_MAX_KEYS = Math.max(100, Number(process.env.AUDIT_DEDUP_MAX_KEYS || 5000) || 5000);

class AuditDedupCache {
    constructor({ ttlMs = DEFAULT_TTL_MS, maxKeys = DEFAULT_MAX_KEYS } = {}) {
        this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
        this.maxKeys = Math.max(100, Number(maxKeys) || DEFAULT_MAX_KEYS);
        this.keys = new Map();
    }

    makeKey(parts = []) {
        return parts.map(part => String(part ?? "unknown")).join(":");
    }

    has(key, now = Date.now()) {
        const last = this.keys.get(key);
        return !!last && now - last < this.ttlMs;
    }

    remember(key, now = Date.now()) {
        this.keys.set(key, now);
        this.trim(now);
        return key;
    }

    seen(key, now = Date.now()) {
        if (this.has(key, now)) return true;
        this.remember(key, now);
        return false;
    }

    trim(now = Date.now()) {
        for (const [key, ts] of this.keys.entries()) {
            if (now - ts > this.ttlMs) this.keys.delete(key);
        }
        while (this.keys.size > this.maxKeys) {
            const oldest = this.keys.keys().next().value;
            if (!oldest) break;
            this.keys.delete(oldest);
        }
    }

    stats() {
        return { size: this.keys.size, ttlMs: this.ttlMs, maxKeys: this.maxKeys };
    }
}

const defaultAuditDedup = new AuditDedupCache();

function auditEntryKey(guildId, entryId) {
    return defaultAuditDedup.makeKey(["audit", guildId, entryId]);
}

function gatewayEventKey(guildId, type, targetId, bucket) {
    return defaultAuditDedup.makeKey(["gateway", guildId, type, targetId, bucket]);
}

module.exports = {
    AuditDedupCache,
    defaultAuditDedup,
    auditEntryKey,
    gatewayEventKey
};
