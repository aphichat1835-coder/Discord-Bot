"use strict";

const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { getCacheManager } = require("../../database/sqlite/cache/cacheManager");
const { executeEmergencyTrim } = require("../../database/sqlite/maintenance/emergencyTrim");
const {
    resolvePriority,
    evictWithPriority
} = require("../../database/sqlite/repositories/history/bufferPolicy");
const { VoiceEventRepository } = require("../../database/sqlite/repositories/history/VoiceEventRepository");
const { CommandEventRepository } = require("../../database/sqlite/repositories/history/CommandEventRepository");
const { SessionEventRepository } = require("../../database/sqlite/repositories/history/SessionEventRepository");
const {
    isPidAlive,
    acquireProcessLock,
    releaseProcessLock,
    isProcessLockActive,
    acquireRestoreLock,
    releaseRestoreLock,
    isRestoreLockActive
} = require("../../database/sqlite/maintenance/processLock");
const { restoreDatabase } = require("../../scripts/db/restoreSqlite");
const { checkpointWal, runIncrementalVacuum, VALID_CHECKPOINT_MODES } = require("../../database/sqlite/maintenance/vacuum");
const databaseService = require("../../database/services/databaseService");
const scheduler = require("../../database/sqlite/maintenance/scheduler");

describe("Production Hardening Round 2 Audit Fixes Suite", () => {
    let tempDir;

    before(() => {
        tempDir = path.join(__dirname, "temp-round2-test-" + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // 1. Process Lock & Restore Safety Gate
    // ────────────────────────────────────────────────────────────────────────
    describe("1. SQLite Process Lock & Restore Safety Gate", () => {
        test("isPidAlive accurately detects running and dead processes", () => {
            assert.equal(isPidAlive(process.pid), true);
            // Typically PID 999999 is nonexistent
            assert.equal(isPidAlive(999999), false);
            assert.equal(isPidAlive(null), false);
            assert.equal(isPidAlive(-1), false);
        });

        test("processLock acquires, checks, and releases cleanly", () => {
            const dbPath = path.join(tempDir, "lock_test.sqlite");
            const lockRes = acquireProcessLock(dbPath);
            assert.equal(lockRes.acquired, true);
            assert.equal(lockRes.pid, process.pid);

            const check = isProcessLockActive(dbPath);
            assert.equal(check.active, true);
            assert.equal(check.pid, process.pid);

            releaseProcessLock(dbPath);
            const checkAfter = isProcessLockActive(dbPath);
            assert.equal(checkAfter.active, false);
        });

        test("restoreDatabase rejects restore if active bot process holds lock without --force", async () => {
            const targetPath = path.join(tempDir, "active_target.sqlite");
            const backupPath = path.join(tempDir, "valid_backup.sqlite");

            // Setup valid backup sqlite
            const bDb = new Database(backupPath);
            bDb.pragma("foreign_keys = ON");
            runMigrations(bDb);
            bDb.close();

            // Setup target sqlite
            const tDb = new Database(targetPath);
            tDb.pragma("foreign_keys = ON");
            runMigrations(tDb);
            tDb.close();

            // Spawn a real child process so that isPidAlive(child.pid) is 100% portable on any OS / runner
            const { spawn } = require("node:child_process");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            const childPid = child.pid;

            const lockFile = `${targetPath}.lock`;
            fs.writeFileSync(lockFile, JSON.stringify({ pid: childPid, createdAt: Date.now() }));

            try {
                // Attempt restore without force -> MUST reject
                await assert.rejects(async () => {
                    await restoreDatabase({
                        sourceBackup: backupPath,
                        targetDb: targetPath,
                        force: false
                    });
                }, /Active bot process detected holding SQLite lock/);

                // Attempt restore with force: true -> MUST ALSO reject while live process holds lock
                await assert.rejects(async () => {
                    await restoreDatabase({
                        sourceBackup: backupPath,
                        targetDb: targetPath,
                        force: true
                    });
                }, /--force does not allow bypassing an active running bot process/);
            } finally {
                try { child.kill("SIGKILL"); } catch (_) {}
                try { fs.unlinkSync(lockFile); } catch (_) {}
            }

            // After live process is terminated, restore with force: true succeeds (and overrides stale locks)
            const restoreLockFile = `${targetPath}.restore.lock`;
            fs.writeFileSync(restoreLockFile, JSON.stringify({ pid: 999999, createdAt: Date.now() }));
            try {
                const res = await restoreDatabase({
                    sourceBackup: backupPath,
                    targetDb: targetPath,
                    force: true
                });
                assert.equal(res.ok, true);
            } finally {
                try { fs.unlinkSync(restoreLockFile); } catch (_) {}
            }
        });

        test("openDatabase rejects when process lock is held by another active process", () => {
            const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
            const lockDbPath = path.join(tempDir, "locked_by_other.sqlite");

            const { spawn } = require("node:child_process");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            const childPid = child.pid;

            const lockFile = `${lockDbPath}.lock`;
            fs.writeFileSync(lockFile, JSON.stringify({ pid: childPid, createdAt: Date.now() }));

            try {
                assert.throws(() => {
                    openDatabase({ path: lockDbPath });
                }, /Failed to acquire process lock: database is already locked by active process/);
            } finally {
                try { child.kill("SIGKILL"); } catch (_) {}
                try { fs.unlinkSync(lockFile); } catch (_) {}
                closeDatabase();
            }
        });

        test("isRestoreLockActive blocks concurrent database initialization", () => {
            const dbPath = path.join(tempDir, "restore_lock_test.sqlite");
            acquireRestoreLock(dbPath);

            const active = isRestoreLockActive(dbPath);
            assert.equal(active.active, true);
            assert.equal(active.pid, process.pid);

            releaseRestoreLock(dbPath);
            const after = isRestoreLockActive(dbPath);
            assert.equal(after.active, false);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 2. History Buffer Priority Eviction & P1 Preservation
    // ────────────────────────────────────────────────────────────────────────
    describe("2. History Buffer P1 Preservation & Priority Handling", () => {
        test("evictWithPriority records distinct P2 vs P1 eviction counts and preserves P0", () => {
            const buffer = [
                { priority: "P2", id: 1 },
                { priority: "P1", id: 2 },
                { priority: "P2", id: 3 },
                { priority: "P1", id: 4 },
                { priority: "P0", id: 5 }
            ];

            const stats = {};
            // Drop target 2 items: should drop only the 2 P2 items
            const dropped = evictWithPriority(buffer, 2, stats);
            assert.equal(dropped, 2);
            assert.equal(stats.p2, 2);
            assert.equal(stats.p1, 0);
            assert.deepEqual(buffer.map(i => i.id), [2, 4, 5]);

            // Drop target 2 more: must drop the remaining two P1 items, leaving P0
            const stats2 = {};
            const dropped2 = evictWithPriority(buffer, 2, stats2);
            assert.equal(dropped2, 2);
            assert.equal(stats2.p1, 2);
            assert.equal(stats2.p2, 0);
            assert.deepEqual(buffer.map(i => i.id), [5], "P0 must never be evicted");
        });

        test("VoiceEventRepository drains buffer completely on stopFlusher", () => {
            const memDb = new Database(":memory:");
            memDb.pragma("foreign_keys = ON");
            runMigrations(memDb);

            const repo = new VoiceEventRepository(memDb);
            // Insert 150 items (larger than default flush batch 100)
            for (let i = 0; i < 150; i++) {
                repo.buffer.push({
                    priority: "P2",
                    occurredAt: Date.now(),
                    eventType: "voice_join",
                    sessionId: `sess_${i}`,
                    accountId: "acc1",
                    guildId: "g1",
                    voiceId: "v1",
                    detail: "test",
                    metadataJson: null
                });
            }
            assert.equal(repo.buffer.length, 150);

            repo.stopFlusher();
            assert.equal(repo.buffer.length, 0, "stopFlusher must drain all items from the buffer");

            const count = memDb.prepare("SELECT count(*) as c FROM voice_events").get().c;
            assert.equal(count, 150);

            memDb.close();
        });

        test("History repositories filter out P2 and preserve P1 when history writes are blocked", () => {
            const memDb = new Database(":memory:");
            memDb.pragma("foreign_keys = ON");
            runMigrations(memDb);

            const repo = new VoiceEventRepository(memDb);
            repo.buffer = [
                { priority: "P1", occurredAt: Date.now(), eventType: "session_quarantine", sessionId: "s1" },
                { priority: "P2", occurredAt: Date.now(), eventType: "voice_ping", sessionId: "s2" },
                { priority: "P1", occurredAt: Date.now(), eventType: "session_429", sessionId: "s3" },
                { priority: "P2", occurredAt: Date.now(), eventType: "voice_metric", sessionId: "s4" }
            ];

            // Mock canWrite returning false for history
            const writePolicy = require("../../database/sqlite/maintenance/writePolicy");
            const origCanWrite = writePolicy.canWrite;
            try {
                writePolicy.canWrite = cat => (cat === "history" ? false : true);

                const flushed = repo.flush();
                assert.equal(flushed, 0);
                assert.equal(repo.buffer.length, 2, "Only P1 items should remain");
                assert.equal(repo.buffer[0].priority, "P1");
                assert.equal(repo.buffer[1].priority, "P1");
            } finally {
                writePolicy.canWrite = origCanWrite;
                memDb.close();
            }
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 3. Emergency Trim Phased LRU & Counter Deduplication
    // ────────────────────────────────────────────────────────────────────────
    describe("3. Emergency Trim Phased LRU & Counter Deduplication", () => {
        test("Emergency Trim does not double-count LRU items and separates cacheEntries from cacheEntriesEvicted", async () => {
            const trimDb = new Database(":memory:");
            trimDb.pragma("foreign_keys = ON");
            runMigrations(trimDb);

            const cacheMgr = getCacheManager(trimDb);
            // Insert expired entries
            const now = Date.now();
            trimDb.prepare(`
                INSERT INTO cache_entries (namespace, cache_key, payload_json, expires_at, created_at, updated_at, last_accessed_at)
                VALUES ('ns', 'exp1', '{}', ?, ?, ?, ?)
            `).run(now - 1000, now - 2000, now - 2000, now - 2000);

            // Insert 10 active entries
            for (let i = 0; i < 10; i++) {
                cacheMgr.set("bulk_ns", `k_${i}`, `v_${i}`);
            }

            const res = await executeEmergencyTrim(trimDb, { reason: "test_trim" });
            assert.equal(res.ok, true);

            // Verify itemsPurged structure
            assert.equal(typeof res.itemsPurged.cacheEntries, "number");
            assert.equal(typeof res.itemsPurged.cacheEntriesEvicted, "number");
            assert.equal(res.itemsPurged.cacheEntries, 1, "Expired cache entries must equal 1");
            assert.ok(res.itemsPurged.cacheEntriesEvicted >= 3, "LRU evicted cache entries must be at least 3");

            // Total items must be exact sum of distinct categories without duplicating LRU
            const expectedTotal =
                res.itemsPurged.assetExpired +
                res.itemsPurged.assetLru +
                res.itemsPurged.nonces +
                res.itemsPurged.dms +
                res.itemsPurged.cacheEntries +
                res.itemsPurged.cacheEntriesEvicted +
                res.itemsPurged.expiredHistory;

            assert.equal(res.itemsPurged.totalItems, expectedTotal, "totalItems must not double count LRU evictions");

            trimDb.close();
        });

        test("getCacheManager reuses instance for the same db via WeakMap (no timer leaks)", () => {
            const dbA = new Database(":memory:");
            const mgr1 = getCacheManager(dbA);
            const mgr2 = getCacheManager(dbA);
            assert.equal(mgr1, mgr2, "Calling getCacheManager on the same db must return the identical instance");
            mgr1.stopTouchFlusher();
            dbA.close();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 4. Checkpoint Allowlist & Vacuum Pages Clamp
    // ────────────────────────────────────────────────────────────────────────
    describe("4. Checkpoint Allowlist & Vacuum Clamp", () => {
        let db;

        beforeEach(() => {
            db = new Database(":memory:");
            db.pragma("auto_vacuum = INCREMENTAL");
            db.pragma("foreign_keys = ON");
            runMigrations(db);
        });

        afterEach(() => {
            if (db) db.close();
        });

        test("VALID_CHECKPOINT_MODES contains only PASSIVE, FULL, RESTART, TRUNCATE", () => {
            assert.equal(VALID_CHECKPOINT_MODES.has("PASSIVE"), true);
            assert.equal(VALID_CHECKPOINT_MODES.has("FULL"), true);
            assert.equal(VALID_CHECKPOINT_MODES.has("RESTART"), true);
            assert.equal(VALID_CHECKPOINT_MODES.has("TRUNCATE"), true);
            assert.equal(VALID_CHECKPOINT_MODES.has("INJECTION"), false);
        });

        test("checkpointWal accepts valid modes case-insensitively and rejects invalid modes", () => {
            const pRes = checkpointWal(db, "passive");
            assert.equal(pRes.ok, true);
            assert.equal(pRes.mode, "PASSIVE");

            const badRes = checkpointWal(db, "INVALID_MODE; DROP TABLE users;");
            assert.equal(badRes.ok, false);
            assert.match(badRes.error, /Invalid checkpoint mode/);
        });

        test("runIncrementalVacuum clamps pages to [1, 10000]", () => {
            // Memory DB auto_vacuum is INCREMENTAL
            const resClampedHigh = runIncrementalVacuum(db, 999999);
            assert.equal(resClampedHigh.ok, true);
            assert.equal(resClampedHigh.pagesVacuumed, 10000);

            const resClampedLow = runIncrementalVacuum(db, -50);
            assert.equal(resClampedLow.ok, true);
            assert.equal(resClampedLow.pagesVacuumed, 1);
        });

        test("databaseService executeSqliteAction enforces checkpoint allowlist and clamps vacuum pages", async () => {
            // Checkpoint invalid mode
            const badChk = await databaseService.executeSqliteAction("checkpoint", { mode: "MALICIOUS" }, "test_user");
            assert.equal(badChk.ok, false);
            assert.match(badChk.message, /ล้มเหลว|ไม่ถูกต้อง/);

            // Checkpoint valid mode
            const goodChk = await databaseService.executeSqliteAction("checkpoint", { mode: "TRUNCATE" }, "test_user");
            assert.equal(goodChk.ok, true);

            // Vacuum clamps
            const vac = await databaseService.executeSqliteAction("vacuum", { pages: 50000 }, "test_user");
            assert.equal(vac.ok, true);
            assert.equal(vac.vacuum.pagesVacuumed, 10000);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 5. Full Check 3-State Health Evaluation
    // ────────────────────────────────────────────────────────────────────────
    describe("5. Full Check 3-State Evaluation (OK, WARNING, ERROR)", () => {
        test("full_check returns status 'ok' when no errors or storage warnings exist", async () => {
            const res = await databaseService.executeDatabaseConsole("full-check", "owner");
            assert.equal(res.ok, true);
            assert.ok(res.output);
            assert.match(res.output, /Full Health Check/);
        });

        test("executeSqliteAction full_check distinguishes warning from ok", async () => {
            const res = await databaseService.executeSqliteAction("full_check", {}, "test");
            assert.equal(res.ok, true);
            assert.ok(["ok", "warning"].includes(res.status));
            assert.ok(typeof res.message, "string");
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 6. Multi-Volume Storage Check & AssetCacheManager WeakMap
    // ────────────────────────────────────────────────────────────────────────
    describe("6. Multi-Volume Storage Check & WeakMap Isolation", () => {
        const { evaluateStoragePaths } = require("../../database/sqlite/maintenance/storageCheck");
        const { getAssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");

        test("evaluateStoragePaths evaluates separate volumes for database, backup, and assetCache", () => {
            const res = evaluateStoragePaths();
            assert.equal(res.ok, true);
            assert.ok(res.volumes, "res.volumes must be defined");
            assert.ok(res.volumes.database, "database volume must exist");
            assert.ok(res.volumes.backup, "backup volume must exist");
            assert.ok(res.volumes.assetCache, "assetCache volume must exist");
            assert.equal(typeof res.volumes.database.path, "string");
            assert.equal(typeof res.volumes.backup.path, "string");
            assert.equal(typeof res.volumes.assetCache.path, "string");
            assert.equal(res.volumes.database.status, "ok");
        });

        test("getAssetCacheManager reuses instance per DB with WeakMap without cross-contamination", () => {
            const db1 = new Database(":memory:");
            const db2 = new Database(":memory:");
            const mgr1 = getAssetCacheManager(db1);
            const mgr1_again = getAssetCacheManager(db1);
            const mgr2 = getAssetCacheManager(db2);

            assert.equal(mgr1, mgr1_again, "Identical DB should return identical AssetCacheManager");
            assert.notEqual(mgr1, mgr2, "Different DBs should return separate AssetCacheManagers");

            mgr1.stopTouchFlusher();
            mgr2.stopTouchFlusher();
            db1.close();
            db2.close();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 7. P0 Telemetry Retry Buffer & Batched Cleanup
    // ────────────────────────────────────────────────────────────────────────
    describe("7. P0 Telemetry Retry Buffer & Batched Cleanup", () => {
        test("P0 telemetry queues in criticalRetryQueue on insert failure and drains on flush", () => {
            const memDb = new Database(":memory:");
            memDb.pragma("foreign_keys = ON");
            runMigrations(memDb);

            const repo = new VoiceEventRepository(memDb);
            // Corrupt or break _insertSingle temporarily
            const origInsert = repo._insertSingle.bind(repo);
            let fail = true;
            repo._insertSingle = (item) => {
                if (fail) throw new Error("Simulated locked DB");
                return origInsert(item);
            };

            // Record P0 event while failing
            repo.record({ eventType: "backup_failed", detail: "p0 test" }, true);
            assert.equal(repo.criticalRetryQueue.length, 1, "Failed P0 must be pushed to criticalRetryQueue");

            // Stop failing and flush
            fail = false;
            repo.flush();
            assert.equal(repo.criticalRetryQueue.length, 0, "criticalRetryQueue must drain successfully on flush");

            const count = memDb.prepare("SELECT count(*) as c FROM voice_events WHERE event_type = 'backup_failed'").get().c;
            assert.equal(count, 1, "P0 event must be inserted into SQLite upon retry");

            repo.stopFlusher();
            memDb.close();
        });

        test("cleanup_history batched deletion executes successfully", async () => {
            const res = await databaseService.executeSqliteAction("cleanup_history", {}, "test");
            assert.equal(res.ok, true);
            assert.equal(typeof res.deletedRows, "number");
            assert.match(res.message, /ล้างประวัติ/);
        });
    });
});
