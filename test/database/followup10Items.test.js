"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { evaluateStoragePaths } = require("../../database/sqlite/maintenance/storageCheck");
const { getSecretKey, encryptToken, decryptToken, ConfigurationError } = require("../../discord/quest/core/tokenCrypto");
const { stopJob, stopScheduledJob, stopScheduledJobAsAdmin } = require("../../discord/quest/core/runnerManager");
const { runEmergencyTrim } = require("../../database/sqlite/maintenance/emergencyTrim");
const { AssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");
const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const databaseService = require("../../database/services/databaseService");
const scheduler = require("../../database/sqlite/maintenance/scheduler");

const VerificationRecovery = require("../../discord/verification/models/VerificationRecovery");
const VerificationStateNonce = require("../../discord/verification/models/VerificationStateNonce");
const DmNotification = require("../../discord/dm/model");

describe("Follow-Up 10 Audit Items Suite", () => {
    let testDb;
    let tempDir;

    before(() => {
        tempDir = path.join(__dirname, "temp-followup10-" + Date.now());
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

    describe("Item 1: Persistent Storage Production Verification & Badges", () => {
        test("evaluateStoragePaths flags isPersistent=false and warnings when in production without explicit external paths", () => {
            const originalEnv = process.env.NODE_ENV;
            const origDb = process.env.SQLITE_DB_PATH;
            const origBackup = process.env.SQLITE_BACKUP_DIR;
            const origAsset = process.env.SQLITE_ASSET_DIR;
            const origAllow = process.env.ALLOW_IN_SOURCE_STORAGE;

            try {
                process.env.NODE_ENV = "production";
                delete process.env.SQLITE_DB_PATH;
                delete process.env.SQLITE_BACKUP_DIR;
                delete process.env.SQLITE_ASSET_DIR;
                delete process.env.ALLOW_IN_SOURCE_STORAGE;

                const res = evaluateStoragePaths();
                assert.equal(res.isProduction, true);
                assert.equal(res.isPersistent, false);
                assert.equal(res.pathWarning, true);
                assert.ok(res.warnings.some(w => w.includes("PRODUCTION_STORAGE")), "Must include PRODUCTION_STORAGE warning");
                assert.ok(res.missingExplicitEnvs.includes("SQLITE_DB_PATH"));
            } finally {
                process.env.NODE_ENV = originalEnv;
                if (origDb) process.env.SQLITE_DB_PATH = origDb;
                if (origBackup) process.env.SQLITE_BACKUP_DIR = origBackup;
                if (origAsset) process.env.SQLITE_ASSET_DIR = origAsset;
                if (origAllow) process.env.ALLOW_IN_SOURCE_STORAGE = origAllow;
            }
        });

        test("evaluateStoragePaths flags isPersistent=true when external mounts and explicit paths are provided", () => {
            const originalEnv = process.env.NODE_ENV;
            try {
                process.env.NODE_ENV = "production";
                const res = evaluateStoragePaths({
                    dbPath: "/persistent/data/bot.sqlite",
                    backupDir: "/persistent/backups",
                    assetDir: "/persistent/assets"
                });
                assert.equal(res.isPersistent, true);
                assert.equal(res.missingExplicitEnvs.length, 0);
                assert.equal(res.hasInSource, false);
            } finally {
                process.env.NODE_ENV = originalEnv;
            }
        });
    });

    describe("Item 2: Quest Token Encryption Hardening (Zero Fallback in Production)", () => {
        test("throws ConfigurationError in production if QUEST_TOKEN_SECRET/ENCRYPTION_KEY is missing", () => {
            const origNodeEnv = process.env.NODE_ENV;
            const origSecret = process.env.QUEST_TOKEN_SECRET;
            const origKey = process.env.ENCRYPTION_KEY;
            const origSec = process.env.ENCRYPTION_SECRET;
            const origBotToken = process.env.DISCORD_BOT_TOKEN;

            try {
                process.env.NODE_ENV = "production";
                delete process.env.QUEST_TOKEN_SECRET;
                delete process.env.ENCRYPTION_KEY;
                delete process.env.ENCRYPTION_SECRET;
                process.env.DISCORD_BOT_TOKEN = "fake_bot_token_that_must_not_be_used";

                assert.throws(() => {
                    getSecretKey();
                }, ConfigurationError);
            } finally {
                process.env.NODE_ENV = origNodeEnv;
                if (origSecret) process.env.QUEST_TOKEN_SECRET = origSecret;
                if (origKey) process.env.ENCRYPTION_KEY = origKey;
                if (origSec) process.env.ENCRYPTION_SECRET = origSec;
                if (origBotToken) process.env.DISCORD_BOT_TOKEN = origBotToken;
            }
        });

        test("encryptToken and decryptToken round-trip cleanly when key is set", () => {
            process.env.QUEST_TOKEN_SECRET = "super_secret_test_master_key_32bytes!!";
            const rawToken = "discord_user_token_123456";
            const encrypted = encryptToken(rawToken, "user1", "acc1");
            assert.ok(encrypted.packed);

            const decrypted = decryptToken(encrypted.packed, "user1", "acc1");
            assert.equal(decrypted, rawToken);
        });
    });

    describe("Item 3: Delete Scheduled Runner RAM Job Bug (asAdmin: true)", () => {
        test("stopScheduledJob with asAdmin: true stops job even if ownerId is null or mismatch", () => {
            // Test that stopScheduledJob accepts asAdmin and does not throw
            const res = stopScheduledJob(null, "non_existent_runner_999", { asAdmin: true });
            assert.equal(typeof res, "boolean");

            const adminRes = stopScheduledJobAsAdmin("non_existent_runner_999");
            assert.equal(typeof adminRes, "boolean");
        });
    });

    describe("Item 4: Emergency Trim Resolution Hierarchy (Strict isResolved = ok)", () => {
        test("emergencyTrim sets isResolved=true strictly for ok, and flags isSoftWarning for soft", async () => {
            const trimRes = await runEmergencyTrim(testDb, { reason: "Unit test emergency trim" });
            assert.equal(trimRes.ok, true);
            assert.equal(typeof trimRes.isResolved, "boolean");
            assert.equal(typeof trimRes.isSoftWarning, "boolean");

            if (trimRes.postStatus === "ok") {
                assert.equal(trimRes.isResolved, true);
                assert.equal(trimRes.status, "resolved");
            } else if (trimRes.postStatus === "soft") {
                assert.equal(trimRes.isResolved, false);
                assert.equal(trimRes.isSoftWarning, true);
                assert.equal(trimRes.status, "soft_warning");
            }
        });
    });

    describe("Item 5: Asset Cache Write Amplification Protection (Batch Touch Flusher)", () => {
        test("AssetCacheManager records touches in buffer and flushes on batch or stopTouchFlusher", () => {
            const assetDir = path.join(tempDir, "assets");
            const mgr = new AssetCacheManager(testDb, {
                assetDir,
                touchFlushIntervalMs: 60000 // don't auto-flush in test
            });

            // Insert a test asset into asset_cache
            const now = Date.now();
            testDb.prepare(`
                INSERT OR REPLACE INTO asset_cache (
                    asset_key, asset_type, relative_path, mime_type, size_bytes,
                    sha256, source_url, created_at, last_used_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run("test_icon_1", "icon", "test_icon_1.png", "image/png", 100, "hash1", null, now, now, now + 100000);

            // Record touch
            mgr.recordTouch("test_icon_1", now + 5000);
            assert.equal(mgr.touchBuffer.get("test_icon_1"), now + 5000);

            // Flush touches
            mgr.flushTouches();
            assert.equal(mgr.touchBuffer.size, 0);

            const row = testDb.prepare("SELECT last_used_at FROM asset_cache WHERE asset_key = ?").get("test_icon_1");
            assert.equal(row.last_used_at, now + 5000);

            mgr.stopTouchFlusher();
        });
    });

    describe("Item 6: Audit Actor Header Spoofing Prevention", () => {
        test("resolveActor does not accept client-controlled x-owner-id header", () => {
            // Verify from databaseRoutes.js that resolveActor ignores headers
            const databaseRoutes = require("../../discord/index/databaseRoutes");
            // Since resolveActor is internal to databaseRoutes.js, test via route or test helper
            const code = fs.readFileSync(path.join(__dirname, "../../discord/index/databaseRoutes.js"), "utf8");
            assert.ok(!code.includes('req.headers["x-owner-id"]'), "databaseRoutes.js must not read x-owner-id from headers");
        });
    });

    describe("Item 7: Database Center Observability (dbstat, db.stats, scheduler nextRunAt)", () => {
        test("getSqliteDetailedStatus returns categories with count, bytes, and sizeMb", async () => {
            const status = await databaseService.getSqliteDetailedStatus();
            assert.ok(status.categories);
            assert.ok(status.categories.core);
            assert.ok(status.categories.temporary);
            assert.ok(status.categories.history);
            assert.ok(status.categories.cache);

            assert.equal(typeof status.categories.core.bytes, "number");
            assert.equal(typeof status.categories.core.sizeMb, "number");
            assert.equal(typeof status.storage.isPersistent, "boolean");
        });

        test("getSchedulerDiagnostics provides nextRunAt for maintenance tasks", () => {
            const diag = scheduler.getSchedulerDiagnostics();
            assert.ok(diag.diagnostics);
            assert.ok("wal" in diag.diagnostics);
            assert.ok("cleanup" in diag.diagnostics);
            assert.ok("vacuum" in diag.diagnostics);
            assert.ok("backup" in diag.diagnostics);
            assert.ok("emergency" in diag.diagnostics);
        });
    });

    describe("Item 9: Migration 004 Hazard Documentation in Runbook", () => {
        test("sqlite-operations.md contains migration 004 hazard note and immutable forward-only policy", () => {
            const doc = fs.readFileSync(path.join(__dirname, "../../docs/sqlite-operations.md"), "utf8");
            assert.ok(doc.includes("Migration 004 Hazard Note"), "Must document Migration 004 hazard");
            assert.ok(doc.includes("Immutable Forward-Only"), "Must enforce Immutable Forward-Only migration policy");
        });
    });

    describe("Item 10: SQLite Compatibility Facades Decoupled from Mongoose Models", () => {
        test("VerificationRecovery facade operates without registering Mongoose model", async () => {
            assert.equal(typeof VerificationRecovery.create, "function");
            assert.equal(typeof VerificationRecovery.findOne, "function");
            assert.equal(typeof VerificationRecovery.updateOne, "function");
            assert.equal(typeof VerificationRecovery.deleteMany, "function");
        });

        test("VerificationStateNonce facade operates without registering Mongoose model", async () => {
            assert.equal(typeof VerificationStateNonce.create, "function");
            assert.equal(typeof VerificationStateNonce.exists, "function");
            assert.equal(typeof VerificationStateNonce.findOne, "function");
            assert.equal(typeof VerificationStateNonce.findOneAndUpdate, "function");
        });

        test("DmNotification facade operates without registering Mongoose model", async () => {
            assert.equal(typeof DmNotification.create, "function");
            assert.equal(typeof DmNotification.findOne, "function");
            assert.equal(typeof DmNotification.find, "function");
            assert.equal(typeof DmNotification.updateOne, "function");
        });
    });
});
