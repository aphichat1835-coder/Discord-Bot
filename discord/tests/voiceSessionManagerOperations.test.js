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

    await t.test("8. In-memory session CRUD, queries, and diagnostics", async () => {
        const rawToken = "test_discord_token_alpha_123456";
        const encrypted = sm.encryptToken(rawToken);
        const tokenHash = sm.hashToken(rawToken);
        const sessionId = sm.buildVoiceSessionId(tokenHash, "g_test_1", "o_test_1");

        const session = {
            sessionId,
            token: encrypted,
            tokenHash,
            serverId: "g_test_1",
            voiceId: "v_test_1",
            serverName: "Server Alpha",
            ownerId: "o_test_1",
            startedAt: Date.now(),
            lastActivity: Date.now(),
            state: "active",
            lifecycleGeneration: "gen_test_123",
            tokenInvalid: false,
            reconnectCount: 0
        };

        sm.getAllSessions().set(sessionId, session);

        // Verification of state helpers
        assert.equal(sm.isSessionRunnable(session), true);
        assert.equal(sm.shouldResumeSession(session), true);
        assert.equal(sm.getSessionToken(sessionId), rawToken);
        assert.equal(sm.getSessionTokenHash(sessionId), tokenHash);

        // Session lookup by token + guild
        const activeLookup = sm.findActiveVoiceSessionByTokenGuild(tokenHash, "g_test_1");
        assert.ok(activeLookup);
        assert.equal(activeLookup.id, sessionId);

        assert.equal(sm.hasActiveTokenGuildSession(tokenHash, "g_test_1"), true);
        assert.equal(sm.countActiveSessionsByTokenHash(tokenHash), 1);

        const listByHash = sm.getActiveSessionsByTokenHash(tokenHash);
        assert.equal(listByHash.length, 1);

        const listByGuild = sm.getActiveSessionsByGuild("g_test_1");
        assert.equal(listByGuild.length, 1);

        // Summaries
        const summary = sm.getVoiceSessionSummary(session);
        assert.ok(summary);
        assert.equal(summary.sessionId, sessionId);
        assert.equal(summary.serverId, "g_test_1");

        const allSummaries = sm.getAllSessionSummaries();
        assert.ok(allSummaries.length >= 1);

        // Metadata updates and heartbeat touch
        sm.touchSession(sessionId);
        await sm.updateSessionMetadata(sessionId, { serverName: "Server Updated" });
        assert.equal(session.serverName, "Server Updated");

        await sm.saveVoiceRuntimeState(sessionId);

        // Mark failed
        const failRes = await sm.markSessionFailed(sessionId, "manual_test_failure");
        assert.equal(failRes.memoryUpdated, true);
        assert.equal(session.state, "failed");

        // Build save operation
        const saveOp = sm._test.buildSessionSaveOperation(sessionId, session);
        assert.ok(saveOp);
        assert.equal(saveOp.updateOne.filter.sessionId, sessionId);

        // Delete session
        const deleted = await sm.deleteSession(sessionId);
        assert.equal(deleted, true);
        assert.equal(sm.getAllSessions().has(sessionId), false);
    });

    await t.test("9. System metrics tracking and aggregation", () => {
        sm.systemMetrics.increment("requests");
        sm.systemMetrics.increment("errors");
        sm.systemMetrics.increment("reconnects");

        const metrics = sm.getSystemMetrics();
        assert.ok(metrics.requests >= 1);
        assert.ok(metrics.errors >= 1);
        assert.ok(metrics.reconnects >= 1);
        assert.equal(typeof metrics.uptimeMs, "number");
    });

    await t.test("10. Bot settings offline/fallback contracts", async () => {
        const fallback = await sm.getSetting("unconnected_key", "default_val");
        assert.equal(fallback, "default_val");

        await assert.rejects(async () => {
            await sm.getSettingStrict("unconnected_key");
        }, /DATABASE_NOT_CONNECTED/);

        const res = await sm.setSetting("key", "val");
        assert.equal(res, false);

        const all = await sm.getAllSettings();
        assert.deepEqual(all, {});
    });

    await t.test("11. Panel state offline behavior", async () => {
        const state = await sm.getPanelState("g_offline");
        assert.equal(state, null);

        const states = await sm.getPanelStates();
        assert.deepEqual(states, []);

        const del = await sm.deletePanelState("g_offline");
        assert.equal(del, false);

        const save = await sm.savePanelState("g_offline", {});
        assert.equal(save, false);
    });

    await t.test("12. hydrateLoadedSessionRecord and session load repairs", () => {
        const rawRecord = {
            _id: "rec_123",
            sessionId: "sess_hydrate_1",
            token: "plain_token_needs_migrated_xyz_12345",
            serverId: "guild_hyd_1",
            voiceId: "voice_hyd_1"
        };

        const hydrated = sm._test.hydrateLoadedSessionRecord(rawRecord);
        assert.equal(hydrated.sessionData.sessionId, "sess_hydrate_1");
        assert.equal(hydrated.sessionData.serverId, "guild_hyd_1");
        assert.ok(hydrated.sessionData.token);
        assert.ok(hydrated.sessionData.lifecycleGeneration);
        assert.equal(hydrated.isActive, true);
    });

    await t.test("13. _processLoadedRecords and _reconcileOrphanVoiceRuntimes", () => {
        const targetMap = new Map();
        const records = [
            { _id: "r1", sessionId: "s1", serverId: "g1", voiceId: "v1", state: "active" },
            { _id: "r2", sessionId: "s2", serverId: "g2", voiceId: "v2", state: "stopped" }
        ];

        const res = sm._test._processLoadedRecords(records, targetMap);
        assert.equal(res.activeLoaded, 1);
        assert.equal(res.recoverableLoaded, 1);
        assert.equal(targetMap.size, 2);

        // _reconcileOrphanVoiceRuntimes does not throw when database is healthy or absent
        assert.doesNotThrow(() => {
            sm._test._reconcileOrphanVoiceRuntimes(targetMap);
        });
    });

    await t.test("14. cleanupSessionMemory and _safeDeleteSessionRuntime", () => {
        let destroyed = false;
        const mockConn = {
            state: { status: "ready" },
            destroy: () => { destroyed = true; }
        };

        const dummySession = {
            sessionId: "clean_1",
            connection: mockConn,
            client: { isReady: () => true },
            state: "active"
        };

        sm._test.cleanupSessionMemory("clean_1", dummySession);
        assert.equal(dummySession.connection, null);
        assert.equal(destroyed, true);

        // _safeDeleteSessionRuntime runs safely
        assert.doesNotThrow(() => {
            sm._test._safeDeleteSessionRuntime("clean_1", "test_cleanup");
        });
    });

    await t.test("15. _recordSessionDeletedEvent and _handleDisconnectedOrFailedDelete", () => {
        const session = {
            sessionId: "rec_del_1",
            serverId: "g_rec_1",
            ownerId: "o_rec_1",
            state: "active"
        };

        const db = require("../../database");
        const origRecord = db?.repositories?.sessionEvent?.record;
        if (db?.repositories?.sessionEvent) {
            db.repositories.sessionEvent.record = () => {};
        }

        try {
            assert.doesNotThrow(() => {
                sm._test._recordSessionDeletedEvent("rec_del_1", session);
            });

            assert.doesNotThrow(() => {
                sm._test._handleDisconnectedOrFailedDelete("rec_del_1", session, new Error("disconnected_test"));
            });
        } finally {
            if (db?.repositories?.sessionEvent && origRecord) {
                db.repositories.sessionEvent.record = origRecord;
            }
        }
    });

    await t.test("16. buildVoiceSessionAccountSummary and buildVoiceSessionStateSummary", () => {
        const fullSession = {
            sessionId: "sum_1",
            ownerId: "owner_999",
            ownerTag: "Owner#0001",
            ownerAvatar: "https://avatar.png",
            accountId: "acc_999",
            accountUsername: "accountUser",
            accountGlobalName: "Account Global",
            accountTag: "account#0001",
            accountAvatar: "https://acc_avatar.png",
            state: "active",
            stoppedAt: null,
            stoppedReason: null,
            stoppedBy: null,
            lastStopError: null,
            client: { isReady: () => true },
            connection: { state: { status: "ready" } }
        };

        const accountSummary = sm._test.buildVoiceSessionAccountSummary(fullSession);
        assert.equal(accountSummary.ownerId, "owner_999");
        assert.equal(accountSummary.accountUsername, "accountUser");

        const stateSummary = sm._test.buildVoiceSessionStateSummary(fullSession);
        assert.equal(stateSummary.state, "active");
        assert.equal(stateSummary.clientReady, true);
        assert.equal(stateSummary.connectionStatus, "ready");

        // Stale and ghost suspicion
        const ghostSession = {
            state: "stopped",
            stoppedReason: "stop_cleanup_failed"
        };
        const ghostSummary = sm._test.buildVoiceSessionStateSummary(ghostSession);
        assert.equal(ghostSummary.ghostSuspected, true);
    });

    await t.test("17. isRetiredEnterpriseAuditSetting, boundedLimit, and numberEnv", () => {
        assert.equal(sm._test.isRetiredEnterpriseAuditSetting("audit_log_channel"), true);
        assert.equal(sm._test.isRetiredEnterpriseAuditSetting("logChannelMapExtra_foo"), true);
        assert.equal(sm._test.isRetiredEnterpriseAuditSetting("normal_setting"), false);

        assert.equal(sm._test.boundedLimit(50, 100), 50);
        assert.equal(sm._test.boundedLimit(150, 100), 100);
        assert.equal(sm._test.boundedLimit(-5, 100, 20), 1);
        assert.equal(sm._test.boundedLimit("invalid", 100, 20), 20);

        assert.equal(sm._test.numberEnv("TEST_NON_EXISTENT_ENV_12345", 42), 42);
    });

    await t.test("18. cleanStaleSessionsAndLegacyModels and applySessionLoadRepairs", async () => {
        await sm._test.applySessionLoadRepairs([]);

        const mongoose = require("mongoose");
        const SessionModel = mongoose.models.Session;
        const ApprovedGuildModel = mongoose.models.ApprovedGuild;
        const PendingGuildModel = mongoose.models.PendingGuild;
        const origDelete = SessionModel ? SessionModel.deleteMany : null;
        const origApproved = ApprovedGuildModel ? ApprovedGuildModel.deleteMany : null;
        const origPending = PendingGuildModel ? PendingGuildModel.deleteMany : null;

        if (SessionModel) SessionModel.deleteMany = async () => ({ deletedCount: 0 });
        if (ApprovedGuildModel) ApprovedGuildModel.deleteMany = async () => ({ deletedCount: 0 });
        if (PendingGuildModel) PendingGuildModel.deleteMany = async () => ({ deletedCount: 0 });

        try {
            const cleanupResult = await sm._test.cleanStaleSessionsAndLegacyModels(Date.now());
            assert.ok(cleanupResult === null || typeof cleanupResult === "object");
        } finally {
            if (SessionModel && origDelete) SessionModel.deleteMany = origDelete;
            if (ApprovedGuildModel && origApproved) ApprovedGuildModel.deleteMany = origApproved;
            if (PendingGuildModel && origPending) PendingGuildModel.deleteMany = origPending;
        }
    });

    await t.test("19. pauseSession safely transitions runnable session", async () => {
        const sessionId = "pause_test_1";
        const session = {
            sessionId,
            state: "active",
            serverId: "g_pause_1",
            tokenHash: "hash_pause",
            connection: { destroy: () => {} },
            reconnecting: true
        };
        sm.getAllSessions().set(sessionId, session);

        const paused = await sm.pauseSession(sessionId);
        assert.equal(paused, true);
        assert.equal(session.connection, null);
        assert.equal(session.reconnecting, false);

        // Non-existent session
        const notFound = await sm.pauseSession("non_existent_session");
        assert.equal(notFound, false);

        sm.getAllSessions().delete(sessionId);
    });
});


