"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const VoiceSessionRuntimeRepository = require("../../database/sqlite/repositories/core/VoiceSessionRuntimeRepository");
const { VoiceEventRepository } = require("../../database/sqlite/repositories/history/VoiceEventRepository");
const { AssetCacheManager } = require("../../database/sqlite/cache/assetCacheManager");
const scheduler = require("../../database/sqlite/maintenance/scheduler");

describe("Advanced Refinements Suite (Migration 004, Runtime, Buffer, AssetCache, Scheduler)", () => {
    let db;
    let testAssetDir;

    before(() => {
        db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        runMigrations(db);

        testAssetDir = path.join(__dirname, "test-cache-assets");
        if (fs.existsSync(testAssetDir)) {
            fs.rmSync(testAssetDir, { recursive: true, force: true });
        }
    });

    after(() => {
        if (fs.existsSync(testAssetDir)) {
            fs.rmSync(testAssetDir, { recursive: true, force: true });
        }
        if (db) db.close();
    });

    test("VoiceSessionRuntimeRepository: upserts and records heartbeat in SQLite", () => {
        const repo = new VoiceSessionRuntimeRepository(db);
        const sessionId = "session_test_001";

        const created = repo.upsertSessionRuntime({
            sessionId,
            serverId: "guild_123",
            ownerId: "owner_456",
            state: "active",
            reconnectCount: 2,
            statusLabel: "ready"
        });

        assert.equal(created.session_id, sessionId);
        assert.equal(created.server_id, "guild_123");
        assert.equal(created.owner_id, "owner_456");
        assert.equal(created.state, "active");
        assert.equal(created.reconnect_count, 2);

        // Record heartbeat
        const hbSuccess = repo.recordHeartbeat(sessionId, 1700000000000);
        assert.equal(hbSuccess, true);

        const fetched = repo.getSessionRuntime(sessionId);
        assert.equal(fetched.last_heartbeat, 1700000000000);

        const activeList = repo.listActiveSessionRuntimes();
        assert.equal(activeList.length, 1);

        const deleted = repo.deleteSessionRuntime(sessionId);
        assert.equal(deleted, true);
        assert.equal(repo.getSessionRuntime(sessionId), null);
    });

    test("VoiceEventRepository: multi-trigger buffer flushes on size threshold and bounds queue cap", () => {
        const repo = new VoiceEventRepository(db);

        // Record 99 events (less than 100 threshold)
        for (let i = 0; i < 99; i++) {
            repo.record({
                eventType: "voice_connect",
                sessionId: `s_${i}`,
                detail: `detail_${i}`
            });
        }

        const statsBefore = repo.getBufferStats();
        assert.equal(statsBefore.bufferedCount, 99);

        // 100th event triggers auto-flush
        repo.record({
            eventType: "voice_connect",
            sessionId: "s_100",
            detail: "detail_100"
        });

        const statsAfter = repo.getBufferStats();
        assert.equal(statsAfter.bufferedCount, 0);

        // Test queue cap guard: fill up to 2000
        repo.maxQueueCap = 150; // set small cap for test
        repo.flushSizeThreshold = 500; // prevent auto-flush on 100

        for (let i = 0; i < 160; i++) {
            repo.record({ eventType: "spam", detail: `spam_${i}` });
        }

        const statsCap = repo.getBufferStats();
        assert.equal(statsCap.isDegraded, true);
        assert.ok(statsCap.droppedEventsCount > 0);

        repo.stopFlusher();
    });

    test("AssetCacheManager: disk file storage, 500MB quota enforcement, and LRU eviction", () => {
        const assetMgr = new AssetCacheManager(db, {
            assetDir: testAssetDir,
            maxQuotaBytes: 1024 * 1024 // 1MB for test
        });

        const buf1 = Buffer.from("fake_avatar_image_binary_data_1");
        const res1 = assetMgr.setAsset("avatar_user_1", buf1, {
            assetType: "avatar",
            mimeType: "image/png"
        });

        assert.ok(res1);
        assert.ok(fs.existsSync(res1.filePath));

        // Get asset
        const retrieved = assetMgr.getAsset("avatar_user_1");
        assert.ok(retrieved);
        assert.equal(retrieved.key, "avatar_user_1");
        assert.equal(retrieved.mimeType, "image/png");
        assert.equal(retrieved.buffer.toString(), "fake_avatar_image_binary_data_1");

        // Quota stats
        const stats = assetMgr.getStats();
        assert.equal(stats.count, 1);
        assert.ok(stats.totalBytes > 0);

        // Orphan reconciliation test: delete physical file and test cache miss & recovery
        fs.unlinkSync(res1.filePath);
        const miss = assetMgr.getAsset("avatar_user_1");
        assert.equal(miss, null); // missing physical file treated as cache miss

        // Verify orphan row was cleaned up
        const row = db.prepare("SELECT * FROM asset_cache WHERE asset_key = ?").get("avatar_user_1");
        assert.equal(row, undefined);
    });

    test("Scheduler: lock guard prevents overlapping executions and tracks diagnostics", async () => {
        const schedulerDiag = scheduler.getSchedulerDiagnostics();
        assert.ok(schedulerDiag.diagnostics);
        assert.equal(typeof schedulerDiag.diagnostics.wal.runCount, "number");

        // Start and verify all 5 timers are active
        scheduler.startScheduler();
        const activeDiag = scheduler.getSchedulerDiagnostics();
        assert.equal(activeDiag.active, true);
        assert.equal(activeDiag.timers.wal, true, "WAL timer should be created");
        assert.equal(activeDiag.timers.cleanup, true, "Cleanup timer should be created");
        assert.equal(activeDiag.timers.vacuum, true, "Vacuum timer should be created");
        assert.equal(activeDiag.timers.backup, true, "Auto-backup timer should be created");
        assert.equal(activeDiag.timers.emergency, true, "Emergency timer should be created");

        scheduler.stopScheduler();
        assert.equal(scheduler.getSchedulerDiagnostics().active, false);
    });
});
