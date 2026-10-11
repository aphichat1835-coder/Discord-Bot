"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const webhooks = require("../../discord/core/webhooks");
const mongo = require("../../database/mongo/connection");
const { notifyIntegrityCorrupted } = require("../../database/services/databaseService");
const { notifyBufferDropped } = require("../../database/sqlite/repositories/history/telemetryAlert");
const { resetAlertThrottle } = require("../../database/sqlite/maintenance/quota");

describe("Database Webhooks Alert Lifecycle Suite", () => {
    let originalEnqueue;
    let sentQueue = [];

    before(() => {
        originalEnqueue = webhooks._test.defaultDispatcher.enqueue;
    });

    after(() => {
        webhooks._test.defaultDispatcher.enqueue = originalEnqueue;
    });

    beforeEach(() => {
        sentQueue = [];
        webhooks._test.defaultDispatcher.enqueue = function(target, payload, options = {}) {
            sentQueue.push({ target, payload, options });
            return Promise.resolve(true);
        };
        resetAlertThrottle();
        if (mongo._resetStateForTesting) {
            mongo._resetStateForTesting();
        }
    });

    function getPrimaryAlerts() {
        return sentQueue.filter(s => s.payload.embeds[0].title !== "Owner event continuation");
    }

    // ─── 1. MONGODB CONNECTION DISCONNECT / RECONNECT / ERROR ───────────────

    test("MongoDB connection lost dispatches CRITICAL alert on sudden disconnect", async () => {
        // Step 1: Initial successful connection
        mongo.mongoose.connection.emit("connected");
        assert.equal(getPrimaryAlerts().length, 0, "Initial connect is not a reconnect, no alert expected");

        // Step 2: Sudden disconnect (without explicit shutdown)
        mongo.mongoose.connection.emit("disconnected");

        const primaryAlerts = getPrimaryAlerts();
        assert.equal(primaryAlerts.length, 1);
        const item = primaryAlerts[0];
        assert.equal(item.target, "ALERT");
        assert.equal(item.options.eventCode, "mongo.connection.lost");
        assert.match(item.payload.embeds[0].footer.text, /mongo\.connection\.lost/);
        assert.match(item.payload.embeds[0].title, /ขาดการเชื่อมต่อ/);

        // P0 Renovation: Single primary embed by default (no automatic continuation spam)
        const continuation = sentQueue.find(s => s.payload.embeds[0].title === "Owner event continuation");
        assert.equal(continuation, undefined, "P0: Single primary embed by default without duplicate continuation");
    });

    test("MongoDB connection error dispatches CRITICAL alert", async () => {
        // Step 1: Connect
        mongo.mongoose.connection.emit("connected");
        sentQueue = [];

        // Step 2: Connection error
        const testErr = new Error("MongoNetworkTimeoutError: connection timed out");
        mongo.mongoose.connection.emit("error", testErr);

        const primaryAlerts = getPrimaryAlerts();
        assert.equal(primaryAlerts.length, 1);
        const item = primaryAlerts[0];
        assert.equal(item.target, "ALERT");
        assert.equal(item.options.eventCode, "mongo.connection.error");
        assert.match(item.payload.embeds[0].footer.text, /mongo\.connection\.error/);

        const errorField = item.payload.embeds[0].fields.find(f => f.name === "ข้อความ Error");
        assert.ok(errorField);
        assert.match(errorField.value, /MongoNetworkTimeoutError/);
    });

    test("MongoDB connection restored dispatches SUCCESS alert on reconnection", async () => {
        // Step 1: Initial connection
        mongo.mongoose.connection.emit("connected");
        // Step 2: Connection lost
        mongo.mongoose.connection.emit("disconnected");
        sentQueue = [];

        // Step 3: Reconnection established
        mongo.mongoose.connection.emit("connected");

        const primaryAlerts = getPrimaryAlerts();
        assert.equal(primaryAlerts.length, 1);
        const item = primaryAlerts[0];
        assert.equal(item.target, "ALERT");
        assert.equal(item.options.eventCode, "mongo.connection.restored");
        assert.match(item.payload.embeds[0].footer.text, /mongo\.connection\.restored/);
        assert.match(item.payload.embeds[0].title, /กลับมาเชื่อมต่อแล้ว/);
    });

    test("MongoDB explicit disconnect suppresses lost alert during graceful shutdown", async () => {
        // Step 1: Connect
        mongo.mongoose.connection.emit("connected");
        sentQueue = [];

        // Step 2: Calling disconnectMongo sets isExplicitShutdown = true
        await mongo.disconnectMongo();
        mongo.mongoose.connection.emit("disconnected");

        // No lost alert should be queued
        const lostAlerts = getPrimaryAlerts().filter(s => s.options.eventCode === "mongo.connection.lost");
        assert.equal(lostAlerts.length, 0);
    });

    // ─── 2. SQLITE DEEP INTEGRITY CORRUPTION ALERT ──────────────────────────

    test("notifyIntegrityCorrupted dispatches CRITICAL alert and respects 15m throttle", async () => {
        const fakeIntRows = [{ integrity_check: "Page 42 is corrupted" }];
        const fakeFkRows = [{ table: "users", rowid: 1, parent: "roles", fkid: 0 }];

        // 1st dispatch: must send alert
        notifyIntegrityCorrupted(fakeIntRows, fakeFkRows, "/data/test.sqlite");
        assert.equal(getPrimaryAlerts().length, 1);

        const item = getPrimaryAlerts()[0];
        assert.equal(item.target, "ALERT");
        assert.equal(item.options.eventCode, "sqlite.integrity.corrupted");
        assert.match(item.payload.embeds[0].footer.text, /sqlite\.integrity\.corrupted/);
        assert.match(item.payload.embeds[0].title, /ความเสียหายในไฟล์ฐานข้อมูล/);

        // 2nd immediate dispatch: should be suppressed by throttle
        notifyIntegrityCorrupted(fakeIntRows, fakeFkRows, "/data/test.sqlite");
        assert.equal(getPrimaryAlerts().length, 1, "Immediate subsequent alert must be throttled");

        // After throttle reset: dispatch succeeds again
        resetAlertThrottle();
        notifyIntegrityCorrupted(fakeIntRows, fakeFkRows, "/data/test.sqlite");
        assert.equal(getPrimaryAlerts().length, 2, "Alert must fire after throttle cooldown");
    });

    // ─── 3. TELEMETRY WRITE-BEHIND BUFFER DROPPED ALERT ──────────────────────

    test("notifyBufferDropped dispatches WARNING alert and respects throttle", async () => {
        // 1st buffer drop
        notifyBufferDropped("VoiceEventRepository", 500, 2000, 500);
        assert.equal(getPrimaryAlerts().length, 1);

        const item = getPrimaryAlerts()[0];
        assert.equal(item.target, "ALERT");
        assert.equal(item.options.eventCode, "sqlite.telemetry.buffer_dropped");
        assert.match(item.payload.embeds[0].footer.text, /sqlite\.telemetry\.buffer_dropped/);
        assert.match(item.payload.embeds[0].title, /คิวพักข้อมูล Telemetry ล้น/);

        const repoField = item.payload.embeds[0].fields.find(f => f.name === "Repository");
        assert.ok(repoField);
        assert.equal(repoField.value, "VoiceEventRepository");

        // 2nd immediate drop: throttled
        notifyBufferDropped("VoiceEventRepository", 500, 2000, 1000);
        assert.equal(getPrimaryAlerts().length, 1, "Subsequent buffer drop alert within cooldown must be throttled");

        // Different repository has its own throttle key
        notifyBufferDropped("CommandEventRepository", 500, 2000, 500);
        assert.equal(getPrimaryAlerts().length, 2, "Different repository should trigger its own first alert");
    });

    test("VoiceEventRepository queue overflow triggers real buffer drop webhook alert", () => {
        const { VoiceEventRepository } = require("../../database/sqlite/repositories/history/VoiceEventRepository");
        const repo = new VoiceEventRepository();
        repo.stopFlusher(); // prevent background flushing during test

        // Fill buffer to capacity
        for (let i = 0; i < 2000; i++) {
            repo.buffer.push({ occurredAt: Date.now(), eventType: "test" });
        }
        assert.equal(repo.buffer.length, 2000);
        assert.equal(getPrimaryAlerts().length, 0);

        // Record 1 more event to trigger overflow drop
        repo.record({ eventType: "overflow_trigger" });

        // Buffer dropped 500, then remaining 1501 items exceeded flushSizeThreshold (100) and were flushed
        assert.equal(repo.droppedEventsCount, 500);
        assert.equal(repo.isDegraded, true);

        // Webhook alert must have been queued
        const dropAlerts = getPrimaryAlerts().filter(s => s.options.eventCode === "sqlite.telemetry.buffer_dropped");
        assert.equal(dropAlerts.length, 1);
        assert.match(dropAlerts[0].payload.embeds[0].title, /VoiceEventRepository/);
    });
});

