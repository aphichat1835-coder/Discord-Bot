"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { getCacheManager } = require("../../database/sqlite/cache/cacheManager");
const { runEmergencyTrim } = require("../../database/sqlite/maintenance/emergencyTrim");
const { sanitizeDetails } = require("../../database/sqlite/repositories/history/bufferPolicy");
const { VoiceEventRepository } = require("../../database/sqlite/repositories/history/VoiceEventRepository");
const { createBackup, listBackups } = require("../../database/sqlite/maintenance/backup");
const { prunePreRestoreBackups, restoreDatabase } = require("../../scripts/db/restoreSqlite");
const databaseService = require("../../database/services/databaseService");
const dmService = require("../../discord/dm/service");
const scheduler = require("../../database/sqlite/maintenance/scheduler");

describe("Audit Follow-up Architecture & Invariants Suite", () => {
    let testDb;
    let tempDir;

    before(() => {
        tempDir = path.join(__dirname, "temp-audit-test-" + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        testDb = new Database(":memory:");
        testDb.pragma("foreign_keys = ON");
        runMigrations(testDb);
    });

    after(() => {
        if (testDb) {
            try { testDb.close(); } catch (_) {}
        }
        if (fs.existsSync(tempDir)) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    describe("1. DM Service Readiness & Retention (Decoupled from Mongo)", () => {
        test("DM Service databaseReady inspects SQLite state, not MongoDB", () => {
            const isReadyFn = dmService._test?.databaseReady;
            assert.equal(typeof isReadyFn, "function", "dmService must export databaseReady in _test");

            // Scenario A: When override is provided, honors override
            dmService._test.setDatabaseReadyOverride(true);
            assert.equal(isReadyFn(), true);

            dmService._test.setDatabaseReadyOverride(false);
            assert.equal(isReadyFn(), false);

            dmService._test.setDatabaseReadyOverride(null);
        });

        test("DM Service retention respects SQLITE_DM_RETENTION_DAYS (default 7 days)", () => {
            const resolveRetention = dmService._test?.resolveDmRetentionMs;
            assert.equal(typeof resolveRetention, "function", "dmService must export resolveDmRetentionMs in _test");

            const originalEnv = process.env.SQLITE_DM_RETENTION_DAYS;
            try {
                delete process.env.SQLITE_DM_RETENTION_DAYS;
                // Default: 7 days
                assert.equal(resolveRetention(), 7 * 24 * 60 * 60 * 1000);

                process.env.SQLITE_DM_RETENTION_DAYS = "14";
                assert.equal(resolveRetention(), 14 * 24 * 60 * 60 * 1000);

                process.env.SQLITE_DM_RETENTION_DAYS = "invalid";
                assert.equal(resolveRetention(), 7 * 24 * 60 * 60 * 1000);
            } finally {
                if (originalEnv !== undefined) process.env.SQLITE_DM_RETENTION_DAYS = originalEnv;
                else delete process.env.SQLITE_DM_RETENTION_DAYS;
            }
        });
    });

    describe("2. Database Center Audit Attribution & Failure Handling", () => {
        test("recordAudit preserves specific actor, action, target, duration, and error", () => {
            const auditDb = new Database(":memory:");
            auditDb.pragma("foreign_keys = ON");
            runMigrations(auditDb);

            const result = databaseService.recordAudit(auditDb, {
                actor: "owner-user-9999",
                action: "emergency_trim",
                target: "sqlite:cache_entries",
                status: "success",
                durationMs: 42,
                metadata: { freedMb: 12.5 }
            });

            assert.equal(result.ok, true);
            const row = auditDb.prepare("SELECT * FROM maintenance_runs ORDER BY id DESC LIMIT 1").get();
            assert.ok(row);
            assert.equal(row.run_type, "emergency_trim");
            assert.equal(row.status, "success");

            const meta = JSON.parse(row.details_json);
            assert.equal(meta.actor, "owner-user-9999");
            assert.equal(meta.action, "emergency_trim");
            assert.equal(meta.target, "sqlite:cache_entries");
            assert.equal(meta.durationMs, 42);
            assert.equal(meta.metadata.freedMb, 12.5);

            auditDb.close();
        });

        test("recordAudit handles database failure gracefully without silent swallowing", () => {
            const brokenDb = {
                prepare() {
                    throw new Error("Disk full or lock timeout");
                }
            };

            const result = databaseService.recordAudit(brokenDb, {
                actor: "owner-123",
                action: "test_failure"
            });

            assert.equal(result.ok, false);
            assert.ok(result.error);
            assert.match(result.error, /Disk full/);
        });
    });

    describe("3. Generic Cache maxRows Enforcement & LRU Eviction", () => {
        test("CacheManager enforces maxRows policy by evicting oldest accessed items", () => {
            const cacheMgr = getCacheManager(testDb);
            const ns = "test_lru_ns";

            // Set maxRows policy for test namespace
            cacheMgr.setPolicy(ns, { maxRows: 3, ttlMs: 60000 });

            cacheMgr.set(ns, "key1", "val1");
            cacheMgr.set(ns, "key2", "val2");
            cacheMgr.set(ns, "key3", "val3");

            // All 3 exist
            assert.equal(cacheMgr.get(ns, "key1"), "val1");
            assert.equal(cacheMgr.get(ns, "key2"), "val2");
            assert.equal(cacheMgr.get(ns, "key3"), "val3");

            // Access key1 so key2 becomes the least recently used
            cacheMgr.get(ns, "key1", Date.now() + 5000);

            // Insert 4th item; must evict key2 (oldest last_accessed)
            cacheMgr.set(ns, "key4", "val4");

            const count = cacheMgr.count(ns);
            assert.equal(count, 3, "Count must remain bounded to maxRows");
            assert.equal(cacheMgr.get(ns, "key2"), null, "key2 must be evicted by LRU");
            assert.equal(cacheMgr.get(ns, "key1"), "val1", "key1 must be preserved");
            assert.equal(cacheMgr.get(ns, "key4"), "val4", "key4 must be present");
        });

        test("Emergency Trim Phase 2 evicts generic cache via evictAllLru", async () => {
            const trimDb = new Database(":memory:");
            trimDb.pragma("foreign_keys = ON");
            runMigrations(trimDb);

            const cacheMgr = getCacheManager(trimDb);
            for (let i = 0; i < 10; i++) {
                cacheMgr.set("bulk_ns", `k_${i}`, `v_${i}`);
            }
            assert.equal(cacheMgr.count("bulk_ns"), 10);

            // Run emergency trim
            const res = await runEmergencyTrim(trimDb, { reason: "test_trim" });
            assert.equal(res.ok, true);
            assert.ok(res.itemsPurged.cacheEntriesEvicted >= 3, "At least 30% of cache entries must be evicted");

            trimDb.close();
        });
    });

    describe("4. Storage Health in Database Overview", () => {
        test("getDatabaseOverview includes filesystem storage under sqlite.storage", async () => {
            const overviewDb = new Database(":memory:");
            overviewDb.pragma("foreign_keys = ON");
            runMigrations(overviewDb);

            const overview = await databaseService.getDatabaseOverview(overviewDb);
            assert.ok(overview);
            assert.ok(overview.databases);
            assert.ok(overview.databases.sqlite);
            assert.ok(overview.databases.sqlite.storage);
            assert.ok(["ok", "check", "warning", "error"].includes(overview.databases.sqlite.status));

            overviewDb.close();
        });
    });

    describe("5. Backup Post-Creation Verification", () => {
        test("createBackup performs readonly quick_check and returns verified: true", async () => {
            const backupDb = new Database(":memory:");
            backupDb.pragma("foreign_keys = ON");
            runMigrations(backupDb);

            const bDir = path.join(tempDir, "backups");
            const res = await createBackup(backupDb, { backupDir: bDir });

            assert.equal(res.ok, true);
            assert.equal(res.verified, true);
            assert.ok(fs.existsSync(res.path));
            assert.ok(res.sizeBytes > 0);

            backupDb.close();
        });
    });

    describe("6. Restore Auto-Rollback & Safety Backup Pruning", () => {
        test("prunePreRestoreBackups retains max 2 safety backups", () => {
            const dummyTarget = path.join(tempDir, "testdb.sqlite");
            fs.writeFileSync(dummyTarget, "main_data");

            const bak1 = `${dummyTarget}.pre-restore-1000.bak`;
            const bak2 = `${dummyTarget}.pre-restore-2000.bak`;
            const bak3 = `${dummyTarget}.pre-restore-3000.bak`;

            fs.writeFileSync(bak1, "data1");
            fs.writeFileSync(bak2, "data2");
            fs.writeFileSync(bak3, "data3");

            prunePreRestoreBackups(dummyTarget, 2);

            const files = fs.readdirSync(tempDir).filter(f => f.includes(".pre-restore-"));
            assert.equal(files.length, 2);
        });

        test("restoreDatabase auto-rollbacks to safety backup if restored target is corrupt", async () => {
            // Setup target with original good data
            const targetPath = path.join(tempDir, "corrupt_test_target.sqlite");
            const originalDb = new Database(targetPath);
            originalDb.pragma("foreign_keys = ON");
            runMigrations(originalDb);
            originalDb.prepare("CREATE TABLE orig_tbl (val TEXT)").run();
            originalDb.prepare("INSERT INTO orig_tbl VALUES ('original_data')").run();
            originalDb.close();

            // Create fake "backup" that is a valid sqlite file initially for step 1
            const sourceBackupPath = path.join(tempDir, "fake_source.sqlite");
            const sourceDb = new Database(sourceBackupPath);
            sourceDb.pragma("foreign_keys = ON");
            runMigrations(sourceDb);
            sourceDb.close();

            // Intercept step 4 failure by corrupting the target after copy
            const badSourceBackupPath = path.join(tempDir, "bad_source.sqlite");
            fs.writeFileSync(badSourceBackupPath, "NOT_A_VALID_SQLITE_HEADER");

            await assert.rejects(async () => {
                await restoreDatabase({
                    sourceBackup: badSourceBackupPath,
                    targetDb: targetPath
                });
            }, /Integrity check failed|file is not a database/);

            // Verify original database file is still accessible and has original data
            const verifyDb = new Database(targetPath);
            const row = verifyDb.prepare("SELECT val FROM orig_tbl").get();
            assert.equal(row.val, "original_data", "Original database content must remain preserved");
            verifyDb.close();
        });
    });

    describe("7. Voice Event Metadata Sanitization", () => {
        test("sanitizeDetails redacts sensitive tokens, passwords, and secrets", () => {
            const input = {
                username: "alice",
                token: "mfa.abc123secret",
                nested: {
                    user_password: "mypassword",
                    authBearer: "bearer 123",
                    safeField: "safe value"
                }
            };

            const sanitized = sanitizeDetails(input);
            assert.equal(sanitized.username, "alice");
            assert.equal(sanitized.token, "[REDACTED]");
            assert.equal(sanitized.nested.user_password, "[REDACTED]");
            assert.equal(sanitized.nested.authBearer, "[REDACTED]");
            assert.equal(sanitized.nested.safeField, "safe value");
        });

        test("VoiceEventRepository redacts sensitive tokens in recorded metadata", () => {
            const vRepo = new VoiceEventRepository(testDb);
            vRepo.record({
                guildId: "guild1",
                userId: "user1",
                eventType: "VOICE_JOIN",
                detail: "Connected to voice",
                metadata: {
                    userToken: "super_secret_token",
                    channelId: "12345"
                }
            });
            vRepo.flush();

            const rows = vRepo.findRecent(10);
            assert.ok(rows.length > 0);
            const latest = rows[0];
            assert.ok(latest.metadata);
            assert.equal(latest.metadata.userToken, "[REDACTED]");
            assert.equal(latest.metadata.channelId, "12345");
        });
    });

    describe("8. Schema Migration user_version Lineage", () => {
        test("SQLite schema migration applies 001-009 and sets PRAGMA user_version = 9", () => {
            const versionDb = new Database(":memory:");
            const results = runMigrations(versionDb);

            assert.equal(results.currentVersion, 9);
            const userVersion = versionDb.pragma("user_version", { simple: true });
            assert.equal(userVersion, 9, "PRAGMA user_version must be exactly 9");

            // Verify all 9 migrations recorded in schema_migrations
            const rows = versionDb.prepare("SELECT migration_id, version FROM schema_migrations ORDER BY version ASC").all();
            assert.equal(rows.length, 9);
            assert.equal(rows[0].migration_id, "001_initial_core.sql");
            assert.equal(rows[1].migration_id, "002_history_events.sql");
            assert.equal(rows[2].migration_id, "003_cache_subsystem.sql");
            assert.equal(rows[3].migration_id, "004_session_runtime_and_assets.sql");
            assert.equal(rows[4].migration_id, "005_join_campaign.sql");
            assert.equal(rows[5].migration_id, "006_join_campaign_hardening.sql");
            assert.equal(rows[6].migration_id, "007_join_campaign_clean_schema.sql");
            assert.equal(rows[7].migration_id, "008_join_campaign_channel_persistence.sql");
            assert.equal(rows[8].migration_id, "009_join_campaign_crash_consistency.sql");

            versionDb.close();
        });
    });

    describe("9. Scheduler Diagnostics & Emergency Trigger", () => {
        test("scheduler exports triggerEmergencyEvaluation and provides initialBackupScheduled in diagnostics", () => {
            assert.equal(typeof scheduler.triggerEmergencyEvaluation, "function");

            const diag = scheduler.getSchedulerDiagnostics();
            assert.ok("initialBackupScheduled" in diag.timers);
        });
    });
});
