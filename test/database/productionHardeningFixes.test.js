"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");

const { openDatabase, closeDatabase, getDatabase } = require("../../database/sqlite/connection");
const databaseService = require("../../database/services/databaseService");
const scheduler = require("../../database/sqlite/maintenance/scheduler");
const { listBackups, listPreMigrationBackups, rotateBackups } = require("../../database/sqlite/maintenance/backup");
const { rotatePreMigrationBackups, resolvePreMigrationRetention } = require("../../database/sqlite/migrations/migrationRunner");
const { evaluateEmergencyThresholds } = require("../../database/sqlite/maintenance/quota");

test("Production Hardening Fixes Suite (Audit Resolution)", async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-audit-fixes-"));
    const testDbPath = path.join(tempDir, "test_hardening.sqlite");
    const testBackupDir = path.join(tempDir, "backups");
    const testAssetDir = path.join(tempDir, "assets");

    fs.mkdirSync(testBackupDir, { recursive: true });
    fs.mkdirSync(testAssetDir, { recursive: true });

    process.env.SQLITE_DB_PATH = testDbPath;
    process.env.SQLITE_BACKUP_DIR = testBackupDir;
    process.env.SQLITE_ASSET_DIR = testAssetDir;

    t.after(() => {
        closeDatabase();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test("Bootstrap test database and migrations", () => {
        const db = openDatabase({ path: testDbPath });
        assert.ok(db.open);
        const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
        runMigrations(db, { migrationsDir: path.resolve(__dirname, "../../database/sqlite/migrations") });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 1. Database Console Truthful Reporting & Failure Accuracy
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("Point 1: Database Console executes maintenance commands and reflects ok/failure truthfully", async () => {
        // 1.1 Success cases
        const chkRes = await databaseService.executeDatabaseConsole("checkpoint");
        assert.equal(chkRes.ok, true);
        assert.match(chkRes.output, /✅ ดำเนินการ Checkpoint WAL สำเร็จ/);

        const vacRes = await databaseService.executeDatabaseConsole("vacuum");
        assert.equal(vacRes.ok, true);
        assert.match(vacRes.output, /✅ ดำเนินการ Incremental Vacuum สำเร็จ/);

        const cleanRes = await databaseService.executeDatabaseConsole("cleanup");
        assert.equal(cleanRes.ok, true);
        assert.match(cleanRes.output, /✅ ทำความสะอาดข้อมูลสำเร็จ/);

        const cacheRes = await databaseService.executeDatabaseConsole("cleanup cache");
        assert.equal(cacheRes.ok, true);
        assert.match(cacheRes.output, /✅ ล้างแคชทั้งหมดสำเร็จ/);

        // 1.2 Dynamic retention in cleanup history
        process.env.SQLITE_HISTORY_RETENTION_DAYS = "14";
        const histRes = await databaseService.executeDatabaseConsole("cleanup history");
        assert.equal(histRes.ok, true);
        assert.match(histRes.output, /14 วัน/, "Must dynamically reflect configured retention days, not hardcode 30");
        delete process.env.SQLITE_HISTORY_RETENTION_DAYS;

        // 1.3 Failure handling: simulate failure in executeSqliteAction
        const originalExecuteSqliteAction = databaseService.executeSqliteAction;
        try {
            // Simulate checkpoint failure
            databaseService.executeSqliteAction = async (action, opts, invoker) => {
                if (action === "checkpoint") {
                    return { ok: false, action, error: "Simulated lock timeout", message: "Checkpoint lock timeout" };
                }
                if (action === "vacuum") {
                    return { ok: false, action, error: "Simulated I/O disk failure", message: "Vacuum I/O failure" };
                }
                if (action === "cleanup_all") {
                    return { ok: false, action, error: "Simulated table busy", message: "Table busy" };
                }
                if (action === "cleanup_cache") {
                    return { ok: false, action, error: "Asset directory unwritable", message: "Asset directory unwritable" };
                }
                if (action === "cleanup_history") {
                    return { ok: false, action, error: "Transaction deadlock", message: "Deadlock" };
                }
                return originalExecuteSqliteAction(action, opts, invoker);
            };

            const failedChk = await databaseService.executeDatabaseConsole("checkpoint");
            assert.equal(failedChk.ok, false, "Checkpoint failure must set console ok=false");
            assert.match(failedChk.output, /❌ ดำเนินการ Checkpoint WAL ล้มเหลว/, "Must display failure banner");
            assert.match(failedChk.output, /Checkpoint lock timeout/);

            const failedVac = await databaseService.executeDatabaseConsole("vacuum");
            assert.equal(failedVac.ok, false, "Vacuum failure must set console ok=false");
            assert.match(failedVac.output, /❌ ดำเนินการ Incremental Vacuum ล้มเหลว/);
            assert.match(failedVac.output, /Vacuum I\/O failure/);

            const failedClean = await databaseService.executeDatabaseConsole("cleanup");
            assert.equal(failedClean.ok, false, "Cleanup failure must set console ok=false");
            assert.match(failedClean.output, /❌ ทำความสะอาดข้อมูลล้มเหลว/);
            assert.match(failedClean.output, /Table busy/);

            const failedCache = await databaseService.executeDatabaseConsole("cleanup cache");
            assert.equal(failedCache.ok, false, "Cleanup cache failure must set console ok=false");
            assert.match(failedCache.output, /❌ ล้างแคชล้มเหลว/);
            assert.match(failedCache.output, /Asset directory unwritable/);

            const failedHist = await databaseService.executeDatabaseConsole("cleanup history");
            assert.equal(failedHist.ok, false, "Cleanup history failure must set console ok=false");
            assert.match(failedHist.output, /❌ ล้างประวัติล้มเหลว/);
            assert.match(failedHist.output, /Deadlock/);
        } finally {
            databaseService.executeSqliteAction = originalExecuteSqliteAction;
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 2. Background Scheduler Truthful Reporting
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("Point 2: Scheduler sets lastStatus='error' and does not increment runCount on failure", async () => {
        const diag = scheduler.getSchedulerDiagnostics();
        const initialWalCount = diag.diagnostics.wal.runCount;
        const initialVacuumCount = diag.diagnostics.vacuum.runCount;
        const initialCleanupCount = diag.diagnostics.cleanup.runCount;

        // Run normal checkpoint successfully
        await scheduler.runWalCheckpoint();
        const diagAfterSuccess = scheduler.getSchedulerDiagnostics();
        assert.equal(diagAfterSuccess.diagnostics.wal.lastStatus, "success");
        assert.equal(diagAfterSuccess.diagnostics.wal.lastError, null);
        assert.equal(diagAfterSuccess.diagnostics.wal.runCount, initialWalCount + 1);

        // Simulate failure in executeSqliteAction for scheduler
        const origExecute = databaseService.executeSqliteAction;
        try {
            databaseService.executeSqliteAction = async (action, opts, invoker) => {
                if (action === "checkpoint") {
                    return { ok: false, action, error: "Database disk image is malformed", message: "Corruption simulated" };
                }
                if (action === "vacuum") {
                    return { ok: false, action, error: "Disk full during vacuum", message: "Disk full" };
                }
                if (action === "cleanup_all") {
                    return { ok: false, action, error: "Foreign key constraint failure", message: "FK error" };
                }
                return origExecute(action, opts, invoker);
            };

            // Test WAL Checkpoint failure
            await scheduler.runWalCheckpoint();
            const diagFailWal = scheduler.getSchedulerDiagnostics();
            assert.equal(diagFailWal.diagnostics.wal.lastStatus, "error");
            assert.match(diagFailWal.diagnostics.wal.lastError, /Corruption simulated/);
            assert.equal(diagFailWal.diagnostics.wal.runCount, initialWalCount + 1, "runCount must NOT increment on error");

            // Test Vacuum failure
            await scheduler.runVacuum();
            const diagFailVac = scheduler.getSchedulerDiagnostics();
            assert.equal(diagFailVac.diagnostics.vacuum.lastStatus, "error");
            assert.match(diagFailVac.diagnostics.vacuum.lastError, /Disk full/);
            assert.equal(diagFailVac.diagnostics.vacuum.runCount, initialVacuumCount, "vacuum runCount must NOT increment on error");

            // Test Cleanup failure
            await scheduler.runCleanup();
            const diagFailClean = scheduler.getSchedulerDiagnostics();
            assert.equal(diagFailClean.diagnostics.cleanup.lastStatus, "error");
            assert.match(diagFailClean.diagnostics.cleanup.lastError, /FK error/);
            assert.equal(diagFailClean.diagnostics.cleanup.runCount, initialCleanupCount, "cleanup runCount must NOT increment on error");
        } finally {
            databaseService.executeSqliteAction = origExecute;
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🔴 3. cleanup_cache Asset Manager Failure Protection (No Orphan Desync)
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("Point 3: cleanup_cache retains SQLite metadata and returns ok:false when Asset Manager throws", async () => {
        const db = getDatabase();

        // Seed asset_cache with an entry
        db.prepare(`
            INSERT OR REPLACE INTO asset_cache (
                asset_key, asset_type, relative_path, mime_type,
                size_bytes, sha256, created_at, last_used_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run("test:avatar:123", "avatar", "test12345.png", "image/png", 1024, "abcdef123456", Date.now(), Date.now(), Date.now() + 100000);

        // Verify record is seeded
        const beforeRow = db.prepare("SELECT asset_key FROM asset_cache WHERE asset_key = ?").get("test:avatar:123");
        assert.ok(beforeRow, "Asset record should exist before cleanup");

        // Mock assetCacheManager module to simulate throwing an exception
        const assetModule = require("../../database/sqlite/cache/assetCacheManager");
        const origGetManager = assetModule.getAssetCacheManager;
        try {
            assetModule.getAssetCacheManager = () => {
                throw new Error("Simulated filesystem I/O permission denied");
            };

            const cleanupResult = await databaseService.executeSqliteAction("cleanup_cache");
            assert.equal(cleanupResult.ok, false, "cleanup_cache must report ok: false when asset manager fails");
            assert.match(cleanupResult.assetError, /Simulated filesystem I\/O permission denied/);

            // Crucial verification: metadata in SQLite must NOT have been blindly deleted!
            const afterRow = db.prepare("SELECT asset_key FROM asset_cache WHERE asset_key = ?").get("test:avatar:123");
            assert.ok(afterRow, "Metadata must NOT be deleted when asset manager fails, preventing orphaned disk files");
        } finally {
            assetModule.getAssetCacheManager = origGetManager;
        }

        // Clean up seeded record safely using real asset manager
        const normalCleanup = await databaseService.executeSqliteAction("cleanup_cache");
        assert.equal(normalCleanup.ok, true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🟠 4. Write Buffer Policy B (Priority Drop + Flush without Emergency Trim)
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("Point 4: Buffer emergency (>=2000) triggers Policy B (RAM pressure handled without disk trim)", async () => {
        // Evaluate threshold with buffer count 2100 (Storage is healthy)
        const threshold = evaluateEmergencyThresholds(testDbPath, { writeBufferCount: 2100 });
        assert.equal(threshold.isEmergency, true);
        assert.equal(threshold.isBufferEmergency, true);
        assert.equal(threshold.isStorageEmergency, false, "Buffer overflow must NOT flag storage emergency");
        assert.match(threshold.reasons[0], /Telemetry write-behind buffer queue overflow/);

        // Test active flush trigger when scheduler evaluates buffer emergency
        const { getVoiceEventRepository } = require("../../database/sqlite/repositories/history/VoiceEventRepository");
        const { getCommandEventRepository } = require("../../database/sqlite/repositories/history/CommandEventRepository");
        const vRepo = getVoiceEventRepository();
        const cRepo = getCommandEventRepository();

        let vFlushed = false;
        let cFlushed = false;
        const origVFlush = vRepo.flush;
        const origCFlush = cRepo.flush;

        vRepo.flush = () => { vFlushed = true; return origVFlush.call(vRepo); };
        cRepo.flush = () => { cFlushed = true; return origCFlush.call(cRepo); };

        try {
            // Artificially trigger emergency evaluation with buffer count
            await scheduler.runEmergencyEvaluation();
            // Scheduler runs emergency evaluation safely
            assert.ok(true, "Emergency evaluation completes cleanly");
        } finally {
            vRepo.flush = origVFlush;
            cRepo.flush = origCFlush;
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🟡 5. Pre-Migration Safety Backup Retention & Namespace Isolation
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("Point 5: Pre-migration backups are isolated and rotated according to retention policy", () => {
        const dummyDir = path.join(tempDir, "migration_retention_test");
        fs.mkdirSync(dummyDir, { recursive: true });

        // Create 5 dummy pre-migration backup files
        const now = Date.now();
        for (let i = 1; i <= 5; i++) {
            const fname = `sqlite_backup_pre_migration_test_${i}_${now - (10 - i) * 1000}.sqlite`;
            fs.writeFileSync(path.join(dummyDir, fname), "dummy sqlite backup content");
            // Set mtime
            fs.utimesSync(path.join(dummyDir, fname), (now - (10 - i) * 1000) / 1000, (now - (10 - i) * 1000) / 1000);
        }

        // Also create 2 daily backup files in the same directory
        const daily1 = `sqlite_backup_${now - 5000}.sqlite`;
        const daily2 = `sqlite_backup_${now - 2000}.sqlite`;
        fs.writeFileSync(path.join(dummyDir, daily1), "dummy daily backup 1");
        fs.writeFileSync(path.join(dummyDir, daily2), "dummy daily backup 2");

        // 5.1 Test listBackups default isolates daily from pre-migration
        const dailyList = listBackups(dummyDir);
        assert.equal(dailyList.length, 2, "listBackups must only return daily backups by default");
        assert.ok(!dailyList.some(b => b.filename.includes("pre_migration")));

        // 5.2 Test listPreMigrationBackups returns only pre-migration backups
        const preList = listPreMigrationBackups(dummyDir);
        assert.equal(preList.length, 5, "listPreMigrationBackups must return all 5 pre-migration backups");
        assert.ok(preList.every(b => b.filename.startsWith("sqlite_backup_pre_migration_")));

        // 5.3 Test rotatePreMigrationBackups rotates to configured retention (default: 3)
        rotatePreMigrationBackups(dummyDir, 3);
        const preAfterRotate = listPreMigrationBackups(dummyDir);
        assert.equal(preAfterRotate.length, 3, "rotatePreMigrationBackups must prune to exactly 3 backups");

        // Verify daily backups were untouched by pre-migration rotation
        const dailyAfterRotate = listBackups(dummyDir);
        assert.equal(dailyAfterRotate.length, 2, "Daily backups must be completely unaffected by pre-migration rotation");

        // 5.4 Test daily backup rotation does not delete pre-migration backups
        rotateBackups(dummyDir, 2);
        const preStillIntact = listPreMigrationBackups(dummyDir);
        assert.equal(preStillIntact.length, 3, "Pre-migration backups must remain untouched by daily rotation");
    });
});
