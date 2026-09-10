"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.json");
const { getVoiceStatusLabel } = require("../sessions/voiceLabels");
const { isStatusReconnect, getStatusReconnectSessionId, PREFIXES } = require("../commands/customIds");
const { buildVoiceStatusControls } = require("../commands/panelViews");
const voiceWorker = require("../voiceWorker");
const { handleStatusReconnectButton } = require("../commands/panelInteractions")._test;
const { serializeVoiceSession } = require("../index/sessionSerializer");

test("voiceLabels: getVoiceStatusLabel formats ready, reconnecting, hibernate, and clean offline", () => {
    // Ready
    const readySession = {
        connection: { state: { status: "ready" } },
        reconnecting: false
    };
    assert.equal(getVoiceStatusLabel(readySession, config), `${config.emojis.status_online} เชื่อมต่ออยู่`);

    // Hibernate with timestamp
    const futureTime = Date.now() + 300000;
    const hibernateSession = {
        recoveryState: {
            phase: "hibernate",
            hibernateUntil: futureTime
        }
    };
    const expectedUnix = Math.floor(futureTime / 1000);
    assert.equal(
        getVoiceStatusLabel(hibernateSession, config),
        `💤 พักรอกู้คืนอัตโนมัติ (รอบใหม่ <t:${expectedUnix}:R>)`
    );

    // Hibernate without timestamp
    const hibernateNoTimeSession = {
        recoveryState: {
            phase: "hibernate",
            hibernateUntil: null
        }
    };
    assert.equal(getVoiceStatusLabel(hibernateNoTimeSession, config), "💤 พักรอกู้คืนอัตโนมัติ");

    // Reconnecting / recovering
    const recoveringSession = {
        reconnecting: true,
        recoveryState: {
            phase: "recovering",
            attempts: 3
        }
    };
    assert.equal(getVoiceStatusLabel(recoveringSession, config), "🔄 กำลังกู้คืน (รอบที่ 3)...");

    // Connecting
    const connectingSession = {
        connection: { state: { status: "connecting" } }
    };
    assert.equal(getVoiceStatusLabel(connectingSession, config), `${config.emojis.signal} กำลังเชื่อมต่อ`);

    // Offline / disconnected: must be clean without reason string (OI / user request)
    const offlineSession = {
        connection: { state: { status: "disconnected" } }
    };
    assert.equal(getVoiceStatusLabel(offlineSession, config), `${config.emojis.status_offline} ไม่ได้เชื่อมต่อ`);

    const destroyedSession = {
        connection: { state: { status: "destroyed" } }
    };
    assert.equal(getVoiceStatusLabel(destroyedSession, config), `${config.emojis.status_offline} ไม่ได้เชื่อมต่อ`);

    const nullSession = null;
    assert.equal(getVoiceStatusLabel(nullSession, config), `${config.emojis.status_offline} ไม่ได้เชื่อมต่อ`);
});

test("customIds: isStatusReconnect and getStatusReconnectSessionId work correctly", () => {
    const customId = `${PREFIXES.STATUS_RECONNECT}sess-abc-123`;
    assert.equal(isStatusReconnect(customId), true);
    assert.equal(getStatusReconnectSessionId(customId), "sess-abc-123");

    assert.equal(isStatusReconnect("status_stop_123"), false);
    assert.equal(isStatusReconnect("btn_start"), false);
});

