"use strict";

const BATCH_SIZE = 500;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function cleanExpiredNonces(db, now = Date.now(), maxBatches = 5) {
    let totalDeleted = 0;
    const stmt = db.prepare(`
        DELETE FROM verification_state_nonce
        WHERE id IN (
            SELECT id FROM verification_state_nonce
            WHERE expires_at <= ?
            LIMIT ${BATCH_SIZE}
        )
    `);

    for (let i = 0; i < maxBatches; i++) {
        const info = stmt.run(now);
        totalDeleted += info.changes;
        if (info.changes < BATCH_SIZE) break;
    }
    return totalDeleted;
}

function cleanExpiredDmNotifications(db, now = Date.now(), maxBatches = 5) {
    let totalDeleted = 0;
    const stmt = db.prepare(`
        DELETE FROM dm_notifications
        WHERE id IN (
            SELECT id FROM dm_notifications
            WHERE expires_at <= ?
            LIMIT ${BATCH_SIZE}
        )
    `);

    for (let i = 0; i < maxBatches; i++) {
        const info = stmt.run(now);
        totalDeleted += info.changes;
        if (info.changes < BATCH_SIZE) break;
    }
    return totalDeleted;
}

function cleanExpiredCacheEntries(db, now = Date.now(), maxBatches = 5) {
    let totalDeleted = 0;
    const stmt = db.prepare(`
        DELETE FROM cache_entries
        WHERE (namespace, cache_key) IN (
            SELECT namespace, cache_key FROM cache_entries
            WHERE expires_at IS NOT NULL AND expires_at <= ?
            LIMIT ${BATCH_SIZE}
        )
    `);

    for (let i = 0; i < maxBatches; i++) {
        const info = stmt.run(now);
        totalDeleted += info.changes;
        if (info.changes < BATCH_SIZE) break;
    }
    return totalDeleted;
}

function resolveHistoryRetentionMs() {
    const days = parseInt(process.env.SQLITE_HISTORY_RETENTION_DAYS, 10);
    return (!isNaN(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

function cleanExpiredHistory(db, now = Date.now(), maxBatches = 5) {
    const retentionMs = resolveHistoryRetentionMs();
    const cutoff = now - retentionMs;
    let purged = 0;

    const historyConfigs = [
        { table: "command_events", col: "occurred_at" },
        { table: "session_events", col: "occurred_at" },
        { table: "runtime_events", col: "occurred_at" },
        { table: "voice_events", col: "occurred_at" }
    ];

    for (const { table, col } of historyConfigs) {
        try {
            const stmt = db.prepare(`
                DELETE FROM ${table}
                WHERE id IN (
                    SELECT id FROM ${table}
                    WHERE ${col} <= ?
                    LIMIT ${BATCH_SIZE}
                )
            `);

            for (let i = 0; i < maxBatches; i++) {
                const info = stmt.run(cutoff);
                purged += info.changes;
                if (info.changes < BATCH_SIZE) break;
            }
        } catch (_) {
            // Table may not exist or be empty, continue safely
        }
    }

    return purged;
}

function cleanStaleQuestLogs(db, now = Date.now(), retentionMs = THIRTY_DAYS_MS, maxBatches = 2) {
    const cutoff = now - retentionMs;
    let totalDeleted = 0;
    const stmt = db.prepare(`
        DELETE FROM quest_logs
        WHERE id IN (
            SELECT id FROM quest_logs
            WHERE created_at <= ?
            LIMIT ${BATCH_SIZE}
        )
    `);

    for (let i = 0; i < maxBatches; i++) {
        const info = stmt.run(cutoff);
        totalDeleted += info.changes;
        if (info.changes < BATCH_SIZE) break;
    }
    return totalDeleted;
}

function runBoundedCleanup(db, options = {}) {
    if (!db) throw new TypeError("runBoundedCleanup requires an active database");
    const now = options.now || Date.now();

    const nonces = cleanExpiredNonces(db, now, options.maxBatches);
    const dms = cleanExpiredDmNotifications(db, now, options.maxBatches);
    const cache = cleanExpiredCacheEntries(db, now, options.maxBatches);
    const history = cleanExpiredHistory(db, now, options.maxBatches);

    return {
        now,
        noncesDeleted: nonces,
        dmsDeleted: dms,
        cacheDeleted: cache,
        historyDeleted: history,
        totalDeleted: nonces + dms + cache + history
    };
}

module.exports = {
    cleanExpiredNonces,
    cleanExpiredDmNotifications,
    cleanExpiredCacheEntries,
    cleanExpiredHistory,
    cleanStaleQuestLogs,
    runBoundedCleanup
};
