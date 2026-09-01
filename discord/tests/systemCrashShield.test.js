"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCriticalAlertDispatcher, stopRuntimeCleanups } = require("../index/system");

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
