"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const databaseService = require("../../database/services/databaseService");
const scheduler = require("../../database/sqlite/maintenance/scheduler");

test("Maintenance Scheduler and Console Commands Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-maint-test-"));
    const testDbPath = path.join(tempDir, "test.sqlite");

    process.env.SQLITE_DB_PATH = testDbPath;
    process.env.SQLITE_BACKUP_DIR = path.join(tempDir, "backups");

    t.after(() => {
        scheduler.stopScheduler();
        closeDatabase();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test("1. Initializes temporary database schema", () => {
        const db = openDatabase({ path: testDbPath });
        assert.ok(db.open);
        const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
        runMigrations(db, { migrationsDir: path.resolve(__dirname, "../../database/sqlite/migrations") });
    });

    await t.test("2. Scheduler start, diagnostics, and stop lifecycle", () => {
        scheduler.stopScheduler();
        let diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.active, false);

        scheduler.startScheduler();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.active, true);
        assert.equal(diag.timers.wal, true);
        assert.equal(diag.timers.cleanup, true);
        assert.equal(diag.timers.vacuum, true);

        scheduler.stopScheduler();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.active, false);
    });

    await t.test("3. Scheduler tasks execution (WAL, Cleanup, Vacuum, Backup)", async () => {
        await scheduler.runWalCheckpoint();
        let diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.wal.lastStatus, "success");
        assert.ok(diag.diagnostics.wal.runCount >= 1);

        await scheduler.runCleanup();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.cleanup.lastStatus, "success");
        assert.ok(diag.diagnostics.cleanup.runCount >= 1);

        await scheduler.runVacuum();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.vacuum.lastStatus, "success");
        assert.ok(diag.diagnostics.vacuum.runCount >= 1);

        await scheduler.runAutoBackup();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.backup.lastStatus, "success");
        assert.ok(diag.diagnostics.backup.runCount >= 1);
    });

    await t.test("4. Scheduler running task status and drain", async () => {
        assert.equal(scheduler.hasCriticalRunningTasks(), false);
        assert.equal(scheduler.hasRunningTasks(), false);

        const drained = await scheduler.drainSchedulerTasks(100);
        assert.equal(drained, true);
    });

    await t.test("5. Emergency evaluation trigger and execution", async () => {
        scheduler.triggerEmergencyEvaluation("test_trigger");
        await scheduler.runEmergencyEvaluation();
        const diag = scheduler.getSchedulerDiagnostics();
        assert.ok(diag.diagnostics.emergency);
    });

    await t.test("6. Database console commands coverage", async () => {
        const healthCmd = await databaseService.executeDatabaseConsole("health");
        assert.equal(healthCmd.ok, true);
        assert.match(healthCmd.output, /สถานะระบบฐานข้อมูล/);

        const cleanCmd = await databaseService.executeDatabaseConsole("cleanup");
        assert.equal(cleanCmd.ok, true);

        const cleanCacheCmd = await databaseService.executeDatabaseConsole("cleanup cache");
        assert.equal(cleanCacheCmd.ok, true);

        const cleanHistCmd = await databaseService.executeDatabaseConsole("cleanup history");
        assert.equal(cleanHistCmd.ok, true);

        const chkCmd = await databaseService.executeDatabaseConsole("checkpoint");
        assert.equal(chkCmd.ok, true);

        const vacCmd = await databaseService.executeDatabaseConsole("vacuum");
        assert.equal(vacCmd.ok, true);

        const bkpCmd = await databaseService.executeDatabaseConsole("backup");
        assert.equal(bkpCmd.ok, true);

        const trimCmd = await databaseService.executeDatabaseConsole("emergency-trim");
        assert.equal(trimCmd.ok, true);
    });

    await t.test("7. databaseService.executeSqliteAction additional actions", async () => {
        const checkAction = await databaseService.executeSqliteAction("check");
        assert.equal(checkAction.ok, true);

        const cleanAll = await databaseService.executeSqliteAction("cleanup_all");
        assert.equal(cleanAll.ok, true);

        const cleanExpired = await databaseService.executeSqliteAction("cleanup_expired");
        assert.equal(cleanExpired.ok, true);

        const cleanCache = await databaseService.executeSqliteAction("cleanup_cache");
        assert.equal(cleanCache.ok, true);

        const cleanHist = await databaseService.executeSqliteAction("cleanup_history");
        assert.equal(cleanHist.ok, true);

        const emergencyTrim = await databaseService.executeSqliteAction("emergency_trim");
        assert.equal(emergencyTrim.ok, true);

        const fullCheck = await databaseService.executeSqliteAction("full_check");
        assert.equal(fullCheck.ok, true);
    });

    await t.test("8. maskSensitiveValue boundary coverage", () => {
        const masked = databaseService.maskSensitiveValue("authorization", "Bearer 1234567890abcdef");
        assert.match(String(masked), /PROTECTED/);

        const maskedShort = databaseService.maskSensitiveValue("secret", "abc");
        assert.equal(maskedShort, "[PROTECTED_SECRET]");

        const maskedObj = databaseService.maskSensitiveValue("config", {
            token: "supersecrettoken123",
            user: "normalUser"
        });
        assert.match(maskedObj.token, /PROTECTED/);
        assert.equal(maskedObj.user, "normalUser");
    });

    await t.test("9. Scheduler error handling on action failure and exception", async () => {
        const originalAction = databaseService.executeSqliteAction;

        // 1. Action returns ok: false
        databaseService.executeSqliteAction = async () => ({ ok: false, error: "Simulated Action Failure" });

        await scheduler.runWalCheckpoint();
        let diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.wal.lastStatus, "error");
        assert.equal(diag.diagnostics.wal.lastError, "Simulated Action Failure");

        await scheduler.runCleanup();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.cleanup.lastStatus, "error");

        await scheduler.runVacuum();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.vacuum.lastStatus, "error");

        await scheduler.runAutoBackup();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.backup.lastStatus, "error");

        // 2. Action throws exception
        databaseService.executeSqliteAction = async () => { throw new Error("Simulated Action Crash"); };

        await scheduler.runWalCheckpoint();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.wal.lastStatus, "error");
        assert.equal(diag.diagnostics.wal.lastError, "Simulated Action Crash");

        await scheduler.runCleanup();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.cleanup.lastStatus, "error");

        await scheduler.runVacuum();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.vacuum.lastStatus, "error");

        await scheduler.runAutoBackup();
        diag = scheduler.getSchedulerDiagnostics();
        assert.equal(diag.diagnostics.backup.lastStatus, "error");

        databaseService.executeSqliteAction = originalAction;
    });

    await t.test("10. Scheduler concurrency guards skip overlapping executions", async () => {
        const originalAction = databaseService.executeSqliteAction;
        let resolveBlocker;
        const blockerPromise = new Promise((resolve) => { resolveBlocker = resolve; });

        databaseService.executeSqliteAction = async () => {
            await blockerPromise;
            return { ok: true };
        };

        // Start background run
        const pWal1 = scheduler.runWalCheckpoint();
        // Overlapping run should skip
        const pWal2 = scheduler.runWalCheckpoint();

        const pClean1 = scheduler.runCleanup();
        const pClean2 = scheduler.runCleanup();

        const pVac1 = scheduler.runVacuum();
        const pVac2 = scheduler.runVacuum();

        const pBkp1 = scheduler.runAutoBackup();
        const pBkp2 = scheduler.runAutoBackup();

        // Release blocker
        resolveBlocker();
        await Promise.all([pWal1, pWal2, pClean1, pClean2, pVac1, pVac2, pBkp1, pBkp2]);

        databaseService.executeSqliteAction = originalAction;
    });
});

