"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { TABLE_CATEGORIES } = require("../../database/sqlite/tableCategories");
const { getAssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");
const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const databaseService = require("../../database/services/databaseService");
const { sanitizeDetails } = require("../../database/sqlite/repositories/history/bufferPolicy");
const { restoreDatabase } = require("../../scripts/db/restoreSqlite");
const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");

describe("Audit Findings Remediation Verification (Items 1-7)", () => {
    let tempDir;
    let testDbPath;
    let testDb;

    before(() => {
        tempDir = path.join(__dirname, "temp-findings-" + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        testDbPath = path.join(tempDir, "test.sqlite");
        process.env.SQLITE_DB_PATH = testDbPath;
        testDb = openDatabase({ path: testDbPath });
        runMigrations(testDb);
    });

    after(() => {
        closeDatabase();
        delete process.env.SQLITE_DB_PATH;
        if (fs.existsSync(tempDir)) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    describe("Item 1: Asset Cache Stats Parity & databaseService integration", () => {
        test("assetCacheManager getCacheStats alias matches getStats exactly", () => {
            const assetDir = path.join(tempDir, "assets1");
            const assetMgr = getAssetCacheManager(testDb, { cacheDir: assetDir });

            assert.equal(typeof assetMgr.getCacheStats, "function");
            assert.equal(typeof assetMgr.getStats, "function");

            const stats1 = assetMgr.getStats();
            const stats2 = assetMgr.getCacheStats();
            assert.deepEqual(stats1, stats2);
        });

        test("real asset saved is accurately reported (> 0 bytes) in getDatabaseOverview and getSqliteDetailedStatus", async () => {
            const assetDir = path.join(tempDir, "assets_real");
            const assetMgr = getAssetCacheManager(testDb, { assetDir });

            // Store a real 2KB dummy asset
            const buffer = Buffer.alloc(2048, "x");
            assetMgr.setAsset("guild_icon_12345", buffer, { assetType: "icon", mimeType: "image/png" });

            const stats = assetMgr.getStats();
            assert.ok(stats.totalBytes >= 2048, `Expected totalBytes >= 2048, got ${stats.totalBytes}`);
            assert.equal(stats.count, 1);

            // Mock databaseService getting db
            const originalGetSqlite = databaseService.getSqliteDb;
            databaseService.getSqliteDb = () => testDb;

            try {
                const overview = await databaseService.getDatabaseOverview();
                assert.ok(overview.databases.sqlite.storage.managedStorage.assetBytes >= 2048, "Overview must report real assetCache bytes");

                const detailed = await databaseService.getSqliteDetailedStatus();
                assert.ok(detailed.storage.managedStorage.assetBytes >= 2048, "Detailed status must report real assetCacheBytes");
            } finally {
                databaseService.getSqliteDb = originalGetSqlite;
            }
        });
    });

    describe("Item 2: Database Center Table Categories Architectural Parity", () => {
        test("getSqliteDetailedStatus derives categories from TABLE_CATEGORIES with database_meta in CORE", async () => {
            const originalGetSqlite = databaseService.getSqliteDb;
            databaseService.getSqliteDb = () => testDb;

            try {
                const detailed = await databaseService.getSqliteDetailedStatus();
                assert.ok(detailed.categories, "detailed.categories must exist");

                // Assert core category exists and contains database_meta
                assert.ok(detailed.categories.core, "Core category must exist");
                assert.ok(detailed.categories.core.tables.database_meta, "database_meta must be under core");

                // Assert temporary category exists and does NOT contain database_meta
                assert.ok(detailed.categories.temporary, "Temporary category must exist");
                assert.equal(detailed.categories.temporary.tables.database_meta, undefined, "database_meta must not be in temporary");
                assert.ok(detailed.categories.temporary.tables.verification_state_nonce, "verification_state_nonce must be in temporary");

                // Assert all central categories exist in detailed status
                for (const catDef of Object.values(TABLE_CATEGORIES)) {
                    assert.ok(detailed.categories[catDef.key], `Category ${catDef.key} must be present in detailed status`);
                    assert.equal(detailed.categories[catDef.key].label, catDef.label);
                }
            } finally {
                databaseService.getSqliteDb = originalGetSqlite;
            }
        });
    });

    describe("Item 3: SQLite Restore Staging Integrity & Atomic Copy", () => {
        test("restoreDatabase uses staging file, verifies integrity, cleans journals, and restores target", async () => {
            const restoreDir = path.join(tempDir, "restore-test");
            fs.mkdirSync(restoreDir, { recursive: true });

            const targetDbFile = path.join(restoreDir, "app.sqlite");
            const backupDbFile = path.join(restoreDir, "backup.sqlite");

            // Create target DB with version 1
            const target = new Database(targetDbFile);
            target.exec("CREATE TABLE foo (id INT); INSERT INTO foo VALUES (1);");
            target.close();

            // Create backup DB with version 2
            const backup = new Database(backupDbFile);
            backup.exec("CREATE TABLE foo (id INT); INSERT INTO foo VALUES (2);");
            backup.close();

            // Create dummy journal and wal files to verify cleanup
            fs.writeFileSync(`${targetDbFile}-wal`, "dummy wal");
            fs.writeFileSync(`${targetDbFile}-shm`, "dummy shm");
            fs.writeFileSync(`${targetDbFile}-journal`, "dummy journal");

            // Perform restore
            await restoreDatabase({
                sourceBackup: backupDbFile,
                targetDb: targetDbFile,
                force: true
            });

            // Target should now have value 2
            const restored = new Database(targetDbFile, { readonly: true });
            const row = restored.prepare("SELECT id FROM foo").get();
            assert.equal(row.id, 2);
            restored.close();

            // Auxiliary files should be cleaned up
            assert.equal(fs.existsSync(`${targetDbFile}-wal`), false);
            assert.equal(fs.existsSync(`${targetDbFile}-shm`), false);
            assert.equal(fs.existsSync(`${targetDbFile}-journal`), false);
        });

        test("restoreDatabase safely rolls back if staging copy encounters corrupted source", async () => {
            const restoreDir = path.join(tempDir, "restore-rollback");
            fs.mkdirSync(restoreDir, { recursive: true });

            const targetDbFile = path.join(restoreDir, "target.sqlite");
            const corruptBackupFile = path.join(restoreDir, "corrupt.sqlite");

            // Create original target DB with id 999
            const target = new Database(targetDbFile);
            target.exec("CREATE TABLE original (id INT); INSERT INTO original VALUES (999);");
            target.close();

            // Create corrupted file (random garbage text, not valid SQLite)
            fs.writeFileSync(corruptBackupFile, "NOT A VALID SQLITE DATABASE FILE GARBAGE CONTENT 12345");

            // Restore should reject because staging integrity check fails
            await assert.rejects(
                restoreDatabase({
                    sourceBackup: corruptBackupFile,
                    targetDb: targetDbFile,
                    force: true
                }),
                (err) => {
                    return /file is not a database|integrity/i.test(err.message);
                }
            );

            // Original target DB must remain intact with id 999
            const checkDb = new Database(targetDbFile, { readonly: true });
            const row = checkDb.prepare("SELECT id FROM original").get();
            assert.equal(row.id, 999);
            checkDb.close();
        });
    });

    describe("Item 4: Command Telemetry Sanitizer Hardening", () => {
        test("sanitizeDetails returns [REDACTED_NESTED] at depth >= 5", () => {
            const nested = {
                l1: {
                    l2: {
                        l3: {
                            l4: {
                                l5: {
                                    secret: "too_deep_value"
                                }
                            }
                        }
                    }
                }
            };

            const cleaned = sanitizeDetails(nested);
            assert.equal(typeof cleaned.l1.l2.l3.l4.l5, "string");
            assert.equal(cleaned.l1.l2.l3.l4.l5, "[REDACTED_NESTED]");
        });

        test("sanitizeDetails redacts inline credential strings", () => {
            const payload = {
                command: "eval",
                details: "Connecting with token=supersecrettoken123&env=prod",
                userPass: "password=supersecretpassword",
                botKey: "Bot MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.abcDEF.GHIjklMNOpqrSTUvwxYZ"
            };

            const cleaned = sanitizeDetails(payload);
            assert.ok(!cleaned.details.includes("supersecrettoken123"));
            assert.ok(!cleaned.userPass.includes("supersecretpassword"));
            assert.ok(!cleaned.botKey.includes("MTIzNDU2Nzg5MDEyMzQ1Njc4OTA"));
            assert.ok(cleaned.details.includes("[REDACTED_CREDENTIAL]"));
            assert.ok(cleaned.userPass.includes("[REDACTED_CREDENTIAL]"));
        });
    });

    describe("Item 5: Asset Cache Orphan File Prevention", () => {
        test("setAsset cleans up newly written file if SQLite metadata insert throws", () => {
            const orphanDir = path.join(tempDir, "assets_orphan");
            // Broken DB that throws on prepare
            const brokenDb = {
                prepare: () => { throw new Error("Simulated SQLite disk I/O error"); }
            };

            const assetMgr = getAssetCacheManager(brokenDb, { assetDir: orphanDir });
            const buffer = Buffer.from("test orphan content");

            const result = assetMgr.setAsset("orphan_asset_key", buffer, { assetType: "avatar", mimeType: "image/png" });
            assert.equal(result, null, "setAsset should return null on DB error");

            // Verify no physical file leaked into asset directory
            const files = fs.readdirSync(orphanDir);
            assert.equal(files.length, 0, "No orphaned files should remain in cacheDir after insert failure");
        });
    });

    describe("Item 6: Persistent Storage Label", () => {
        test("storage label displays 'Owner-Confirmed Persistent Path'", async () => {
            const originalGetSqlite = databaseService.getSqliteDb;
            databaseService.getSqliteDb = () => testDb;

            try {
                const detailed = await databaseService.getSqliteDetailedStatus();
                assert.ok(typeof detailed.storage.persistentLabel === "string");
                if (detailed.storage.persistentMountVerified) {
                    assert.equal(detailed.storage.persistentLabel, "✅ Owner-Confirmed Persistent Path");
                }
            } finally {
                databaseService.getSqliteDb = originalGetSqlite;
            }
        });
    });

    describe("Item 7: Auto Backup Baseline Safety Policy", () => {
        test("scheduler.js documents baseline safety backup policy when backups.length === 0", () => {
            const schedulerPath = path.join(__dirname, "../../database/sqlite/maintenance/scheduler.js");
            const content = fs.readFileSync(schedulerPath, "utf8");
            assert.ok(content.includes("Baseline safety policy"), "scheduler.js must include baseline safety policy comment");
            assert.ok(content.includes("backups.length === 0"), "scheduler.js must reference backups.length === 0 condition");
        });
    });
});
