"use strict";

const { getDatabase } = require("../../connection");
const { resolvePriority, evictWithPriority, notifyBufferDropped, notifyP1Dropped } = require("./bufferPolicy");
const p0Journal = require("./p0Journal");
const writePolicy = require("../../maintenance/writePolicy");

class BaseBufferedEventRepository {
    constructor({ tableName, repoName, logPrefix, db = null, maxQueueCap = 2000, flushSizeThreshold = 100 }) {
        this.tableName = tableName;
        this.repoName = repoName || this.constructor.name;
        this.logPrefix = logPrefix || `[${this.tableName.toUpperCase()}_BUFFER]`;
        this._db = db;
        this.buffer = [];
        this.criticalRetryQueue = [];
        this.flushInterval = null;
        this.maxQueueCap = maxQueueCap;
        this.flushSizeThreshold = flushSizeThreshold;
        this.isDegraded = false;
        this.droppedEventsCount = 0;
        this.p0StorageFailureCount = 0;
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
            while (this.criticalRetryQueue.length > 0) {
                const cItem = this.criticalRetryQueue[0];
                try {
                    this._insertSingle(cItem);
                    this.criticalRetryQueue.shift();
                } catch (_) {
                    const spooled = p0Journal.spoolP0Event(this.tableName, cItem);
                    if (spooled) {
                        this.criticalRetryQueue.shift();
                    } else {
                        break;
                    }
                }
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
            criticalQueueCount: this.criticalRetryQueue.length,
            maxQueueCap: this.maxQueueCap,
            maxCriticalCap: 500,
            flushSizeThreshold: this.flushSizeThreshold,
            isDegraded: this.isDegraded,
            droppedEventsCount: this.droppedEventsCount,
            p0StorageFailureCount: this.p0StorageFailureCount || 0,
            p0Guaranteed: (this.p0StorageFailureCount || 0) === 0
        };
    }

    handleP0Enqueue(item, err) {
        this.isDegraded = true;
        if (this.criticalRetryQueue.length < 100) {
            this.criticalRetryQueue.push(item);
        } else {
            const spooled = p0Journal.spoolP0Event(this.tableName, item);
            if (!spooled) {
                if (this.criticalRetryQueue.length < 500) {
                    this.criticalRetryQueue.push(item);
                } else {
                    this.p0StorageFailureCount = (this.p0StorageFailureCount || 0) + 1;
                    console.error(`${this.logPrefix} 🚨 CRITICAL P0 STORAGE FAILURE: SQLite insert failed, memory retry queue full (500), and emergency journal spool failed! Event persistence cannot be guaranteed.`);
                }
            }
        }
        console.error(`${this.logPrefix} 🚨 CRITICAL P0 event insert failed (queued for retry): ${err.message}`);
    }

    enqueueItem(item) {
        if (item.priority === "P0") {
            try {
                this._insertSingle(item);
            } catch (err) {
                this.handleP0Enqueue(item, err);
            }
            return;
        }

        if (item.priority === "P2" && !writePolicy.canWrite("telemetry", { priority: "P2" })) {
            return;
        }

        if (this.buffer.length >= this.maxQueueCap) {
            const dropTarget = Math.min(500, Math.max(1, Math.floor(this.maxQueueCap / 4)));
            const stats = {};
            const dropCount = evictWithPriority(this.buffer, dropTarget, stats);
            if (dropCount > 0) {
                this.droppedEventsCount += dropCount;
                this.isDegraded = true;
                console.warn(`${this.logPrefix} ⚠️ Queue reached capacity (${this.maxQueueCap}). Dropped ${dropCount} low-priority events.`);
                notifyBufferDropped(this.repoName, dropCount, this.maxQueueCap, this.droppedEventsCount);
                if (stats.p1 > 0) {
                    notifyP1Dropped(this.repoName, stats.p1, this.droppedEventsCount);
                }
            }
        }

        this.buffer.push(item);
        if (this.buffer.length >= this.flushSizeThreshold) {
            this.flush();
        }
    }

    flush() {
        if (this.criticalRetryQueue.length > 0) {
            while (this.criticalRetryQueue.length > 0) {
                const cItem = this.criticalRetryQueue[0];
                try {
                    this._insertSingle(cItem);
                    this.criticalRetryQueue.shift();
                } catch (_) {
                    break;
                }
            }
        } else {
            try {
                p0Journal.drainP0Spool(this.db, { [this.tableName]: this });
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
                console.warn(`${this.logPrefix} ⚠️ Storage hard limit active. Dropped ${droppedP2} P2 events; preserved P1 events in memory.`);
            }
            return 0;
        }

        const stmt = this.getInsertStatement();
        const insertTx = this.db.transaction(() => {
            for (const item of items) {
                this.runInsertStatement(stmt, item);
            }
        });

        try {
            insertTx();
            this.buffer.splice(0, batchSize);
            return batchSize;
        } catch (err) {
            this.isDegraded = true;
            console.error(`${this.logPrefix} ❌ Flush failed: ${err.message}`);
            return 0;
        }
    }

    _insertSingle(item) {
        const stmt = this.getInsertStatement();
        this.runInsertStatement(stmt, item);
    }

    findRecent(limit = 100) {
        this.flush();
        const bounded = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
        const rows = this.db.prepare(`
            SELECT * FROM ${this.tableName}
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(bounded);

        return rows.map(r => this._hydrate(r));
    }

    findBySession(sessionId, limit = 50) {
        this.flush();
        const rows = this.db.prepare(`
            SELECT * FROM ${this.tableName}
            WHERE session_id = ?
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(String(sessionId), limit);

        return rows.map(r => this._hydrate(r));
    }

    _hydrate(row) {
        throw new Error("_hydrate must be implemented by subclass");
    }

    getInsertStatement() {
        throw new Error("getInsertStatement must be implemented by subclass");
    }

    runInsertStatement(stmt, item) {
        throw new Error("runInsertStatement must be implemented by subclass");
    }
}

module.exports = BaseBufferedEventRepository;
