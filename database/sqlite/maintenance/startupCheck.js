"use strict";

const { runMigrations } = require("../migrations/migrationRunner");
const { evaluateQuota } = require("./quota");
const { runBoundedCleanup } = require("./cleanup");
const { evaluateStoragePaths } = require("./storageCheck");

function _checkPragmas(db) {
    const journalMode = db.pragma("journal_mode", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    if (journalMode.toLowerCase() !== "wal" || foreignKeys !== 1) {
        throw new Error(`[SQLITE] ❌ Invariant failure: Expected WAL mode and foreign_keys=1, got ${journalMode}, ${foreignKeys}`);
    }
}

function _checkReadProbe(db) {
    const readRow = db.prepare("SELECT 1 AS probe").get();
    if (readRow?.probe !== 1) {
        throw new Error("[SQLITE] ❌ Read probe failed: SELECT 1 returned unexpected output");
    }
}

function _checkWriteRollbackProbe(db) {
    const testKey = `__startup_probe_${Date.now()}`;
    const testTx = db.transaction(() => {
        db.prepare("INSERT INTO database_meta (key, value, updated_at) VALUES (?, ?, ?)").run(testKey, "probing", Date.now());
        const verifyInTx = db.prepare("SELECT value FROM database_meta WHERE key = ?").get(testKey);
        if (verifyInTx?.value !== "probing") {
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

    const verifyAfter = db.prepare("SELECT value FROM database_meta WHERE key = ?").get(testKey);
    if (verifyAfter) {
        throw new Error("[SQLITE] ❌ Write/Rollback probe failed: transaction was not rolled back cleanly");
    }
}

function _checkQuickIntegrity(db) {
    const integrityRows = db.pragma("quick_check(10)");
    const isIntegrityOk = integrityRows.length === 1 && (integrityRows[0].quick_check === "ok" || integrityRows[0] === "ok");
    if (!isIntegrityOk) {
        throw new Error(`[SQLITE] ❌ Quick integrity check failed: ${JSON.stringify(integrityRows)}`);
    }
}

function _runInitialCleanup(db, results) {
    try {
        const cleanupStats = runBoundedCleanup(db, { maxBatches: 1 });
        results.checks.initialCleanup = true;
        results.stats.cleanup = cleanupStats;
    } catch (cleanupErr) {
        // Cleanup warning does not block startup
        results.stats.cleanupError = cleanupErr.message;
    }
}

function _checkStorage(options, results) {
    const storageInfo = evaluateStoragePaths({
        dbPath: options.dbPath,
        backupDir: options.backupDir,
        assetDir: options.assetDir
    });
    if (!storageInfo.ok) {
        throw new Error(`Storage pre-flight check failed: ${storageInfo.errors.join("; ")}`);
    }
    if (storageInfo.pathWarning && process.env.NODE_ENV === "production") {
        console.warn(storageInfo.warnings.find(w => w.includes("PRODUCTION_STORAGE")) || "[STORAGE] ⚠️ Running with in-source storage in production.");
    }
    results.checks.storage = true;
    results.stats.storage = storageInfo;
}

function runStartupCheck(db, options = {}) {
    if (!db?.open) {
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

    results.checks.connection = true;

    _checkPragmas(db);
    results.checks.pragmas = true;

    results.stats.migration = runMigrations(db, options);
    results.checks.migrations = true;

    _checkReadProbe(db);
    results.checks.readProbe = true;

    _checkWriteRollbackProbe(db);
    results.checks.writeRollbackProbe = true;

    _checkQuickIntegrity(db);
    results.checks.quickIntegrity = true;

    _runInitialCleanup(db, results);

    if (options.dbPath) {
        results.stats.quota = evaluateQuota(options.dbPath);
        results.checks.quota = true;
    }

    _checkStorage(options, results);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
    results.stats.tablesCount = tables.length;
    results.stats.tables = tables;

    results.durationMs = Date.now() - startTime;
    results.ok = true;

    return results;
}

module.exports = { runStartupCheck };
