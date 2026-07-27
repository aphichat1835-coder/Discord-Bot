"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const lifecycle = require("../voiceWorker/lifecycle");

const {
    ensureSessionFlights,
    performClientLogin,
    processSessionHealthCheck
} = lifecycle._test;

test("same token and guild uses latest-request-wins while skipping stale queued work", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    ensureSessionFlights.clear();
    const calls = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const deps = {
        isShuttingDown: () => false,
        validateToken: () => true,
        normalizeVoiceTarget: input => ({ guildId: input.guildId, channelId: input.channelId }),
        hashToken: () => "shared-token-hash",
        ensureVoiceSessionInternal: async input => {
            calls.push(input.channelId);
            if (input.channelId === "333333333333333333") await firstGate;
            return { ok: true, sessionId: `session-${input.channelId}`, channelId: input.channelId };
        }
    };

    const first = lifecycle.ensureVoiceSession({
        token: "token", ownerId: "111111111111111111",
        guildId: "222222222222222222", channelId: "333333333333333333"
    }, deps);
    await new Promise(resolve => setImmediate(resolve));

    const second = lifecycle.ensureVoiceSession({
        token: "token", ownerId: "444444444444444444",
        guildId: "222222222222222222", channelId: "555555555555555555"
    }, deps);
    const latest = lifecycle.ensureVoiceSession({
        token: "token", ownerId: "666666666666666666",
        guildId: "222222222222222222", channelId: "777777777777777777"
    }, deps);

    releaseFirst();
    assert.equal((await first).action, "superseded_by_newer_request");
    assert.equal((await second).action, "superseded_by_newer_request");
    assert.deepEqual(await latest, {
        ok: true,
        sessionId: "session-777777777777777777",
        channelId: "777777777777777777"
    });
    assert.deepEqual(calls, ["333333333333333333", "777777777777777777"]);
    assert.equal(ensureSessionFlights.size, 0);
});

test("different tokens can start concurrently in the same guild", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    ensureSessionFlights.clear();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const deps = {
        isShuttingDown: () => false,
        validateToken: () => true,
        normalizeVoiceTarget: input => ({ guildId: input.guildId, channelId: input.channelId }),
        hashToken: token => `hash-${token}`,
        ensureVoiceSessionInternal: async input => {
            calls++;
            await gate;
            return { ok: true, sessionId: input.token };
        }
    };
    const one = lifecycle.ensureVoiceSession({ token: "one", guildId: "222222222222222222", channelId: "333333333333333333" }, deps);
    const two = lifecycle.ensureVoiceSession({ token: "two", guildId: "222222222222222222", channelId: "444444444444444444" }, deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    release();
    assert.equal((await one).sessionId, "one");
    assert.equal((await two).sessionId, "two");
});

test("post-login account may differ from the requester and is still pooled", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = { ownerId: "111111111111111111" };
    const disposed = [];
    const pooled = [];
    const client = {
        user: null,
        async login() {
            this.user = { id: "222222222222222222" };
        }
    };
    await performClientLogin(client, "session-1", session, "hash", "token", {
        getSession: () => session,
        waitForTokenLoginCooldown: async () => {},
        loginQueue: { add: operation => operation() },
        withTimeoutReject: promise => promise,
        disposeSelfClient: (_client, reason) => disposed.push(reason),
        setSessionClientInPool: (...args) => pooled.push(args),
        isShuttingDown: () => false,
        markTokenInvalid: async () => {}
    });
    assert.equal(pooled.length, 1);
    assert.deepEqual(disposed, []);
    assert.equal(session.loginGeneration, null);
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
