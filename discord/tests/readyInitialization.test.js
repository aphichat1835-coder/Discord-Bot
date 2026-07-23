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

test("retry delay rejects non-finite input and clamps zero", async () => {
    const invalidTimers = [];
    const invalid = createReadyInitializationController({
        initialize: async () => { throw new Error("failure"); },
        retryMs: "not-a-number",
        setTimer(callback, delay) {
  const timer = { callback, delay, unref() {} };
  invalidTimers.push(timer);
  return timer;
        }
    });
    await invalid.start();
    assert.equal(invalidTimers[0].delay, 10000);
    invalid.stop();

    const zeroTimers = [];
    const zero = createReadyInitializationController({
        initialize: async () => { throw new Error("failure"); },
        retryMs: 0,
        setTimer(callback, delay) {
  const timer = { callback, delay, unref() {} };
  zeroTimers.push(timer);
  return timer;
        }
    });
    await zero.start();
    assert.equal(zeroTimers[0].delay, 100);
    zero.stop();
});

test("stop prevents an in-flight failure from scheduling a retry", async () => {
    let rejectInitialization;
    const timers = [];
    const pending = new Promise((_, reject) => {
        rejectInitialization = reject;
    });
    const controller = createReadyInitializationController({
        initialize: () => pending,
        setTimer(callback, delay) {
  const timer = { callback, delay, unref() {} };
  timers.push(timer);
  return timer;
        }
    });

    const startResult = controller.start();
    await new Promise(resolve => setImmediate(resolve));
    controller.stop();
    rejectInitialization(new Error("shutdown race"));

    assert.equal(await startResult, false);
    assert.equal(timers.length, 0);
    assert.equal(controller.diagnostics().stopped, true);
    assert.equal(controller.diagnostics().retryScheduled, false);
    assert.equal(await controller.start(), false);
});
