"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    createCriticalAlertDispatcher,
    stopRuntimeCleanups,
    isTransientGatewayError,
    isRecoverableRuntimeError
} = require("../index/system");

function createHarness(options = {}) {
    const sent = [];
    const timers = [];
    let currentTime = 1000;
    const dispatcher = createCriticalAlertDispatcher({
        cooldownMs: 1000,
        maxFingerprints: options.maxFingerprints || 10,
        now: () => currentTime,
        send: async payload => {
            sent.push(payload);
            return true;
        },
        setTimer(callback) {
            const timer = { callback, cleared: false, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) {
            timer.cleared = true;
        }
    });
    return {
        dispatcher,
        sent,
        timers,
        advance(ms) {
            currentTime += ms;
        }
    };
}

test("critical alert dispatcher sends first occurrence and summarizes duplicates", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = createHarness();
    const error = new Error("same failure");

    assert.equal(await harness.dispatcher.dispatch("unhandledRejection", error, { content: "first" }), true);
    assert.equal(await harness.dispatcher.dispatch("unhandledRejection", error, { content: "duplicate" }), false);
    assert.equal(harness.sent.length, 1);

    await harness.timers[0].callback();
    assert.equal(harness.sent.length, 2);
    assert.match(harness.sent[1].embeds[0].title, /ข้อผิดพลาดระดับวิกฤตเกิดซ้ำ/);
    assert.equal(harness.sent[1].embeds[0].fields.some(field => /1 ครั้ง/.test(field.value)), true);
    assert.equal(harness.dispatcher.entries.size, 0);
});

test("critical alert dispatcher keeps distinct failures separate and bounds memory", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = createHarness({ maxFingerprints: 2 });

    await harness.dispatcher.dispatch("uncaughtException", new Error("first"), { content: "first" });
    await harness.dispatcher.dispatch("uncaughtException", new Error("second"), { content: "second" });
    await harness.dispatcher.dispatch("uncaughtException", new Error("third"), { content: "third" });

    assert.equal(harness.sent.length, 3);
    assert.equal(harness.dispatcher.entries.size, 2);
    assert.equal(harness.timers[0].cleared, true);
    harness.dispatcher.stop();
    assert.equal(harness.dispatcher.entries.size, 0);
});

test("critical alert dispatcher sends a new occurrence after cooldown", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = createHarness();
    const error = new Error("recurring failure");

    await harness.dispatcher.dispatch("uncaughtException", error, { content: "first" });
    harness.advance(1001);
    await harness.dispatcher.dispatch("uncaughtException", error, { content: "after cooldown" });

    assert.deepEqual(harness.sent.map(item => item.content), ["first", "after cooldown"]);
    assert.equal(harness.timers[0].cleared, true);
});

test("critical dispatcher does not suppress a later occurrence when first delivery fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let attempts = 0;
    const dispatcher = createCriticalAlertDispatcher({
        cooldownMs: 1000,
        send: async () => ++attempts > 1,
        setTimer(callback) {
            return { callback, cleared: false, unref() {} };
        },
        clearTimer(timer) {
            timer.cleared = true;
        }
    });
    const error = new Error("delivery failure");

    assert.equal(await dispatcher.dispatch("unhandledRejection", error, { content: "first" }), false);
    assert.equal(dispatcher.entries.size, 0);
    assert.equal(await dispatcher.dispatch("unhandledRejection", error, { content: "second" }), true);
    assert.equal(attempts, 2);
    dispatcher.stop();
});

test("critical alert dispatcher does not suppress a retry after delivery failure", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let attempts = 0;
    const timers = [];
    const dispatcher = createCriticalAlertDispatcher({
        cooldownMs: 1000,
        send: async () => ++attempts > 1,
        setTimer(callback) {
            const timer = { callback, cleared: false, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) { timer.cleared = true; }
    });
    const error = new Error("delivery failed once");
    assert.equal(await dispatcher.dispatch("unhandledRejection", error, { content: "first" }), false);
    assert.equal(dispatcher.entries.size, 0);
    assert.equal(timers[0].cleared, true);
    assert.equal(await dispatcher.dispatch("unhandledRejection", error, { content: "retry" }), true);
    assert.equal(attempts, 2);
});

test("runtime cleanup awaits every healthy timer even when one cleanup fails", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let stopped = 0;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const result = await stopRuntimeCleanups([
            { stop() { stopped++; } },
            { stop() { throw new Error("cleanup failure"); } },
            null,
            { stop() { stopped++; } }
        ]);

        t.assert.deepEqual(result, { stopped: 2, failed: 1 });
        t.assert.equal(stopped, 2);
    } finally {
        console.warn = originalWarn;
    }
});

