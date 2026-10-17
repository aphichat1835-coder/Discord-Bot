"use strict";

const BATCH_SIZE = 500;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function deleteExpiredInBatches(db, tableName, conditionCol, cutoff, maxBatches = 5) {
    let totalDeleted = 0;
    const stmt = db.prepare(`
        DELETE FROM ${tableName}
        WHERE id IN (
            SELECT id FROM ${tableName}
            WHERE ${conditionCol} <= ?
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

function cleanExpiredNonces(db, now = Date.now(), maxBatches = 5) {
    return deleteExpiredInBatches(db, "verification_state_nonce", "expires_at", now, maxBatches);
}

function cleanExpiredDmNotifications(db, now = Date.now(), maxBatches = 5) {
    return deleteExpiredInBatches(db, "dm_notifications", "expires_at", now, maxBatches);
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
    const days = Number.parseInt(process.env.SQLITE_HISTORY_RETENTION_DAYS, 10);
    return (!Number.isNaN(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
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
            purged += deleteExpiredInBatches(db, table, col, cutoff, maxBatches);
        } catch (_err) {
            // Ignored: Table may not exist or be empty, continue safely
        }
    }

    return purged;
}

function cleanStaleQuestLogs(db, now = Date.now(), retentionMs = THIRTY_DAYS_MS, maxBatches = 2) {
    const cutoff = now - retentionMs;
    try {
        return deleteExpiredInBatches(db, "quest_logs", "created_at", cutoff, maxBatches);
    } catch (_err) {
        // Ignored: Table may not exist or be empty, continue safely
        return 0;
    }
}

function cleanExpiredVoiceAdminNotices(db, now = Date.now(), maxBatches = 5) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    try {
        let totalDeleted = 0;
        const stmt = db.prepare(`
            DELETE FROM voice_admin_notices
            WHERE (guild_id, actor_id, target_id) IN (
                SELECT guild_id, actor_id, target_id FROM voice_admin_notices
                WHERE notified_at <= ?
                LIMIT ${BATCH_SIZE}
            )
        `);
        for (let i = 0; i < maxBatches; i++) {
            const info = stmt.run(cutoff);
            totalDeleted += info.changes;
            if (info.changes < BATCH_SIZE) break;
        }
        return totalDeleted;
    } catch (_err) {
        // Ignored: Table may not exist or notice cleanup fails safely
        return 0;
    }
}

function runBoundedCleanup(db, options = {}) {
    if (!db) throw new TypeError("runBoundedCleanup requires an active database");
    const now = options.now || Date.now();

    const nonces = cleanExpiredNonces(db, now, options.maxBatches);
    const dms = cleanExpiredDmNotifications(db, now, options.maxBatches);
    const cache = cleanExpiredCacheEntries(db, now, options.maxBatches);
    const history = cleanExpiredHistory(db, now, options.maxBatches);
    const questLogs = cleanStaleQuestLogs(db, now, options.questRetentionMs, options.maxBatches);
    const notices = cleanExpiredVoiceAdminNotices(db, now, options.maxBatches);

    return {
        now,
        noncesDeleted: nonces,
        dmsDeleted: dms,
        cacheDeleted: cache,
        historyDeleted: history,
        questLogsDeleted: questLogs,
        noticesDeleted: notices,
        totalDeleted: nonces + dms + cache + history + questLogs + notices
    };
}

module.exports = {
    cleanExpiredNonces,
    cleanExpiredDmNotifications,
    cleanExpiredCacheEntries,
    cleanExpiredHistory,
    cleanStaleQuestLogs,
    cleanExpiredVoiceAdminNotices,
    runBoundedCleanup
};