test("panelViews: buildVoiceStatusControls conditionally includes Reconnect button", () => {
    const readySession = {
        sessionId: "s-1",
        connection: { state: { status: "ready" } },
        reconnecting: false
    };
    const rowReady = buildVoiceStatusControls(readySession, 0);
    const readyComponents = rowReady.components || [];
    assert.equal(
        readyComponents.some(c => c.customId?.startsWith(PREFIXES.STATUS_RECONNECT)),
        false,
        "Ready session should not have reconnect button"
    );

    const offlineSession = {
        sessionId: "s-2",
        connection: { state: { status: "disconnected" } },
        reconnecting: false
    };
    const rowOffline = buildVoiceStatusControls(offlineSession, 0);
    const offlineComponents = rowOffline.components || [];
    assert.equal(
        offlineComponents.some(c => c.customId === `${PREFIXES.STATUS_RECONNECT}s-2`),
        true,
        "Offline session must include reconnect button"
    );

    const recoveringSession = {
        sessionId: "s-3",
        connection: { state: { status: "ready" } },
        reconnecting: true
    };
    const rowRecovering = buildVoiceStatusControls(recoveringSession, 0);
    const recoveringComponents = rowRecovering.components || [];
    assert.equal(
        recoveringComponents.some(c => c.customId === `${PREFIXES.STATUS_RECONNECT}s-3`),
        true,
        "Reconnecting session must include reconnect button"
    );
});

test("voiceWorker: forceReconnectSession validates session and tokenHash and executes recovery", async () => {
    // Missing session
    const missingRes = await voiceWorker.forceReconnectSession("non-existent-session", {
        getSession: () => null
    });
    assert.equal(missingRes.ok, false);
    assert.ok(missingRes.error.includes("ไม่พบ Session"));

    // Missing token
    const noTokenSession = {
        sessionId: "sess-no-token",
        state: "active"
    };
    const noTokenRes = await voiceWorker.forceReconnectSession("sess-no-token", {
        getSession: () => noTokenSession,
        getSessionTokenHash: () => null
    });
    assert.equal(noTokenRes.ok, false);
    assert.ok(noTokenRes.error.includes("ไม่พบ Token"));

    // Successful reconnect execution
    let connectionDestroyed = false;
    let recoveryCalled = false;
    const sessionToRecover = {
        sessionId: "sess-ok",
        state: "active",
        failedReason: "some_old_reason",
        tokenInvalid: true,
        connection: {
            destroy() { connectionDestroyed = true; }
        },
        client: {
            isReady: () => true
        },
        recoveryState: {
            phase: "hibernate",
            attempts: 5,
            hibernateUntil: Date.now() + 60000
        }
    };

    const okRes = await voiceWorker.forceReconnectSession("sess-ok", {
        getSession: () => sessionToRecover,
        getSessionTokenHash: () => "hash-ok",
        recoverSessionConnection: async (id, hash) => {
            recoveryCalled = true;
            assert.equal(id, "sess-ok");
            assert.equal(hash, "hash-ok");
            sessionToRecover.connection = {
                state: { status: "ready" }
            };
        },
        readyStatus: "ready"
    });

    assert.equal(okRes.ok, true);
    assert.equal(okRes.ready, true);
    assert.equal(connectionDestroyed, true);
    assert.equal(recoveryCalled, true);
    assert.equal(sessionToRecover.state, "active");
    assert.equal(sessionToRecover.failedReason, undefined);
    assert.equal(sessionToRecover.tokenInvalid, undefined);
    assert.equal(sessionToRecover.recoveryState.phase, "recovering");
    assert.equal(sessionToRecover.recoveryState.attempts, 0);
    assert.equal(sessionToRecover.recoveryState.hibernateUntil, null);
});

test("panelInteractions: handleStatusReconnectButton permission check and response", async () => {
    const customId = `${PREFIXES.STATUS_RECONNECT}sess-target`;

    // Unauthorized attempt
    let updateDeferred = false;
    let editReplyArgs = null;
    const unauthorizedInteraction = {
        user: { id: "stranger-123" },
        guild: { id: "guild-1" },
        deferUpdate: async () => { updateDeferred = true; },
        editReply: async (args) => { editReplyArgs = args; }
    };

    const targetSession = {
        sessionId: "sess-target",
        ownerId: "owner-999",
        serverId: "guild-1",
        state: "active"
    };

    // Run with mock sessionManager
    const sessionManager = require("../sessionManager");
    const origGetSession = sessionManager.getSession;
    sessionManager.getSession = (id) => id === "sess-target" ? targetSession : null;

    try {
        await handleStatusReconnectButton(
            unauthorizedInteraction,
            customId,
            null, // shadowMasterId
            {
                getGlobalVoiceSessions: () => [targetSession],
                updatePanel: async () => {}
            }
        );

        assert.equal(updateDeferred, true);
        assert.ok(editReplyArgs);
        const desc = editReplyArgs.embeds[0].data?.description || editReplyArgs.embeds[0].description;
        assert.ok(desc.includes("ไม่มีสิทธิ์"));
    } finally {
        sessionManager.getSession = origGetSession;
    }
});

