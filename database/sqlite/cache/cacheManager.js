"use strict";

const { getDatabase } = require("../connection");
const { getPolicy } = require("./cachePolicy");
const { canWrite } = require("../maintenance/writePolicy");

class CacheManager {
    constructor(db = null) {
        this._db = db;
        this.inFlight = new Map(); // stampede protection map
        this.touchBuffer = new Map(); // key: "namespace:cacheKey" -> timestamp
        this.touchFlushInterval = null;
        this.startTouchFlusher();
    }

    get db() {
        return this._db || getDatabase();
    }

    startTouchFlusher(intervalMs = 30000) {
        if (this.touchFlushInterval) return;
        this.touchFlushInterval = setInterval(() => {
            this.flushTouches();
        }, intervalMs);
        if (this.touchFlushInterval.unref) {
            this.touchFlushInterval.unref();
        }
    }

    stopTouchFlusher() {
        if (this.touchFlushInterval) {
            clearInterval(this.touchFlushInterval);
            this.touchFlushInterval = null;
        }
        this.flushTouches();
    }

    flushTouches() {
        if (this.touchBuffer.size === 0) return;
        const entries = Array.from(this.touchBuffer.entries());
        this.touchBuffer.clear();

        try {
            const stmt = this.db.prepare(`
                UPDATE cache_entries
                SET last_accessed_at = ?
                WHERE namespace = ? AND cache_key = ?
            `);

            const updateTx = this.db.transaction(() => {
                for (const [compositeKey, ts] of entries) {
                    const colonIdx = compositeKey.indexOf(":");
                    if (colonIdx === -1) continue;
                    const ns = compositeKey.slice(0, colonIdx);
                    const k = compositeKey.slice(colonIdx + 1);
                    stmt.run(ts, ns, k);
                }
            });
            updateTx();
        } catch (_) {}
    }

    recordTouch(namespace, cacheKey, now = Date.now()) {
        const compositeKey = `${namespace}:${cacheKey}`;
        this.touchBuffer.set(compositeKey, now);
        if (this.touchBuffer.size >= 100) {
            this.flushTouches();
        }
    }

    get(namespace, cacheKey, now = Date.now()) {
        const row = this.db.prepare(`
            SELECT payload_json, expires_at FROM cache_entries
            WHERE namespace = ? AND cache_key = ?
        `).get(namespace, cacheKey);

        if (!row) return null;

        if (row.expires_at !== null && row.expires_at <= now) {
            // Expired entry
            this.delete(namespace, cacheKey);
            return null;
        }

        this.recordTouch(namespace, cacheKey, now);

        try {
            return JSON.parse(row.payload_json);
        } catch (_) {
            return null;
        }
    }

    set(namespace, cacheKey, value, options = {}) {
        if (!canWrite("cache")) {
            return false;
        }
        const now = Date.now();
        const policy = getPolicy(namespace);
        const ttlMs = options.ttlMs !== undefined ? options.ttlMs : policy.ttlMs;
        const expiresAt = ttlMs ? now + ttlMs : null;

        const payloadJson = JSON.stringify(value);
        const sizeBytes = Buffer.byteLength(payloadJson, "utf8");

        const stmt = this.db.prepare(`
            INSERT INTO cache_entries (
                namespace, cache_key, payload_json, content_type, version,
                created_at, updated_at, expires_at, last_accessed_at, size_bytes
            ) VALUES (?, ?, ?, 'application/json', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace, cache_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at,
                last_accessed_at = excluded.last_accessed_at,
                size_bytes = excluded.size_bytes
        `);

        stmt.run(
            namespace,
            cacheKey,
            payloadJson,
            options.version || 1,
            now,
            now,
            expiresAt,
            now,
            sizeBytes
        );

        // Enforce maxRows policy with LRU eviction
        this.enforceMaxRows(namespace);

        return true;
    }

