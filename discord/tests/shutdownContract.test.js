"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createShutdownCoordinator, registerShutdownHandlers } = require("../core/runtimeLifecycle");

function fixture({ failAt = null, pauseGate = null } = {}) {
    const calls = [];
    const exitCodes = [];
    const timers = new Set();
    const timerDelays = [];
    const step = name => async () => {
        calls.push(name);
        if (failAt === name) throw new Error(`${name} failed`);
    };
    const system = {
        markAppShuttingDown: () => calls.push("mark shutdown"),
        stopCronJobs: () => calls.push("stop cron"),
        stopRuntimeCleanups(cleanups) {
            calls.push("stop runtime");
            for (const cleanup of cleanups) cleanup.stop();
            return { stopped: cleanups.length, failed: 0 };
        }
    };
    const server = {
        close(callback) {
            calls.push("close HTTP");
            callback();
        }
    };
    const setTimer = (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.add(timer);
        timerDelays.push(delay);
        return timer;
    };
    const clearTimer = timer => timers.delete(timer);
    const logger = { log() {}, warn() {}, error() {} };
    const processRef = { exit: code => exitCodes.push(code) };
    const shutdown = createShutdownCoordinator({
        system,
        sessionManager: {
            saveDatabase: step("save database"),
            disconnectDB: step("disconnect database")
        },
        voiceWorker: {
            setShuttingDown: value => calls.push(`voice shutting:${value}`),
            async pauseAll() {
                calls.push("pause voice");
                if (pauseGate) await pauseGate;
                if (failAt === "pause voice") throw new Error("pause voice failed");
            }
        },
        client: { destroy: () => calls.push("destroy Discord") },
        memoryMonitor: { stopMemoryMonitor: () => calls.push("stop memory") },
        verificationRuntime: { stopVerificationRuntime: step("stop verification") },
        dmService: { stop: () => calls.push("stop DM") },
        runtimeCleanups: [{ stop: () => calls.push("runtime cleanup") }],
        flushWebhookQueue: step("flush webhooks"),
        shutdownWebhookDispatcher: step("stop webhook dispatcher"),
        processRef,
        getServer: () => server,
        setTimer,
        clearTimer,
        logger
    });
    return { shutdown, calls, exitCodes, timers, timerDelays };
}

test("default force timeout allows the full 50-second graceful shutdown window", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { shutdown, timerDelays } = fixture();
    await shutdown("SIGTERM", 0);
    assert.ok(timerDelays.includes(50000));
});

test("graceful shutdown runs the complete audited cleanup order", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { shutdown, calls, exitCodes, timers } = fixture();

    const result = await shutdown("SIGTERM", 0);

    assert.deepEqual(calls, [
        "mark shutdown",
        "stop cron",
        "stop DM",
        "stop runtime",
        "runtime cleanup",
        "stop verification",
        "voice shutting:true",
        "pause voice",
        "save database",
        "destroy Discord",
        "stop memory",
        "close HTTP",
        "flush webhooks",
        "stop webhook dispatcher",
        "disconnect database"
    ]);
    assert.deepEqual(exitCodes, [0]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failures.length, 0);
    assert.equal(timers.size, 0);
});

test("cleanup failure does not skip later shutdown steps and exits non-zero", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { shutdown, calls, exitCodes } = fixture({ failAt: "pause voice" });

    const result = await shutdown("FATAL_uncaughtException", 1);

    assert.ok(calls.indexOf("save database") > calls.indexOf("pause voice"));
    assert.ok(calls.includes("destroy Discord"));
    assert.ok(calls.includes("close HTTP"));
    assert.ok(calls.includes("flush webhooks"));
    assert.ok(calls.includes("disconnect database"));
    assert.deepEqual(exitCodes, [1]);
    assert.equal(result.failures[0].name, "voice pause");
});

test("duplicate shutdown calls share one cleanup execution", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { shutdown, calls, exitCodes } = fixture();

    const first = shutdown("SIGTERM", 0);
    const second = shutdown("SIGINT", 0);
    assert.equal(first, second);
    await Promise.all([first, second]);

    assert.equal(calls.filter(value => value === "pause voice").length, 1);
    assert.deepEqual(exitCodes, [0]);
});

test("fatal error escalates an in-progress graceful shutdown to exit code one", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let releasePause;
    const pauseGate = new Promise(resolve => { releasePause = resolve; });
    const { shutdown, calls, exitCodes } = fixture({ pauseGate });

    const graceful = shutdown("SIGTERM", 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdown.getRequestedExitCode(), 0);
    assert.ok(calls.includes("pause voice"));

    const fatal = shutdown("FATAL_uncaughtException", 1);
    assert.equal(fatal, graceful);
    assert.equal(shutdown.getRequestedExitCode(), 1);
    releasePause();

    const result = await graceful;
    assert.deepEqual(exitCodes, [1]);
    assert.equal(result.requestedExitCode, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(calls.filter(value => value === "pause voice").length, 1);
});

test("explicit shutdown registration installs one handler for each termination signal", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const calls = [];
    const listeners = new Map();
    const exits = [];
    let fatalHandler = null;
    const processRef = {
        on(signal, handler) {
            assert.equal(listeners.has(signal), false);
            listeners.set(signal, handler);
        },
        exit(code) { exits.push(code); }
    };
    const system = {
        setFatalShutdownHandler(handler) { fatalHandler = handler; },
        markAppShuttingDown() { calls.push("mark shutdown"); },
        stopCronJobs() { calls.push("stop cron"); },
        stopRuntimeCleanups() { calls.push("stop runtime"); return { failed: 0 }; }
    };
    const shutdown = registerShutdownHandlers({
        system,
        processRef,
        sessionManager: { saveDatabase: async () => calls.push("save database"), disconnectDB: async () => calls.push("disconnect database") },
        voiceWorker: { setShuttingDown: () => calls.push("voice stopping"), pauseAll: async () => calls.push("pause voice") },
        client: { destroy: () => calls.push("destroy Discord") },
        verificationRuntime: { stopVerificationRuntime: async () => calls.push("stop verification") },
        dmService: { stop: () => calls.push("stop DM") },
        flushWebhookQueue: async () => true,
        shutdownWebhookDispatcher: async () => {},
        getServer: () => ({ close: callback => callback() }),
        logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(fatalHandler, shutdown);
    assert.deepEqual([...listeners.keys()], ["SIGTERM", "SIGINT"]);
    await listeners.get("SIGTERM")();
    assert.deepEqual(exits, [0]);
    assert.equal(calls.filter(value => value === "pause voice").length, 1);
});
