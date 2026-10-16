"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sm = require("../voiceWorker/sessionManager");

test("Voice SessionManager Operations Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("1. Session lock lifecycle", () => {
        const sessionId = "lock_test_session_1";
        assert.equal(sm.isSessionLocked(sessionId), false);

        // Acquire lock
        const acquired = sm.acquireSessionLock(sessionId);
        assert.equal(acquired, true);
        assert.equal(sm.isSessionLocked(sessionId), true);

        // Second acquire fails
        const secondAcquire = sm.acquireSessionLock(sessionId);
        assert.equal(secondAcquire, false);

        // Release lock
        sm.releaseSessionLock(sessionId);
        assert.equal(sm.isSessionLocked(sessionId), false);
    });

    await t.test("2. Reconnect attempt tracking and limits", () => {
        const sessionId = "reconnect_test_session_2";
        sm.resetReconnectInfo(sessionId);

        const initial = sm.getReconnectInfo(sessionId);
        assert.equal(initial.attempts, 0);
        assert.equal(initial.lastAttempt, 0);

        // Record first attempt
        sm.recordReconnectAttempt(sessionId);
        const afterFirst = sm.getReconnectInfo(sessionId);
        assert.equal(afterFirst.attempts, 1);
        assert.ok(afterFirst.lastAttempt > 0);

        // Immediately after attempt, cannot attempt again (cooldown)
        assert.equal(sm.canAttemptReconnect(sessionId), false);

        // Reset
        sm.resetReconnectInfo(sessionId);
        const afterReset = sm.getReconnectInfo(sessionId);
        assert.equal(afterReset.attempts, 0);
        assert.equal(afterReset.lastAttempt, 0);
    });

    await t.test("3. Token encryption, decryption and migration helpers", () => {
        const plaintext = "sample_discord_token_xyz_123456789";
        const encrypted = sm.encryptToken(plaintext);
        assert.ok(typeof encrypted === "string" && encrypted.length > 0);
        assert.notEqual(encrypted, plaintext);

        const decrypted = sm.decryptToken(encrypted);
        assert.equal(decrypted, plaintext);

        // Decrypt with metadata helper
        const meta = sm._test.decryptTokenWithMetadata(encrypted);
        assert.equal(meta.plaintext, plaintext);
        assert.equal(meta.needsMigration, false);

        // Plaintext detection
        assert.equal(sm._test.isPlausiblePlaintext(plaintext), true);
        assert.equal(sm._test.isPlausiblePlaintext("\x00\x01\x02"), false);
        assert.equal(sm._test.isPlausiblePlaintext(""), false);

        // Migrate token
        const migrated = sm._test.migrateEncryptedToken(plaintext);
        assert.ok(migrated);
    });

    await t.test("4. Settings caching classification", () => {
        const shouldCache = sm._test.shouldCacheSettingKey;
        assert.equal(shouldCache("maxSessions"), true);
        assert.equal(shouldCache("autoDeafEnabled"), true);
        assert.equal(shouldCache("internal_event_foo"), false);
    });

    await t.test("5. System metrics and diagnostics", () => {
        const diag = sm.getSessionDiagnostics();
        assert.ok(diag);
        assert.equal(typeof diag.total, "number");
        assert.equal(typeof diag.runnable, "number");
        assert.ok(diag.byState);
        assert.equal(typeof diag.lockedSessions, "number");
        assert.equal(typeof diag.reconnectTracking, "number");

        const allSessions = sm.getAllSessions();
        assert.ok(allSessions instanceof Map);

        const shortId = sm.getSessionShortId("vc_123456789012345678_88888888");
        assert.ok(typeof shortId === "string");
        assert.ok(shortId.length <= 16);
    });

    await t.test("6. Pending delete queue helpers", () => {
        const entries = [
            ["session_1", "generation_abc"],
            ["session_2", null]
        ];
        const queryFilter = sm._test.buildPendingSessionDeleteFilter(entries);
        assert.ok(queryFilter);
        assert.ok(Array.isArray(queryFilter.$or));
        assert.equal(queryFilter.$or.length, 2);

        sm._test.queuePendingSessionDelete({ serverId: "guild_999", tokenHash: "hash_999" });
        sm._test.flushPendingSessionDeletes();
    });

    await t.test("7. Panel state and Guild approval accessors", async () => {
        // In-memory queries when not connected should return empty arrays / null safely
        const approved = await sm.getApprovedGuilds().catch(() => []);
        assert.ok(Array.isArray(approved));

        const pending = await sm.getPendingGuilds().catch(() => []);
        assert.ok(Array.isArray(pending));

        const isAppr = await sm.isGuildApproved("any_guild");
        assert.equal(isAppr, true);

        const panelState = await sm.getPanelState("panel_123").catch(() => null);
        assert.equal(panelState, null);

        const allPanels = await sm.getPanelStates().catch(() => []);
        assert.ok(Array.isArray(allPanels));
    });
});
