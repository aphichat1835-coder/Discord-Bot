"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const lifecycle = require("../voiceWorker/lifecycle");

const {
    assertRequestedTokenOwner,
    ensureSessionFlights,
    performClientLogin,
    processSessionHealthCheck
} = lifecycle._test;

test("voice token ownership fails closed before creating a session", () => {
    assert.throws(
        () => assertRequestedTokenOwner("token", "111111111111111111", () => "222222222222222222"),
        error => error?.code === "TOKEN_OWNER_MISMATCH"
    );
    assert.doesNotThrow(
        () => assertRequestedTokenOwner("token", "111111111111111111", () => "111111111111111111")
    );
});

test("ensureVoiceSession singleflights the same token and guild", async () => {
    ensureSessionFlights.clear();
    let internalCalls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const deps = {
        isShuttingDown: () => false,
        validateToken: () => true,
        assertRequestedTokenOwner: () => true,
        normalizeVoiceTarget: input => ({ guildId: input.guildId, channelId: input.channelId }),
        hashToken: () => "token-hash",
        ensureVoiceSessionInternal: async () => {
            internalCalls++;
            await gate;
            return { ok: true, sessionId: "session-1" };
        }
    };
    const input = {
        token: "token",
        ownerId: "111111111111111111",
        guildId: "222222222222222222",
        channelId: "333333333333333333"
    };
    const first = lifecycle.ensureVoiceSession(input, deps);
    const second = lifecycle.ensureVoiceSession(input, deps);
    await Promise.resolve();
    assert.equal(internalCalls, 1);
    release();
    assert.deepEqual(await first, { ok: true, sessionId: "session-1" });
    assert.deepEqual(await second, { ok: true, sessionId: "session-1" });
    assert.equal(ensureSessionFlights.size, 0);
});

test("ensureVoiceSession blocks a different owner while creation is in flight", async () => {
    ensureSessionFlights.clear();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const deps = {
        isShuttingDown: () => false,
        validateToken: () => true,
        assertRequestedTokenOwner: () => true,
        normalizeVoiceTarget: input => ({ guildId: input.guildId, channelId: input.channelId }),
        hashToken: () => "shared-token-hash",
        ensureVoiceSessionInternal: async () => {
            await gate;
            return { ok: true };
        }
    };
    const first = lifecycle.ensureVoiceSession({
        token: "token", ownerId: "111111111111111111",
        guildId: "222222222222222222", channelId: "333333333333333333"
    }, deps);
    await assert.rejects(
        lifecycle.ensureVoiceSession({
            token: "token", ownerId: "444444444444444444",
            guildId: "222222222222222222", channelId: "333333333333333333"
        }, deps),
        error => error?.code === "TOKEN_IN_USE_BY_ANOTHER_USER"
    );
    release();
    await first;
});

test("post-login owner mismatch destroys the client and never pools it", async () => {
    const session = { ownerId: "111111111111111111" };
    const disposed = [];
    const pooled = [];
    const failures = [];
    const client = {
        user: null,
        async login() {
            this.user = { id: "222222222222222222" };
        }
    };
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(
            performClientLogin(client, "session-1", session, "hash", "token", {
                getSession: () => session,
                waitForTokenLoginCooldown: async () => {},
                loginQueue: { add: operation => operation() },
                withTimeoutReject: promise => promise,
                disposeSelfClient: (_client, reason) => disposed.push(reason),
                setSessionClientInPool: (...args) => pooled.push(args),
                markSessionFailed: async (...args) => failures.push(args),
                isShuttingDown: () => false,
                markTokenInvalid: async () => {}
            }),
            error => error?.code === "TOKEN_OWNER_MISMATCH"
        );
    } finally {
        console.error = originalError;
    }
    assert.equal(pooled.length, 0);
    assert.equal(failures.length, 1);
    assert.ok(disposed.includes("token-owner-mismatch"));
});

test("a login completing after timeout is disposed and cannot enter the pool", async () => {
    const session = { ownerId: "111111111111111111" };
    let finishLogin;
    const loginGate = new Promise(resolve => { finishLogin = resolve; });
    const disposed = [];
    const pooled = [];
    const client = {
        user: null,
        async login() {
            await loginGate;
            this.user = { id: "111111111111111111" };
        }
    };
    const timeout = Object.assign(new Error("LOGIN_TIMEOUT"), { code: "LOGIN_TIMEOUT" });
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(
            performClientLogin(client, "session-2", session, "hash", "token", {
                getSession: () => session,
                waitForTokenLoginCooldown: async () => {},
                loginQueue: { add: operation => operation() },
                withTimeoutReject: async () => { throw timeout; },
                disposeSelfClient: (_client, reason) => disposed.push(reason),
                setSessionClientInPool: (...args) => pooled.push(args),
                isShuttingDown: () => false,
                markTokenInvalid: async () => {}
            }),
            /LOGIN_TIMEOUT/
        );
        finishLogin();
        await loginGate;
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        console.error = originalError;
    }
    assert.equal(pooled.length, 0);
    assert.ok(disposed.includes("late-login-completion"));
});

test("health check schedules recovery when the pooled client disappeared", () => {
    const session = {
        active: true,
        status: "running",
        reconnecting: false,
        connection: null,
        client: null
    };
    let scheduled = null;
    const result = processSessionHealthCheck("session-3", session, 100_000, {
        isSessionRunnable: () => true,
        getSessionTokenHash: () => "token-hash",
        getSessionClientFromPool: () => null,
        recoveryTimestamps: new Map(),
        recoveryCooldownMs: 60_000,
        isSessionLocked: () => false,
        scheduleHealthRecovery: (...args) => {
            scheduled = args;
            return true;
        },
        readyStatus: "ready"
    });
    assert.equal(result, true);
    assert.equal(scheduled[0], "session-3");
    assert.equal(scheduled[2], "token-hash");
});