test("isTransientGatewayError identifies Cloudflare and Discord gateway transient blips", () => {
    // Cloudflare 521, 522, 520, etc.
    assert.equal(isTransientGatewayError(new Error("Unexpected server response: 521")), true);
    assert.equal(isTransientGatewayError(new Error("Unexpected server response: 522")), true);
    assert.equal(isTransientGatewayError(new Error("Unexpected server response: 502")), true);
    assert.equal(isTransientGatewayError(new Error("Unexpected server response: 503")), true);
    assert.equal(isTransientGatewayError(new Error("Unexpected server response: 504")), true);
    assert.equal(isTransientGatewayError(new Error("Unexpected server response: 520")), true);

    // WebSocket handshake timeouts and premature closes
    assert.equal(isTransientGatewayError(new Error("Opening handshake has timed out")), true);
    assert.equal(isTransientGatewayError(new Error("WebSocket was closed before the connection was established")), true);

    // Socket network errors on gateway/websocket
    const resetErr = new Error("read ECONNRESET");
    resetErr.code = "ECONNRESET";
    resetErr.stack = "Error: read ECONNRESET at TLSWrap.onStreamRead (/app/node_modules/ws/lib/websocket.js:930)";
    assert.equal(isTransientGatewayError(resetErr), true);

    const timedOutErr = new Error("connect ETIMEDOUT gateway.discord.gg:443");
    timedOutErr.code = "ETIMEDOUT";
    assert.equal(isTransientGatewayError(timedOutErr), true);

    // Cause-based network errors (e.g. Node 18+ undici fetch failed)
    const causeErr = new Error("fetch failed");
    causeErr.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };
    causeErr.stack = "Error: fetch failed at discord.com/api/v10";
    assert.equal(isTransientGatewayError(causeErr), true);

    const resetCauseErr = new Error("fetch failed");
    resetCauseErr.cause = { code: "ECONNRESET", message: "other side closed" };
    resetCauseErr.stack = "Error: fetch failed at gateway.discord.gg";
    assert.equal(isTransientGatewayError(resetCauseErr), true);

    // Discord REST 5xx transient outages
    assert.equal(isTransientGatewayError(new Error("DiscordAPIError[500]: Internal Server Error")), true);
    assert.equal(isTransientGatewayError(new Error("DiscordAPIError[502]: Bad Gateway")), true);
    assert.equal(isTransientGatewayError(new Error("DiscordAPIError[503]: Service Unavailable")), true);

    // Stream / socket premature close
    assert.equal(isTransientGatewayError(new Error("Connection reset by peer")), true);
    assert.equal(isTransientGatewayError(new Error("ERR_STREAM_PREMATURE_CLOSE: premature close")), true);

    // Non-transient normal errors must NOT be ignored
    assert.equal(isTransientGatewayError(new Error("TypeError: Cannot read properties of undefined")), false);
    assert.equal(isTransientGatewayError(new Error("MongoDB connection failed")), false);
    assert.equal(isTransientGatewayError(new Error("Unexpected token < in JSON at position 0")), false);
    assert.equal(isTransientGatewayError(null), false);
    assert.equal(isTransientGatewayError(undefined), false);
});

test("isRecoverableRuntimeError shields DiscordAPIError, messaging issues, and Mongo buffering", () => {
    // Discord API errors
    const discordErr = new Error("Unknown interaction");
    discordErr.name = "DiscordAPIError";
    assert.equal(isRecoverableRuntimeError(discordErr), true);

    assert.equal(isRecoverableRuntimeError(new Error("DiscordAPIError[10062]: Unknown interaction")), true);
    assert.equal(isRecoverableRuntimeError(new Error("DiscordAPIError[10008]: Unknown message")), true);
    assert.equal(isRecoverableRuntimeError(new Error("DiscordAPIError[50007]: Cannot send messages to this user")), true);
    assert.equal(isRecoverableRuntimeError(new Error("DiscordAPIError[50013]: Missing Permissions")), true);
    assert.equal(isRecoverableRuntimeError(new Error("Interaction has already been acknowledged")), true);

    // Mongo transient drops
    const mongoErr = new Error("connection 0 to cluster0.mongodb.net:27017 closed");
    mongoErr.name = "MongoNetworkError";
    assert.equal(isRecoverableRuntimeError(mongoErr), true);

    assert.equal(isRecoverableRuntimeError(new Error("MongooseError: Operation buffering timed out after 10000ms")), true);

    // Also inherits transient gateway errors
    assert.equal(isRecoverableRuntimeError(new Error("Unexpected server response: 521")), true);

    // Truly fatal errors are NOT shielded
    assert.equal(isRecoverableRuntimeError(new Error("TypeError: Cannot read properties of undefined")), false);
    assert.equal(isRecoverableRuntimeError(new Error("SyntaxError: Unexpected token")), false);
    assert.equal(isRecoverableRuntimeError(null), false);
    assert.equal(isRecoverableRuntimeError(undefined), false);
});

