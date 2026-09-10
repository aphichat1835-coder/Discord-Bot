"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const lifecycle = require("../voiceWorker/lifecycle");

function recoverySession() {
    return {
        sessionId: "session-recovery",
        serverId: "guild-1",
        voiceId: "voice-1",
        reconnecting: true,
        client: null,
        connection: null
    };
}

test("exhausted voice recovery tears down resources and always releases ownership", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = recoverySession();
    let connectionDestroyed = false;
    session.connection = { destroy() { connectionDestroyed = true; } };
    const calls = [];

    await lifecycle.recoverSessionConnection(session.sessionId, "token-hash", {
        getSession: () => session,
        isShuttingDown: () => false,
        isSessionRunnable: () => true,
        recordRecoveryAttempt: async () => ({ attempts: 3 }),
        maxReconnectAttempts: 3,
        stopNaturalTimer: id => calls.push(["natural", id]),
        stopAutoDeafTimer: id => calls.push(["autoDeaf", id]),
        clearReconnect: id => calls.push(["clear", id]),
        recoveryTimestamps: new Map([[session.sessionId, 1]]),
        markTerminal: async () => calls.push(["terminal"]),
        markSessionFailed: async () => calls.push(["failed"]),
        getSessionClientFromPool: () => ({ id: "pooled-client" }),
        cleanupSessionClientIfUnused: (...args) => calls.push(["cleanup", args[4]]),
        unlockSession: id => calls.push(["unlock", id])
    });

    assert.equal(connectionDestroyed, true);
    assert.equal(session.connection, null);
    assert.equal(session.reconnecting, false);
    assert.deepEqual(calls, [
        ["natural", session.sessionId],
        ["autoDeaf", session.sessionId],
        ["clear", session.sessionId],
        ["terminal"],
        ["failed"],
        ["cleanup", "health-recovery-exhausted"],
        ["unlock", session.sessionId]
    ]);
});

test("voice recovery with an unavailable token marks failure and never tries to reconnect", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = recoverySession();
    const calls = [];

    await lifecycle.recoverSessionConnection(session.sessionId, "token-hash", {
        getSession: () => session,
        isShuttingDown: () => false,
        isSessionRunnable: () => true,
        recordRecoveryAttempt: async () => ({ attempts: 1 }),
        maxReconnectAttempts: 3,
        randomInt: () => 0,
        delay: async () => {},
        getSessionClientFromPool: () => null,
        getSessionToken: () => null,
        markSessionFailed: async (...args) => calls.push(["failed", args[1]]),
        connectToVoice: async () => {
            throw new Error("connect must not run without a token");
        },
        unlockSession: () => calls.push(["unlock"])
    });

    assert.equal(session.reconnecting, false);
    assert.deepEqual(calls, [
        ["failed", "token_unavailable"],
        ["unlock"]
    ]);
});

test("successful voice recovery reconnects, marks ready, restarts timers, and releases ownership", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = recoverySession();
    session.client = { isReady: () => true };
    const connection = { joinConfig: { channelId: session.voiceId } };
    const calls = [];

    await lifecycle.recoverSessionConnection(session.sessionId, "token-hash", {
        getSession: () => session,
        isShuttingDown: () => false,
        isSessionRunnable: () => true,
        recordRecoveryAttempt: async () => ({ attempts: 1 }),
        maxReconnectAttempts: 3,
        randomInt: () => 0,
        delay: async () => {},
        connectToVoice: async () => connection,
        getSelfVoiceStateInfo: () => ({ channelId: session.voiceId, channelSource: "test" }),
        markReady: async (_id, payload) => calls.push(["ready", payload.actualChannelId]),
        startNaturalTimer: id => calls.push(["natural", id]),
        startAutoDeafTimer: id => calls.push(["autoDeaf", id]),
        unlockSession: id => calls.push(["unlock", id])
    });

    assert.equal(session.connection, connection);
    assert.equal(session.reconnecting, false);
    assert.deepEqual(calls, [
        ["ready", session.voiceId],
        ["natural", session.sessionId],
        ["autoDeaf", session.sessionId],
        ["unlock", session.sessionId]
    ]);
});

test("exhausted voice recovery triggers deleteSession to prevent ghost retention", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = recoverySession();
    const calls = [];

    await lifecycle.recoverSessionConnection(session.sessionId, "token-hash", {
        getSession: () => session,
        isShuttingDown: () => false,
        isSessionRunnable: () => true,
        recordRecoveryAttempt: async () => ({ attempts: 3 }),
        maxReconnectAttempts: 3,
        stopNaturalTimer: id => calls.push(["natural", id]),
        stopAutoDeafTimer: id => calls.push(["autoDeaf", id]),
        clearReconnect: id => calls.push(["clear", id]),
        recoveryTimestamps: new Map([[session.sessionId, 1]]),
        markTerminal: async () => calls.push(["terminal"]),
        markSessionFailed: async () => calls.push(["failed"]),
        getSessionClientFromPool: () => null,
        cleanupSessionClientIfUnused: () => calls.push(["cleanup"]),
        deleteSession: async id => {
            calls.push(["deleteSession", id]);
            return true;
        },
        cleanupSessionNotification: id => calls.push(["cleanupNotif", id]),
        unlockSession: id => calls.push(["unlock", id])
    });

    assert.deepEqual(calls, [
        ["natural", session.sessionId],
        ["autoDeaf", session.sessionId],
        ["clear", session.sessionId],
        ["terminal"],
        ["failed"],
        ["cleanup"],
        ["cleanupNotif", session.sessionId],
        ["deleteSession", session.sessionId],
        ["unlock", session.sessionId]
    ]);
});

test("stopSession on already-failed session force-deletes cleanly without STOP_FAILED error", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessionManager = require("../sessionManager");
    const testSessionId = "session-already-failed-test";
    const testSession = {
        sessionId: testSessionId,
        serverId: "guild-fail-1",
        voiceId: "voice-fail-1",
        state: "failed",
        stoppedReason: "max_reconnect_attempts",
        client: null,
        connection: null
    };

    sessionManager.getAllSessions().set(testSessionId, testSession);
    const stopped = await lifecycle.stopSession(testSessionId);

    assert.equal(stopped, true);
    assert.equal(sessionManager.getAllSessions().has(testSessionId), false);
});


