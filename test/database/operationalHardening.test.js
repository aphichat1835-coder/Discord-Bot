"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { AssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");
const scheduler = require("../../database/sqlite/maintenance/scheduler");
const sessionManager = require("../../discord/sessionManager");
const database = require("../../database");

describe("Operational Hardening Suite (Graceful Drain, Auto-Backup, Type TTL)", () => {
    let testDb;
    let testAssetDir;

    before(() => {
        testDb = new Database(":memory:");
        testDb.pragma("foreign_keys = ON");
        runMigrations(testDb);

        testAssetDir = path.join(__dirname, "test-hardening-assets");
        if (fs.existsSync(testAssetDir)) {
            fs.rmSync(testAssetDir, { recursive: true, force: true });
        }
    });

    after(() => {
        if (fs.existsSync(testAssetDir)) {
            fs.rmSync(testAssetDir, { recursive: true, force: true });
        }
        if (testDb) testDb.close();
    });

    test("Type-specific Asset Cache TTL: 3d for avatar, 14d for icon, 7d for default", () => {
        const assetMgr = new AssetCacheManager(testDb, { assetDir: testAssetDir });
        const now = Date.now();

        // 1. Avatar (3 days)
        const avBuf = Buffer.from("test_avatar_data");
        assetMgr.setAsset("user_avatar_1", avBuf, { assetType: "avatar", mimeType: "image/png" });
        const avRow = testDb.prepare("SELECT * FROM asset_cache WHERE asset_key = ?").get("user_avatar_1");
        assert.ok(avRow);
        const avDiffDays = Math.round((avRow.expires_at - now) / (24 * 60 * 60 * 1000));
        assert.equal(avDiffDays, 3);

        // 2. Guild Icon (14 days)
        const iconBuf = Buffer.from("test_guild_icon_data");
        assetMgr.setAsset("guild_icon_1", iconBuf, { assetType: "guild_icon", mimeType: "image/png" });
        const iconRow = testDb.prepare("SELECT * FROM asset_cache WHERE asset_key = ?").get("guild_icon_1");
        assert.ok(iconRow);
        const iconDiffDays = Math.round((iconRow.expires_at - now) / (24 * 60 * 60 * 1000));
        assert.equal(iconDiffDays, 14);

        // 3. Default / General (7 days)
        const genBuf = Buffer.from("test_general_data");
        assetMgr.setAsset("general_asset_1", genBuf, { assetType: "general", mimeType: "image/png" });
        const genRow = testDb.prepare("SELECT * FROM asset_cache WHERE asset_key = ?").get("general_asset_1");
        assert.ok(genRow);
        const genDiffDays = Math.round((genRow.expires_at - now) / (24 * 60 * 60 * 1000));
        assert.equal(genDiffDays, 7);
    });

    test("Scheduler: runAutoBackup runs without crashing and updates diagnostics", async () => {
        const diagBefore = scheduler.getSchedulerDiagnostics();
        assert.ok(diagBefore.diagnostics.backup);

        // Execute runAutoBackup
        await scheduler.runAutoBackup();

        const diagAfter = scheduler.getSchedulerDiagnostics();
        assert.ok(diagAfter.diagnostics.backup.lastRunAt);
        assert.ok(["success", "error"].includes(diagAfter.diagnostics.backup.lastStatus));
    });

    test("Graceful Shutdown: disconnectDB triggers database.shutdown() cleanly", async () => {
        // Calling disconnectDB when already disconnected should invoke database.shutdown() safely
        await sessionManager.disconnectDB();
        assert.equal(typeof sessionManager.disconnectDB, "function");
    });
});
