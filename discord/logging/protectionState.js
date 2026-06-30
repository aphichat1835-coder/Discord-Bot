class ProtectionWindowState {
    constructor({ maxKeys = 2000 } = {}) {
        this.maxKeys = Math.max(100, Number(maxKeys) || 2000);
        this.events = new Map();
    }

    key(guildId, actorId, actionType) {
        return [guildId || "guild", actorId || "unknown", String(actionType || "UNKNOWN").toUpperCase()].join(":");
    }

    record({ guildId, actorId, actionType, now = Date.now(), windowMs = 60_000 }) {
        const key = this.key(guildId, actorId, actionType);
        const list = (this.events.get(key) || []).filter(ts => now - ts <= windowMs);
        list.push(now);
        this.events.delete(key);
        this.events.set(key, list);
        this.trim(now);
        return { key, count: list.length, timestamps: list.slice() };
    }

    count({ guildId, actorId, actionType, now = Date.now(), windowMs = 60_000 }) {
        const key = this.key(guildId, actorId, actionType);
        return (this.events.get(key) || []).reduce((total, ts) => total + (now - ts <= windowMs ? 1 : 0), 0);
    }

    trim(now = Date.now()) {
        for (const [key, list] of this.events.entries()) {
            const next = list.filter(ts => now - ts <= 10 * 60_000);
            if (next.length) this.events.set(key, next);
            else this.events.delete(key);
        }
        while (this.events.size > this.maxKeys) {
            const oldest = this.events.keys().next().value;
            if (!oldest) break;
            this.events.delete(oldest);
        }
    }

    stats() {
        return { keys: this.events.size, maxKeys: this.maxKeys };
    }
}

const defaultProtectionWindowState = new ProtectionWindowState();

module.exports = {
    ProtectionWindowState,
    defaultProtectionWindowState
};
