"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createShutdownCoordinator } = require("../core/runtimeLifecycle");

function fixture({ failAt = null } = {}) {
    const calls = [];
    const exitCodes = [];
    const timers = new Set();
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
    const setTimer = callback => {
        const timer = { callback, unref() {} };
        timers.add(timer);
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
            pauseAll: step("pause voice")
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
    return { shutdown, calls, exitCodes, timers };
}

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
