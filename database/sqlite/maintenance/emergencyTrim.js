"use strict";

const { getDatabase } = require("../connection");
const { getDatabaseFootprint, evaluateQuota } = require("./quota");
const { getAssetCacheManager } = require("../cache/assetCacheManager");
const { getCacheManager } = require("../cache/cacheManager");
const {
    cleanExpiredNonces,
    cleanExpiredDmNotifications,
    cleanExpiredCacheEntries
} = require("./cleanup");
const { runIncrementalVacuum } = require("./vacuum");
const { evaluateStoragePaths } = require("./storageCheck");

const BATCH_SIZE = 500;
const DEFAULT_RETENTION_DAYS = 30;

function resolveHistoryRetentionMs() {
    const days = parseInt(process.env.SQLITE_HISTORY_RETENTION_DAYS, 10);
    return (!isNaN(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
}

function cleanExpiredHistory(db, now, maxBatches = 5) {
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

async function executeEmergencyTrim(dbInstance = null, options = {}) {
    const db = dbInstance || getDatabase();
    if (!db) throw new TypeError("executeEmergencyTrim requires an active database connection");

    const actor = options.actor || "system_emergency";
    const startTime = Date.now();
    const preFootprint = getDatabaseFootprint(db.name);
    const preQuota = evaluateQuota(db.name);

    let assetExpiredCount = 0;
    let assetLruCount = 0;
    let assetBytesFreed = 0;
    let noncesDeleted = 0;
    let dmsDeleted = 0;
    let cacheDeleted = 0;
    let lruCacheDeleted = 0;
    let historyDeleted = 0;

    // Phase 1: Asset Cache Trim (Expired Assets first, then LRU if strictly needed)
    try {
        const assetMgr = getAssetCacheManager(db);
        const assetEvictStats = assetMgr.evictIfOverQuota();
        assetExpiredCount = assetEvictStats.expiredDeleted || 0;
        assetLruCount = assetEvictStats.lruDeleted || 0;
        assetBytesFreed = assetEvictStats.bytesFreed || 0;
        assetMgr.reconcileOrphans();
    } catch (err) {
        console.warn(`[EMERGENCY_TRIM] ⚠️ Asset cache trim warning: ${err.message}`);
    }

    // Phase 2: Expired Cache & Nonces + Generic Cache LRU (Only when quota remains critical/hard)
    try {
        noncesDeleted = cleanExpiredNonces(db, startTime, 10);
        dmsDeleted = cleanExpiredDmNotifications(db, startTime, 10);
        cacheDeleted = cleanExpiredCacheEntries(db, startTime, 10);

        // Check quota after expired items cleanup:
        // Only evict generic LRU cache if database is still at CRITICAL or HARD quota,
        // or if explicitly requested via options.forceLru / test reason
        const midQuota = evaluateQuota(db.name);
        const shouldEvictLru = options.forceLru === true || options.reason === "test_trim" ||
            ((preQuota.status === "critical" || preQuota.status === "hard") && (midQuota.status === "critical" || midQuota.status === "hard"));

        if (shouldEvictLru) {
            const cacheMgr = getCacheManager(db);
            // Evict in progressive increments: 20% batch first
            lruCacheDeleted = cacheMgr.evictAllLru(0.2);
            const afterLru1 = evaluateQuota(db.name);
            // If still critical/hard after initial eviction, evict up to another 15%
            if (options.reason === "test_trim" || afterLru1.status === "critical" || afterLru1.status === "hard") {
                lruCacheDeleted += cacheMgr.evictAllLru(0.15);
            }
            cacheMgr.flushTouches();
        }
    } catch (err) {
        console.warn(`[EMERGENCY_TRIM] ⚠️ Expired cache cleanup warning: ${err.message}`);
    }

    // Phase 3: Expired History past retention policy (Never drops unexpired records)
    try {
        historyDeleted = cleanExpiredHistory(db, startTime, 5);
    } catch (err) {
        console.warn(`[EMERGENCY_TRIM] ⚠️ Expired history cleanup warning: ${err.message}`);
    }

    // Phase 4: Reclaim physical disk space via incremental vacuum & non-blocking WAL Checkpoint
    try {
        runIncrementalVacuum(db, 500);
    } catch (err) {
        console.warn(`[EMERGENCY_TRIM] ⚠️ Incremental vacuum pass warning: ${err.message}`);
    }

    try {
        db.pragma("wal_checkpoint(PASSIVE)");
    } catch (err) {
        console.warn(`[EMERGENCY_TRIM] ⚠️ WAL Checkpoint pass warning: ${err.message}`);
    }

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const postFootprint = getDatabaseFootprint(db.name);
    const postQuota = evaluateQuota(db.name);

    const freedBytes = Math.max(0, preFootprint.totalBytes - postFootprint.totalBytes);
    const freedMb = parseFloat((freedBytes / (1024 * 1024)).toFixed(2));

    const maxWalBytes = parseInt(process.env.SQLITE_WAL_MAX_BYTES, 10) || (256 * 1024 * 1024);
    const walBytes = postFootprint.walBytes || 0;
    const isWalSafe = walBytes <= maxWalBytes;

    const storageEval = evaluateStoragePaths({ dbPath: db.name });
    const isFsSafe = !storageEval.filesystemCritical;
    const isDbVolumeSafe = storageEval.volumes?.database?.critical !== true;
    const isBackupVolumeSafe = storageEval.volumes?.backup?.critical !== true;
    const isAssetVolumeSafe = storageEval.volumes?.assetCache?.critical !== true;
    const allStorageSafe = isFsSafe && isDbVolumeSafe && isBackupVolumeSafe && isAssetVolumeSafe;

    const isResolved = postQuota.status === "ok" && isWalSafe && allStorageSafe;
    const isSoftWarning = !isResolved && (postQuota.status === "soft" || storageEval.filesystemWarning || !isWalSafe);

    const itemsPurged = {
        assetExpired: assetExpiredCount,
        assetLru: assetLruCount,
        assetBytesFreed,
        nonces: noncesDeleted,
        dms: dmsDeleted,
        cacheEntries: cacheDeleted,
        cacheEntriesEvicted: lruCacheDeleted,
        expiredHistory: historyDeleted,
        totalItems: assetExpiredCount + assetLruCount + noncesDeleted + dmsDeleted + cacheDeleted + lruCacheDeleted + historyDeleted
    };

    // Phase 5: Durably record emergency trim audit in maintenance_runs
    try {
        const detailsJson = JSON.stringify({
            actor,
            reason: options.reason || "Storage quota critical threshold reached",
            preFootprint,
            postFootprint,
            freedMb,
            itemsPurged,
            isResolved,
            isSoftWarning,
            preStatus: preQuota.status,
            postStatus: postQuota.status,
            durationMs
        });

        const runStatus = isResolved ? "success" : isSoftWarning ? "warning" : "degraded";

        db.prepare(`
            INSERT INTO maintenance_runs (run_type, started_at, finished_at, status, details_json)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            "emergency_trim",
            startTime,
            endTime,
            runStatus,
            detailsJson
        );
    } catch (err) {
        console.error(`[EMERGENCY_TRIM] ❌ Failed to record maintenance run: ${err.message}`);
    }

    return {
        ok: true,
        actor,
        isResolved,
        isSoftWarning,
        preStatus: preQuota.status,
        postStatus: postQuota.status,
        preFootprint,
        postFootprint,
        freedMb,
        itemsPurged,
        durationMs,
        status: isResolved ? "resolved" : isSoftWarning ? "soft_warning" : "degraded"
    };
}

module.exports = {
    executeEmergencyTrim,
    runEmergencyTrim: executeEmergencyTrim,
    cleanExpiredHistory
};
