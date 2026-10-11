"use strict";

const { runMigrations } = require("../migrations/migrationRunner");
const { evaluateQuota } = require("./quota");
const { runBoundedCleanup } = require("./cleanup");
const { evaluateStoragePaths } = require("./storageCheck");

function runStartupCheck(db, options = {}) {
    if (!db || !db.open) {
        throw new Error("[SQLITE] ❌ Cannot perform startup check: database connection is not open");
    }

    const startTime = Date.now();
    const results = {
        ok: false,
        dbPath: options.dbPath || null,
        checks: {
            connection: false,
            pragmas: false,
            migrations: false,
            readProbe: false,
            writeRollbackProbe: false,
            quickIntegrity: false,
            quota: false,
            initialCleanup: false
        },
        stats: {},
        durationMs: 0
    };

    // 1. Connection check
    results.checks.connection = true;

    // 2. PRAGMAs check
    const journalMode = db.pragma("journal_mode", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    if (journalMode.toLowerCase() !== "wal" || foreignKeys !== 1) {
        throw new Error(`[SQLITE] ❌ Invariant failure: Expected WAL mode and foreign_keys=1, got ${journalMode}, ${foreignKeys}`);
    }
    results.checks.pragmas = true;

    // 3. Migrations
    const migrationResults = runMigrations(db, options);
    results.checks.migrations = true;
    results.stats.migration = migrationResults;

    // 4. Read probe
    const readRow = db.prepare("SELECT 1 AS probe").get();
    if (!readRow || readRow.probe !== 1) {
        throw new Error("[SQLITE] ❌ Read probe failed: SELECT 1 returned unexpected output");
    }
    results.checks.readProbe = true;

    // 5. Write and Rollback probe (verifies write permissions, journal logging, and rollback integrity)
    const testKey = `__startup_probe_${Date.now()}`;
    const testTx = db.transaction(() => {
        db.prepare("INSERT INTO database_meta (key, value, updated_at) VALUES (?, ?, ?)").run(testKey, "probing", Date.now());
        const verifyInTx = db.prepare("SELECT value FROM database_meta WHERE key = ?").get(testKey);
        if (!verifyInTx || verifyInTx.value !== "probing") {
            throw new Error("Write probe verification within transaction failed");
        }
        // Deliberately throw to rollback!
        throw new Error("__EXPECTED_ROLLBACK__");
    });

    try {
        testTx();
    } catch (err) {
        if (err.message !== "__EXPECTED_ROLLBACK__") {
            throw new Error(`[SQLITE] ❌ Write/Rollback probe failed unexpectedly: ${err.message}`);
        }
    }

    // Confirm row was indeed rolled back
    const verifyAfter = db.prepare("SELECT value FROM database_meta WHERE key = ?").get(testKey);
    if (verifyAfter) {
        throw new Error("[SQLITE] ❌ Write/Rollback probe failed: transaction was not rolled back cleanly");
    }
    results.checks.writeRollbackProbe = true;

    // 6. Quick integrity check
    const integrityRows = db.pragma("quick_check(10)");
    const isIntegrityOk = integrityRows.length === 1 && (integrityRows[0].quick_check === "ok" || integrityRows[0] === "ok");
    if (!isIntegrityOk) {
        throw new Error(`[SQLITE] ❌ Quick integrity check failed: ${JSON.stringify(integrityRows)}`);
    }
    results.checks.quickIntegrity = true;

    // 7. Initial bounded cleanup
    try {
        const cleanupStats = runBoundedCleanup(db, { maxBatches: 1 });
        results.checks.initialCleanup = true;
        results.stats.cleanup = cleanupStats;
    } catch (cleanupErr) {
        // Cleanup warning does not block startup
        results.stats.cleanupError = cleanupErr.message;
    }

    // 8. Quota & Footprint
    if (options.dbPath) {
        const quotaInfo = evaluateQuota(options.dbPath);
        results.checks.quota = true;
        results.stats.quota = quotaInfo;
    }

    // 9. Storage Pre-Flight Check (Fails only on actual filesystem failure / disk < 100MB)
    try {
        const storageInfo = evaluateStoragePaths({ dbPath: options.dbPath });
        if (!storageInfo.ok) {
            throw new Error(`Storage pre-flight check failed: ${storageInfo.errors.join("; ")}`);
        }
        if (storageInfo.pathWarning && process.env.NODE_ENV === "production") {
            console.warn(storageInfo.warnings.find(w => w.includes("PRODUCTION_STORAGE")) || "[STORAGE] ⚠️ Running with in-source storage in production.");
        }
        results.checks.storage = true;
        results.stats.storage = storageInfo;
    } catch (storageErr) {
        throw storageErr;
    }

    // Gather table counts & stats (0 rows is completely healthy!)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
    results.stats.tablesCount = tables.length;
    results.stats.tables = tables;

    results.durationMs = Date.now() - startTime;
    results.ok = true;

    return results;
}

module.exports = { runStartupCheck };
