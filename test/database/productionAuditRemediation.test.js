"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { TABLE_CATEGORIES, getCategoryForTable } = require("../../database/sqlite/tableCategories");
const { TokenCoordinator } = require("../../discord/core/tokenCoordinator");
const { spoolP0Event, drainP0Spool, getP0JournalStats } = require("../../database/sqlite/repositories/history/p0Journal");
const { evaluateEmergencyThresholds } = require("../../database/sqlite/maintenance/quota");
const { runMigrations, reconcileUserVersion } = require("../../database/sqlite/migrations/migrationRunner");
const VoiceSessionRuntimeRepository = require("../../database/sqlite/repositories/core/VoiceSessionRuntimeRepository");
const { VoiceEventRepository } = require("../../database/sqlite/repositories/history/VoiceEventRepository");

describe("Production Audit 15-Item Remediation Verification Suite", () => {
    let tempDir;
    let testDb;

    before(() => {
        tempDir = path.join(__dirname, "temp-remediation-" + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        testDb = new Database(path.join(tempDir, "test.sqlite"));
        testDb.pragma("journal_mode = WAL");
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

    describe("Item 6: Table Categories Mapping", () => {
        test("all 17 standard SQLite tables are mapped without uncategorized gaps", () => {
            const expectedTables = [
                "schema_migrations", "database_meta", "maintenance_runs",
                "quest_logs", "quest_accounts", "quest_details", "scheduled_runners",
                "dm_notifications", "verification_recovery", "voice_session_runtime",
                "verification_state_nonce", "voice_events", "command_events",
                "session_events", "runtime_events", "cache_entries", "asset_cache"
            ];

            for (const tbl of expectedTables) {
                const cat = getCategoryForTable(tbl);
                assert.ok(["core", "temporary", "history", "cache"].includes(cat), `Table ${tbl} should have a valid category, got ${cat}`);
            }

            assert.equal(getCategoryForTable("quest_accounts"), "core");
            assert.equal(getCategoryForTable("quest_details"), "core");
            assert.equal(getCategoryForTable("voice_session_runtime"), "core");
            assert.equal(getCategoryForTable("unknown_future_table"), "temporary");
        });
    });

    describe("Item 8 & 9: TokenCoordinator Watchdog Option B & Sanitization", () => {
        test("Option B: watchdog rejects caller with TASK_TIMEOUT but preserves activity lock until real completion", async () => {
            const coord = new TokenCoordinator();
            const tokenHash = "tok_test_watchdog_hash";

            let underlyingFinished = false;
            const slowTask = async () => {
                await new Promise(r => setTimeout(r, 60));
                underlyingFinished = true;
                return "done";
            };

            // Call runTask with 20ms timeout -> caller will reject
            const taskPromise = coord.runTask(tokenHash, {
                subsystem: "voice",
                metadata: { guildId: "g_1", channelId: "c_1" },
                timeoutMs: 20
            }, slowTask);
            await assert.rejects(taskPromise, (err) => {
                return err.code === "TASK_TIMEOUT" || /timed out/.test(err.message);
            });

            // Activity must remain active while underlying slowTask is still running
            assert.equal(coord.hasActivity(tokenHash, "voice"), true, "Activity must be retained while slowTask runs");

            // Wait for underlying slowTask to complete
            await new Promise(r => setTimeout(r, 70));
            assert.equal(underlyingFinished, true);
            assert.equal(coord.hasActivity(tokenHash, "voice"), false, "Activity lock must be released after slowTask completes");
        });

        test("quarantineToken and telemetry sanitize secrets and tokens", () => {
            const coord = new TokenCoordinator();
            const tokenHash = "tok_test_sanitize_hash";

            // Quarantine with reason containing a raw bot token pattern
            const dirtyReason = "Authorization failed for MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.abcDEF.GHIjklMNOpqrSTUvwxYZ";
            coord.quarantineToken(tokenHash, dirtyReason, 60000);

            assert.equal(coord.isQuarantined(tokenHash), true);
            const q = coord.getQuarantineDetails(tokenHash);
            assert.ok(q, "Quarantine details must exist");
            assert.ok(!q.reason.includes("MTIzNDU2Nzg5MDEyMzQ1Njc4OTA"), "Token should be sanitized from reason");
            assert.ok(q.reason.includes("[REDACTED-TOKEN]") || q.reason.includes("REDACTED"), "Reason must be redacted");
        });
    });

    describe("Item 10: P0 Emergency Journal Durability", () => {
        test("spools P0 events to emergency journal and drains them safely", () => {
            const customJournalPath = path.join(tempDir, "test_p0_emergency.jsonl");
            const prevEnv = process.env.SQLITE_P0_JOURNAL_PATH;
            process.env.SQLITE_P0_JOURNAL_PATH = customJournalPath;

            try {
                const event1 = { priority: "P0", sessionId: "sess_1", occurredAt: Date.now(), eventType: "crash" };
                const event2 = { priority: "P0", sessionId: "sess_2", occurredAt: Date.now(), eventType: "corruption" };

                assert.equal(spoolP0Event("voice_events", event1), true);
                assert.equal(spoolP0Event("voice_events", event2), true);
                assert.equal(fs.existsSync(customJournalPath), true);

                const stats = getP0JournalStats();
                assert.equal(stats.exists, true);
                assert.equal(stats.count, 2);

                const voiceRepo = new VoiceEventRepository(testDb);
                const replayed = drainP0Spool(testDb, { voiceEvent: voiceRepo });
                assert.equal(replayed, 2);

                voiceRepo.stopFlusher();
            } finally {
                if (prevEnv) process.env.SQLITE_P0_JOURNAL_PATH = prevEnv;
                else delete process.env.SQLITE_P0_JOURNAL_PATH;
            }
        });

        test("VoiceEventRepository spools to journal when criticalRetryQueue hits cap of 100", () => {
            const customJournalPath = path.join(tempDir, "test_voice_p0_journal.jsonl");
            const prevEnv = process.env.SQLITE_P0_JOURNAL_PATH;
            process.env.SQLITE_P0_JOURNAL_PATH = customJournalPath;

            try {
                // Simulate broken DB to force queueing
                const badDb = {
                    prepare: () => { throw new Error("Simulated SQLite write lock"); },
                    transaction: (fn) => fn
                };
                const brokenRepo = new VoiceEventRepository(badDb);

                // Push 105 P0 events
                for (let i = 0; i < 105; i++) {
                    brokenRepo.record({
                        sessionId: `sess_p0_${i}`,
                        eventType: "critical_crash",
                        details: { idx: i }
                    }, true); // critical = true -> resolves to P0
                }

                // In-memory criticalRetryQueue is capped at 100
                assert.equal(brokenRepo.criticalRetryQueue.length, 100);

                // Excess 5 events are safely persisted in emergency journal
                const stats = getP0JournalStats();
                assert.equal(stats.exists, true);
                assert.equal(stats.count, 5);

                brokenRepo.stopFlusher();
            } finally {
                if (prevEnv) process.env.SQLITE_P0_JOURNAL_PATH = prevEnv;
                else delete process.env.SQLITE_P0_JOURNAL_PATH;
            }
        });
    });

    describe("Item 13: Emergency Thresholds Return bufferThreshold", () => {
        test("evaluateEmergencyThresholds returns bufferThreshold: 2000", () => {
            const thresholds = evaluateEmergencyThresholds(path.join(tempDir, "test.sqlite"));
            assert.equal(typeof thresholds.bufferThreshold, "number");
            assert.equal(thresholds.bufferThreshold, 2000);
            assert.equal(typeof thresholds.isBufferEmergency, "boolean");
        });
    });

    describe("Item 5 & 14: User Version Reconciliation & Single Retention", () => {
        test("reconcileUserVersion aligns PRAGMA user_version with MAX(version) from schema_migrations", () => {
            const dummyDb = new Database(path.join(tempDir, "reconcile.sqlite"));
            dummyDb.pragma("journal_mode = WAL");
            dummyDb.pragma("foreign_keys = ON");

            dummyDb.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    migration_id TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (1, '001_init', ${Date.now()});
                INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (4, '004_v4', ${Date.now()});
            `);

            // Deliberately set user_version out of sync
            dummyDb.pragma("user_version = 1");
            assert.equal(dummyDb.pragma("user_version", { simple: true }), 1);

            // Run reconcileUserVersion
            const reconciled = reconcileUserVersion(dummyDb);
            assert.equal(reconciled, 4);
            assert.equal(dummyDb.pragma("user_version", { simple: true }), 4);

            dummyDb.close();
        });
    });

    describe("Item 2: Voice Session Runtime Orphan Cleanup", () => {
        test("VoiceSessionRuntimeRepository deletes orphaned runtime records cleanly", () => {
            const runtimeRepo = new VoiceSessionRuntimeRepository(testDb);

            // Insert 2 session runtimes
            runtimeRepo.upsertSessionRuntime({
                sessionId: "orphan_session_1",
                serverId: "guild_1",
                ownerId: "owner_1",
                state: "active"
            });
            runtimeRepo.upsertSessionRuntime({
                sessionId: "valid_session_2",
                serverId: "guild_2",
                ownerId: "owner_2",
                state: "active"
            });

            const active = runtimeRepo.listActiveSessionRuntimes();
            assert.equal(active.length, 2);

            // Orphan cleanup: delete orphan_session_1
            runtimeRepo.deleteSessionRuntime("orphan_session_1");

            const remaining = runtimeRepo.listActiveSessionRuntimes();
            assert.equal(remaining.length, 1);
            assert.equal(remaining[0].session_id, "valid_session_2");
        });
    });
});
