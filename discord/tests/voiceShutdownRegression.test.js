"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../voiceWorker/lifecycle");

const { assertVoiceStartupAllowed, performClientLogin } = _test;

test("voice client finishing login after shutdown starts is disposed and never pooled", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = { ownerId: "111111111111111111" };
    const disposed = [];
    const pooled = [];
    let shuttingDown = false;
    const client = {
        user: null,
        async login() {
            this.user = { id: "222222222222222222" };
            shuttingDown = true;
        }
    };
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(
            performClientLogin(client, "session-shutdown", session, "token-hash", "token", {
                getSession: () => session,
                waitForTokenLoginCooldown: async () => {},
                loginQueue: { add: operation => operation() },
                withTimeoutReject: promise => promise,
                disposeSelfClient: (_client, reason) => disposed.push(reason),
                setSessionClientInPool: (...args) => pooled.push(args),
                isShuttingDown: () => shuttingDown,
                markTokenInvalid: async () => {}
            }),
            /LOGIN_GENERATION_CANCELLED/
        );
    } finally {
        console.error = originalError;
    }

    assert.equal(pooled.length, 0);
    assert.ok(disposed.includes("cancelled-login-generation"));
    assert.equal(session.loginGeneration, null);
});

test("voice startup guard rejects shutdown at every protected stage", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const session = {};
    for (const stage of ["pre_login", "post_login", "post_jitter", "pre_connect", "post_connect", "pre_timers", "pre_ready"]) {
        assert.throws(
            () => assertVoiceStartupAllowed("session", session, stage, {
                isShuttingDown: () => true,
                getSession: () => session
            }),
            error => error?.code === "SYSTEM_SHUTTING_DOWN" && error?.stage === stage
        );
    }
});

test("voice startup guard rejects a session replaced during startup", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const original = {};
    assert.throws(
        () => assertVoiceStartupAllowed("session", original, "post_connect", {
            isShuttingDown: () => false,
            getSession: () => ({ replacement: true })
        }),
        error => error?.code === "SESSION_SUPERSEDED" && error?.stage === "post_connect"
    );
});

test("startSession protects every asynchronous startup boundary", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const source = String(require("../voiceWorker/lifecycle").startSession);
    for (const stage of ["pre_login", "post_login", "post_jitter", "pre_connect", "post_connect", "pre_timers", "pre_ready"]) {
        assert.equal(
            source.includes(`assertVoiceStartupAllowed(sessionId, session, "${stage}"`),
            true,
            `missing startup boundary guard for ${stage}`
        );
    }
    assert.match(source, /stopNaturalTimer\(sessionId\)/);
    assert.match(source, /stopAutoDeafTimer\(sessionId\)/);
    assert.match(source, /session\.connection\.destroy\(\)/);
});
