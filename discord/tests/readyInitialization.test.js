"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createReadyInitializationController } = require("../core/readyInitialization");

test("post-ready initialization retries once after failure", async () => {
    const timers = []; let attempts = 0;
    const controller = createReadyInitializationController({ initialize: async () => {
        attempts++; if (attempts === 1) throw new Error("first failure");
    }, setTimer(callback) { const timer = { callback, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimer(timer) { timer.cleared = true; } });
    assert.equal(await controller.start(), false); assert.equal(controller.diagnostics().retryScheduled, true);
    timers[0].callback(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2); assert.equal(controller.diagnostics().completed, true);
    assert.equal(await controller.start(), true); assert.equal(attempts, 2);
});

test("controller stop clears scheduled retry", async () => {
    const timers = [];
    const controller = createReadyInitializationController({ initialize: async () => { throw new Error("failure"); },
        setTimer(callback) { const timer = { callback, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimer(timer) { timer.cleared = true; } });
    await controller.start(); controller.stop();
    assert.equal(timers[0].cleared, true); assert.equal(controller.diagnostics().retryScheduled, false);
});