test("sessionSerializer: serializeVoiceSession includes recoveryPhase and hibernateUntil", () => {
    const session = {
        sessionId: "sess-serial-test",
        serverId: "guild-1",
        serverName: "Test Guild",
        voiceId: "voice-1",
        voiceName: "Lobby",
        ownerId: "owner-1",
        state: "active",
        reconnectCount: 2,
        reconnecting: true,
        recoveryState: {
            phase: "hibernate",
            hibernateUntil: 1700000000000
        }
    };

    const serialized = serializeVoiceSession(session);
    assert.equal(serialized.reconnecting, true);
    assert.equal(serialized.recoveryPhase, "hibernate");
    assert.equal(serialized.hibernateUntil, 1700000000000);
});

test("dashboard: handleReconnectSession handles auth, validation, not found, failure, and success", async () => {
    const { handleReconnectSession } = require("../index/server")._test;

    function createResponseRecorder() {
        return {
            statusCode: 200,
            payload: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.payload = body;
                return this;
            }
        };
    }

    // 1. Auth failure
    const authRes = createResponseRecorder();
    let authChecked = false;
    await handleReconnectSession({
        req: { body: { sessionId: "s1" } },
        res: authRes,
        checkAuth: () => { authChecked = true; return false; },
        sessionManager: {},
        voiceWorker: {}
    });
    assert.equal(authChecked, true);
    assert.equal(authRes.payload, null);

    // 2. Missing sessionId
    const missingRes = createResponseRecorder();
    await handleReconnectSession({
        req: { body: {} },
        res: missingRes,
        checkAuth: () => true,
        sessionManager: {},
        voiceWorker: {}
    });
    assert.equal(missingRes.statusCode, 400);
    assert.equal(missingRes.payload.success, false);
    assert.ok(missingRes.payload.error.includes("ไม่ระบุ sessionId"));

    // 3. Session not found
    const notFoundRes = createResponseRecorder();
    await handleReconnectSession({
        req: { body: { sessionId: "missing-sess" } },
        res: notFoundRes,
        checkAuth: () => true,
        sessionManager: { getSession: () => null },
        voiceWorker: {}
    });
    assert.equal(notFoundRes.statusCode, 404);
    assert.equal(notFoundRes.payload.success, false);

    // 4. forceReconnectSession fails
    const failRes = createResponseRecorder();
    await handleReconnectSession({
        req: { body: { sessionId: "fail-sess" } },
        res: failRes,
        checkAuth: () => true,
        sessionManager: { getSession: () => ({ sessionId: "fail-sess" }) },
        voiceWorker: {
            forceReconnectSession: async () => ({ ok: false, error: "Connection timed out" })
        }
    });
    assert.equal(failRes.statusCode, 400);
    assert.equal(failRes.payload.success, false);
    assert.equal(failRes.payload.error, "Connection timed out");

    // 5. Successful reconnect
    const okRes = createResponseRecorder();
    await handleReconnectSession({
        req: { body: { sessionId: "ok-sess" } },
        res: okRes,
        checkAuth: () => true,
        sessionManager: { getSession: () => ({ sessionId: "ok-sess" }) },
        voiceWorker: {
            forceReconnectSession: async () => ({ ok: true, ready: true })
        }
    });
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.payload.success, true);
    assert.equal(okRes.payload.ready, true);
});
