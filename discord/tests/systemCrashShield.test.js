"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCriticalAlertDispatcher } = require("../index/system");

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

test("critical alert dispatcher sends first occurrence and summarizes duplicates", async () => {
    const harness = createHarness();
    const error = new Error("same failure");

    assert.equal(await harness.dispatcher.dispatch("unhandledRejection", error, { content: "first" }), true);
    assert.equal(await harness.dispatcher.dispatch("unhandledRejection", error, { content: "duplicate" }), false);
    assert.equal(harness.sent.length, 1);

    await harness.timers[0].callback();
    assert.equal(harness.sent.length, 2);
    assert.match(harness.sent[1].content, /Repeated 1 additional time/);
    assert.equal(harness.dispatcher.entries.size, 0);
});

test("critical alert dispatcher keeps distinct failures separate and bounds memory", async () => {
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

test("critical alert dispatcher sends a new occurrence after cooldown", async () => {
    const harness = createHarness();
    const error = new Error("recurring failure");

    await harness.dispatcher.dispatch("uncaughtException", error, { content: "first" });
    harness.advance(1001);
    await harness.dispatcher.dispatch("uncaughtException", error, { content: "after cooldown" });

    assert.deepEqual(harness.sent.map(item => item.content), ["first", "after cooldown"]);
    assert.equal(harness.timers[0].cleared, true);
});
