"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../index/system.js"), "utf8");
const shutdownStart = source.indexOf("async function shutdown(signal, exitCode = 0)");
const shutdownEnd = source.indexOf("\n    setFatalShutdownHandler(shutdown);", shutdownStart);
assert.notEqual(shutdownStart, -1, "shutdown function must exist");
assert.ok(shutdownEnd > shutdownStart, "shutdown function boundary must exist");
const shutdownSource = source.slice(shutdownStart, shutdownEnd);

function shutdownIndex(fragment) {
    const index = shutdownSource.indexOf(fragment);
    assert.notEqual(index, -1, `missing shutdown step: ${fragment}`);
    return index;
}

test("graceful shutdown keeps the audited cleanup order", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const orderedSteps = [
        "if (isShuttingDownMain) return;",
        "markAppShuttingDown();",
        "stopCronJobs();",
        "dmService?.stop?.();",
        "stopRuntimeCleanups(runtimeCleanups);",
        "await verificationRuntime?.stopVerificationRuntime?.();",
        "voiceWorker.setShuttingDown(true);",
        "await voiceWorker.pauseAll();",
        "await sessionManager.saveDatabase();",
        "client.destroy();",
        "await closeServer();",
        "await flushWebhookQueue(2500);",
        "await shutdownWebhookDispatcher(500);",
        "await sessionManager.disconnectDB?.();",
        "process.exit(exitCode);"
    ];

    const positions = orderedSteps.map(shutdownIndex);
    for (let index = 1; index < positions.length; index++) {
        assert.ok(positions[index] > positions[index - 1], `${orderedSteps[index]} must remain after ${orderedSteps[index - 1]}`);
    }
});

test("fatal shutdown still exits non-zero on cleanup failure", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const catchIndex = shutdownIndex("console.error(\"[SHUTDOWN] ❌ Error:\", err.message);");
    const failureExitIndex = shutdownSource.indexOf("process.exit(1);", catchIndex);
    assert.ok(failureExitIndex > catchIndex);
});
