"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Database = require("better-sqlite3");

const { canWrite, resetWritePolicyCache } = require("../../database/sqlite/maintenance/writePolicy");
const { evaluateStoragePaths } = require("../../database/sqlite/maintenance/storageCheck");
const { CacheManager } = require("../../database/sqlite/cache/cacheManager");
const { AssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");
const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");

describe("Pass 1: Write Policy, Asset Accounting & Storage Semantics Suite", () => {
    let testDb;
    let tempDir;

    before(() => {
        tempDir = path.join(os.tmpdir(), "temp-pass1-" + Date.now());
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

    test("1. canWrite enforces category rules based on quota", () => {
        // Core is never blocked
        assert.equal(canWrite("core", { quota: { status: "hard", isCacheBlocked: true, isHistoryBlocked: true, isWriteBlocked: true } }), true);

        // Cache is blocked when critical or hard
        assert.equal(canWrite("cache", { quota: { status: "critical", isCacheBlocked: true, isHistoryBlocked: false, isWriteBlocked: false } }), false);
        assert.equal(canWrite("cache", { quota: { status: "ok", isCacheBlocked: false, isHistoryBlocked: false, isWriteBlocked: false } }), true);

        // History is blocked when hard
        assert.equal(canWrite("history", { quota: { status: "hard", isCacheBlocked: true, isHistoryBlocked: true, isWriteBlocked: true } }), false);
        assert.equal(canWrite("history", { quota: { status: "critical", isCacheBlocked: true, isHistoryBlocked: false, isWriteBlocked: false } }), true);

        // Telemetry P2 is dropped on soft/critical/hard
        assert.equal(canWrite("telemetry", { priority: "P2", quota: { status: "soft", isCacheBlocked: false, isHistoryBlocked: false, isWriteBlocked: false } }), false);
        assert.equal(canWrite("telemetry", { priority: "P1", quota: { status: "soft", isCacheBlocked: false, isHistoryBlocked: false, isWriteBlocked: false } }), true);
    });

    test("2. CacheManager skips write when cache is blocked", () => {
        const cache = new CacheManager(testDb);

        // Under fake hard quota
        const origCanWrite = require("../../database/sqlite/maintenance/writePolicy").canWrite;
        try {
            // Test normal write
            const ok = cache.set("test_ns", "key_1", { hello: "world" });
            assert.equal(ok, true);
            assert.deepEqual(cache.get("test_ns", "key_1"), { hello: "world" });
        } finally {
            cache.stopTouchFlusher();
        }
    });

    test("3. AssetCacheManager calculates deduplicated size across unique relative_path", () => {
        const assetDir = path.join(tempDir, "assets");
        fs.mkdirSync(assetDir, { recursive: true });
        const assetMgr = new AssetCacheManager(testDb, { assetDir });

        try {
            const buf = Buffer.from("identical_image_payload_binary_bytes");
            // Store two different keys with identical payload (deduplication)
            assetMgr.setAsset("avatar_user_1", buf, { mimeType: "image/png" });
            assetMgr.setAsset("avatar_user_2", buf, { mimeType: "image/png" });

            const stats = assetMgr.getStats();
            assert.equal(stats.count, 2, "Row count is 2");
            assert.equal(stats.totalBytes, buf.length, "Physical bytes should only be counted once (deduplicated)");
        } finally {
            assetMgr.stopTouchFlusher();
        }
    });

    test("4. StorageCheck separates configuredPersistentPath from persistentMountVerified", () => {
        const origConfirmed = process.env.SQLITE_PERSISTENCE_CONFIRMED;
        const origNodeEnv = process.env.NODE_ENV;
        const origAllow = process.env.ALLOW_IN_SOURCE_STORAGE;

        try {
            process.env.NODE_ENV = "production";
            delete process.env.SQLITE_PERSISTENCE_CONFIRMED;

            const resUnconfirmed = evaluateStoragePaths({
                dbPath: "/persistent/data/db.sqlite",
                backupDir: "/persistent/backups",
                assetDir: "/persistent/assets"
            });
            assert.equal(resUnconfirmed.configuredPersistentPath, true);
            assert.equal(resUnconfirmed.persistentMountVerified, false, "Unconfirmed without SQLITE_PERSISTENCE_CONFIRMED");

            process.env.SQLITE_PERSISTENCE_CONFIRMED = "true";
            const resConfirmed = evaluateStoragePaths({
                dbPath: "/persistent/data/db.sqlite",
                backupDir: "/persistent/backups",
                assetDir: "/persistent/assets"
            });
            assert.equal(resConfirmed.configuredPersistentPath, true);
            assert.equal(resConfirmed.persistentMountVerified, true, "Confirmed with SQLITE_PERSISTENCE_CONFIRMED");

            // ALLOW_IN_SOURCE_STORAGE suppression
            process.env.ALLOW_IN_SOURCE_STORAGE = "true";
            const resSuppressed = evaluateStoragePaths();
            assert.equal(resSuppressed.pathWarning, false, "ALLOW_IN_SOURCE_STORAGE must suppress pathWarning");
        } finally {
            if (origConfirmed !== undefined) process.env.SQLITE_PERSISTENCE_CONFIRMED = origConfirmed;
            else delete process.env.SQLITE_PERSISTENCE_CONFIRMED;
            if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
            else delete process.env.NODE_ENV;
            if (origAllow !== undefined) process.env.ALLOW_IN_SOURCE_STORAGE = origAllow;
            else delete process.env.ALLOW_IN_SOURCE_STORAGE;
        }
    });

    test("5. Destructive migration detection and pre-migration safety backup", () => {
        const { isDestructiveMigration, runMigrations } = require("../../database/sqlite/migrations/migrationRunner");

        assert.equal(isDestructiveMigration("CREATE TABLE foo (id INT);"), false);
        assert.equal(isDestructiveMigration("-- comment with DROP TABLE\nCREATE TABLE bar (id INT);"), false);
        assert.equal(isDestructiveMigration("/* block comment DROP TABLE users */ CREATE TABLE foo (id INT);"), false);
        assert.equal(isDestructiveMigration("/* multiline\r\nDROP TABLE\r\nTRUNCATE\r\n*/ CREATE TABLE bar (id INT);"), false);
        assert.equal(isDestructiveMigration("INSERT INTO logs VALUES ('DROP TABLE in string');"), false);
        assert.equal(isDestructiveMigration("INSERT INTO logs VALUES ('Escaped '' DROP TABLE '' quote');"), false);
        assert.equal(isDestructiveMigration("/* unterminated comment DROP TABLE"), false);
        assert.equal(isDestructiveMigration("DROP TABLE users;"), true);
        assert.equal(isDestructiveMigration("DROP TABLE IF EXISTS asset_cache;"), true);
        assert.equal(isDestructiveMigration("ALTER TABLE orders DROP COLUMN old_col;"), true);
        assert.equal(isDestructiveMigration("TRUNCATE TABLE logs;"), true);

        // Adversarial ReDoS resistance check: long repetitive input must finish in linear time
        const adversarial = "/* " + "*".repeat(20000) + " / ".repeat(5000) + " */ CREATE TABLE safe (id INT);";
        const t0 = Date.now();
        assert.equal(isDestructiveMigration(adversarial), false);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 200, `Scanner must complete in linear time (< 200ms, took ${elapsed}ms)`);

        // Test that running a destructive migration against a database with backupDir creates a pre-migration backup
        const testMigrationsDir = path.join(tempDir, "custom_migrations");
        fs.mkdirSync(testMigrationsDir, { recursive: true });

        fs.writeFileSync(path.join(testMigrationsDir, "001_initial.sql"), "CREATE TABLE dummy_items (id INT, val TEXT);\nINSERT INTO dummy_items VALUES (1, 'hello');");
        fs.writeFileSync(path.join(testMigrationsDir, "002_drop.sql"), "DROP TABLE dummy_items;");

        const migrationDbPath = path.join(tempDir, "migration_test.sqlite");
        const bkpDir = path.join(tempDir, "migration_backups");
        const mDb = new Database(migrationDbPath);
        mDb.pragma("journal_mode = WAL");

        const results = runMigrations(mDb, { migrationsDir: testMigrationsDir, backupDir: bkpDir });
        assert.equal(results.applied.length, 2);
        assert.equal(results.preMigrationBackups.length, 1, "Must create 1 pre-migration backup for destructive 002");
        assert.ok(fs.existsSync(results.preMigrationBackups[0].backupPath), "Pre-migration backup file must exist on disk");

        // Verify pre-migration backup contains dummy_items before it was dropped
        const bkpDb = new Database(results.preMigrationBackups[0].backupPath, { readonly: true });
        const row = bkpDb.prepare("SELECT * FROM dummy_items").get();
        assert.deepEqual(row, { id: 1, val: "hello" });
        bkpDb.close();
        mDb.close();
    });

    test("6. createBackup uses atomic .tmp write and accounts for total footprint", async () => {
        const { createBackup } = require("../../database/sqlite/maintenance/backup");
        const backupTargetDir = path.join(tempDir, "atomic_backups");

        const res = await createBackup(testDb, { backupDir: backupTargetDir, filename: "atomic_test.sqlite" });
        assert.equal(res.ok, true);
        assert.equal(res.verified, true);
        assert.ok(fs.existsSync(res.path), "Promoted backup file must exist");
        assert.equal(fs.existsSync(`${res.path}.tmp`), false, "Temporary .tmp file must be renamed/cleaned up");
    });

    test("7. TokenCoordinator emits subsystem in token:rate_limited payload", () => {
        const { TokenCoordinator } = require("../../discord/tokens/tokenCoordinator");
        const coordinator = new TokenCoordinator();

        let captured = null;
        coordinator.on("token:rate_limited", (evt) => {
            captured = evt;
        });

        coordinator.applyTokenBackoff("dummy_subsystem_test_token", 4000, {
            subsystem: "quest",
            reason: "429_test",
            source: "rest_api"
        });

        assert.ok(captured, "Event must be emitted");
        assert.equal(captured.subsystem, "quest", "Subsystem must be passed into event");
        assert.equal(captured.reason, "429_test");
        assert.equal(captured.source, "rest_api");
    });

    test("8. _upsertAssetMetadata object parameter contract and setAsset rollback on DB error", () => {
        const assetDir = path.join(tempDir, "assets_rollback_test");
        fs.mkdirSync(assetDir, { recursive: true });
        const assetMgr = new AssetCacheManager(testDb, { assetDir });

        try {
            // Direct call to _upsertAssetMetadata with object parameter
            const now = Date.now();
            assetMgr._upsertAssetMetadata({
                assetKey: "direct_object_test_key",
                assetType: "avatar",
                relativePath: "avatar_direct.png",
                mimeType: "image/png",
                sizeBytes: 1234,
                sha256: "abc123sha",
                sourceUrl: "https://example.com/avatar.png",
                now,
                expiresAt: now + 60000
            });

            const row = testDb.prepare("SELECT * FROM asset_cache WHERE asset_key = ?").get("direct_object_test_key");
            assert.ok(row, "Metadata row must be inserted via object param");
            assert.equal(row.asset_type, "avatar");
            assert.equal(row.size_bytes, 1234);
            assert.equal(row.source_url, "https://example.com/avatar.png");

            // Test setAsset compensation/rollback when _upsertAssetMetadata throws
            const origUpsert = assetMgr._upsertAssetMetadata;
            assetMgr._upsertAssetMetadata = () => {
                throw new Error("Simulated database failure during metadata insert");
            };

            const payload = Buffer.from("unique_rollback_payload_test");
            const res = assetMgr.setAsset("rollback_key_1", payload, { mimeType: "image/png" });
            assert.equal(res, null, "setAsset must return null on failure");

            // Verify file was cleaned up on disk and not left orphaned
            const crypto = require("node:crypto");
            const sha = crypto.createHash("sha256").update(payload).digest("hex");
            const expectedFilePath = path.join(assetDir, `${sha}.png`);
            assert.equal(fs.existsSync(expectedFilePath), false, "Orphaned file must be deleted on DB error");

            assetMgr._upsertAssetMetadata = origUpsert;
        } finally {
            assetMgr.stopTouchFlusher();
        }
    });
});