    evictLru(namespace, count = 1) {
        if (count <= 0) return 0;
        this.flushTouches();
        const stmt = this.db.prepare(`
            DELETE FROM cache_entries
            WHERE (namespace, cache_key) IN (
                SELECT namespace, cache_key FROM cache_entries
                WHERE namespace = ?
                ORDER BY last_accessed_at ASC, created_at ASC, rowid ASC
                LIMIT ?
            )
        `);
        const info = stmt.run(namespace, count);
        return info.changes;
    }

    enforceMaxRows(namespace) {
        const policy = getPolicy(namespace);
        const maxRows = policy.maxRows;
        if (!maxRows || maxRows <= 0) return 0;

        const countRow = this.db.prepare(`
            SELECT COUNT(*) AS cnt FROM cache_entries WHERE namespace = ?
        `).get(namespace);
        const currentCount = countRow ? countRow.cnt : 0;

        if (currentCount > maxRows) {
            const excess = currentCount - maxRows;
            return this.evictLru(namespace, excess);
        }
        return 0;
    }

    evictAllLru(targetRatio = 0.2) {
        let totalEvicted = 0;
        try {
            const namespaces = this.db.prepare("SELECT DISTINCT namespace FROM cache_entries").all();
            for (const { namespace } of namespaces) {
                const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM cache_entries WHERE namespace = ?").get(namespace);
                const cnt = countRow ? countRow.cnt : 0;
                if (cnt >= 3) {
                    const toEvict = Math.max(1, Math.floor(cnt * targetRatio));
                    totalEvicted += this.evictLru(namespace, toEvict);
                }
            }
        } catch (_) {}
        return totalEvicted;
    }

    delete(namespace, cacheKey) {
        const stmt = this.db.prepare(`
            DELETE FROM cache_entries
            WHERE namespace = ? AND cache_key = ?
        `);
        const info = stmt.run(namespace, cacheKey);
        this.touchBuffer.delete(`${namespace}:${cacheKey}`);
        return info.changes > 0;
    }

    async getOrSet(namespace, cacheKey, loader, options = {}) {
        const cached = this.get(namespace, cacheKey);
        if (cached !== null) {
            return cached;
        }

        // Cache Stampede Protection: single in-flight loader per composite key
        const compositeKey = `${namespace}:${cacheKey}`;
        if (this.inFlight.has(compositeKey)) {
            return this.inFlight.get(compositeKey);
        }

        const promise = (async () => {
            try {
                const freshValue = await loader();
                if (freshValue !== undefined && freshValue !== null) {
                    this.set(namespace, cacheKey, freshValue, options);
                }
                return freshValue;
            } finally {
                this.inFlight.delete(compositeKey);
            }
        })();

        this.inFlight.set(compositeKey, promise);
        return promise;
    }

    stats(namespace = null) {
        if (namespace) {
            const row = this.db.prepare(`
                SELECT count(*) as count, sum(size_bytes) as total_bytes
                FROM cache_entries WHERE namespace = ?
            `).get(namespace);
            return {
                count: row?.count || 0,
                totalBytes: row?.total_bytes || 0
            };
        }
        const row = this.db.prepare(`
            SELECT count(*) as count, sum(size_bytes) as total_bytes
            FROM cache_entries
        `).get();
        return {
            count: row?.count || 0,
            totalBytes: row?.total_bytes || 0
        };
    }

    count(namespace = null) {
        return this.stats(namespace).count;
    }

    setPolicy(namespace, policy) {
        const { setPolicy } = require("./cachePolicy");
        if (typeof setPolicy === "function") {
            setPolicy(namespace, policy);
        }
    }
}

let defaultCacheManager = null;
const dbCacheManagers = new WeakMap();

function getCacheManager(db = null) {
    if (db) {
        if (!dbCacheManagers.has(db)) {
            dbCacheManagers.set(db, new CacheManager(db));
        }
        return dbCacheManagers.get(db);
    }
    if (!defaultCacheManager) {
        defaultCacheManager = new CacheManager();
    }
    return defaultCacheManager;
}

module.exports = {
    CacheManager,
    getCacheManager
};
