"use strict";

const { getDatabase } = require("../../connection");
const { resolvePriority, evictWithPriority, notifyBufferDropped, notifyP1Dropped } = require("./bufferPolicy");
const { spoolP0Event, drainP0Spool } = require("./p0Journal");
const { sanitizeDetails } = require("./CommandEventRepository");
const writePolicy = require("../../maintenance/writePolicy");

class SessionEventRepository {
    constructor(db = null) {
        this._db = db;
        this.buffer = [];
        this.criticalRetryQueue = [];
        this.flushInterval = null;
        this.maxQueueCap = 2000;
        this.flushSizeThreshold = 100;
        this.isDegraded = false;
        this.droppedEventsCount = 0;
        this.startFlusher();
    }

    get db() {
        return this._db || getDatabase();
    }

    startFlusher(intervalMs = 10000) {
        if (this.flushInterval) return;
        this.flushInterval = setInterval(() => {
            this.flush();
        }, intervalMs);
        if (this.flushInterval.unref) {
            this.flushInterval.unref();
        }
    }

    stopFlusher() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
        if (this.criticalRetryQueue.length > 0) {
            for (const cItem of this.criticalRetryQueue.splice(0)) {
                try { this._insertSingle(cItem); } catch (_) {}
            }
        }
        let flushed = 0;
        do {
            flushed = this.flush();
        } while (flushed > 0 && this.buffer.length > 0);
    }

    getBufferStats() {
        return {
            bufferedCount: this.buffer.length,
            maxQueueCap: this.maxQueueCap,
            flushSizeThreshold: this.flushSizeThreshold,
            isDegraded: this.isDegraded,
            droppedEventsCount: this.droppedEventsCount
        };
    }

    record(event, critical = false) {
        let metadataJson = null;
        if (event.metadata !== undefined && event.metadata !== null) {
            try {
                const cleaned = sanitizeDetails(event.metadata);
                metadataJson = JSON.stringify(cleaned).slice(0, 4096);
            } catch (_) {
                metadataJson = null;
            }
        }

        const priority = resolvePriority(event, critical);
        const item = {
            priority,
            occurredAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
            sessionId: String(event.sessionId || "global").slice(0, 128),
            accountId: event.accountId ? String(event.accountId).slice(0, 64) : null,
            eventType: String(event.eventType || "unknown").slice(0, 64),
            metadataJson
        };

        // P0: Critical Security / Corruption / Backup Failure - Best-effort durable; never intentionally evicted while SQLite is healthy
        if (priority === "P0") {
            try {
                this._insertSingle(item);
            } catch (err) {
                this.isDegraded = true;
                if (this.criticalRetryQueue.length < 100) {
                    this.criticalRetryQueue.push(item);
                } else {
                    spoolP0Event("session_events", item);
                }
                console.error(`[SESSION_EVENT_BUFFER] 🚨 CRITICAL P0 event insert failed (queued for retry): ${err.message}`);
            }
            return;
        }

        // P2 drop early when telemetry is degraded under quota pressure
        if (priority === "P2" && !writePolicy.canWrite("telemetry", { priority: "P2" })) {
            return;
        }

        // Bounded queue overflow guard with priority eviction
        if (this.buffer.length >= this.maxQueueCap) {
            const dropTarget = Math.min(500, Math.max(1, Math.floor(this.maxQueueCap / 4)));
            const stats = {};
            const dropCount = evictWithPriority(this.buffer, dropTarget, stats);
            if (dropCount > 0) {
                this.droppedEventsCount += dropCount;
                this.isDegraded = true;
                console.warn(`[SESSION_EVENT_BUFFER] ⚠️ Queue reached capacity (${this.maxQueueCap}). Dropped ${dropCount} low-priority events.`);
                notifyBufferDropped("SessionEventRepository", dropCount, this.maxQueueCap, this.droppedEventsCount);
                if (stats.p1 > 0) {
                    notifyP1Dropped("SessionEventRepository", stats.p1, this.droppedEventsCount);
                }
            }
        }

        this.buffer.push(item);
        if (this.buffer.length >= this.flushSizeThreshold) {
            this.flush();
        }
    }

    _insertSingle(item) {
        const stmt = this.db.prepare(`
            INSERT INTO session_events (
                occurred_at, session_id, account_id, event_type, metadata_json
            ) VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(
            item.occurredAt,
            item.sessionId,
            item.accountId,
            item.eventType,
            item.metadataJson
        );
    }

    flush() {
        // Retry queued P0 events if any
        if (this.criticalRetryQueue.length > 0) {
            const retryItems = this.criticalRetryQueue.splice(0, 50);
            for (const cItem of retryItems) {
                try {
                    this._insertSingle(cItem);
                } catch (_) {
                    this.criticalRetryQueue.unshift(cItem);
                    break;
                }
            }
        } else {
            try {
                drainP0Spool(this.db, { session_events: this });
            } catch (_) {}
        }

        if (this.buffer.length === 0) return 0;
        const batchSize = Math.min(this.buffer.length, 500);
        const items = this.buffer.slice(0, batchSize);

        if (!writePolicy.canWrite("history")) {
            const initialLen = this.buffer.length;
            this.buffer = this.buffer.filter(i => (i.priority || "P2") !== "P2");
            const droppedP2 = initialLen - this.buffer.length;
            if (droppedP2 > 0) {
                this.droppedEventsCount += droppedP2;
                this.isDegraded = true;
                console.warn(`[SESSION_EVENT_BUFFER] ⚠️ Storage hard limit active. Dropped ${droppedP2} P2 events; preserved P1 events in memory.`);
            }
            return 0;
        }

        const stmt = this.db.prepare(`
            INSERT INTO session_events (
                occurred_at, session_id, account_id, event_type, metadata_json
            ) VALUES (?, ?, ?, ?, ?)
        `);

        const insertTx = this.db.transaction(() => {
            for (const item of items) {
                stmt.run(
                    item.occurredAt,
                    item.sessionId,
                    item.accountId,
                    item.eventType,
                    item.metadataJson
                );
            }
        });

        try {
            insertTx();
            this.buffer.splice(0, batchSize);
            return items.length;
        } catch (err) {
            this.isDegraded = true;
            console.error(`[SESSION_EVENT_BUFFER] ❌ Batch flush failed: ${err.message}`);
            return 0;
        }
    }

    findRecent(limit = 100) {
        this.flush();
        const bounded = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
        const rows = this.db.prepare(`
            SELECT * FROM session_events
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(bounded);

        return rows.map(r => this._hydrate(r));
    }

    findBySession(sessionId, limit = 50) {
        this.flush();
        const rows = this.db.prepare(`
            SELECT * FROM session_events
            WHERE session_id = ?
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(String(sessionId), limit);

        return rows.map(r => this._hydrate(r));
    }

    _hydrate(row) {
        let metadata = null;
        try {
            if (row.metadata_json) metadata = JSON.parse(row.metadata_json);
        } catch (_) {}

        return {
            id: row.id,
            occurredAt: new Date(row.occurred_at),
            sessionId: row.session_id,
            accountId: row.account_id,
            eventType: row.event_type,
            metadata
        };
    }
}

let defaultSessionEventRepo = null;
function getSessionEventRepository() {
    if (!defaultSessionEventRepo) {
        defaultSessionEventRepo = new SessionEventRepository();
    }
    return defaultSessionEventRepo;
}

module.exports = {
    SessionEventRepository,
    getSessionEventRepository
};
