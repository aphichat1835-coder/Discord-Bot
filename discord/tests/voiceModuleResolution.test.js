"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

test("Voice Worker architecture: discord/voiceWorker.js wrapper is eliminated", () => {
    const legacyWrapperPath = path.resolve(__dirname, "../voiceWorker.js");
    assert.equal(fs.existsSync(legacyWrapperPath), false, "discord/voiceWorker.js wrapper must not exist");
});

test("Voice Worker architecture: discord/voiceWorker/ folder is intact with all core submodules", () => {
    const workerDir = path.resolve(__dirname, "../voiceWorker");
    assert.equal(fs.existsSync(workerDir), true, "discord/voiceWorker/ directory must exist");

    const requiredModules = [
        "autoDeaf.js",
        "cacheUtils.js",
        "channelLock.js",
        "config.js",
        "display.js",
        "dm.js",
        "eventLog.js",
        "index.js",
        "lifecycle.js",
        "lifecycleCleanup.js",
        "lifecycleRecovery.js",
        "natural.js",
        "notifications.js",
        "queue.js",
        "session.js",
        "sessionManager.js",
        "state.js"
    ];

    for (const mod of requiredModules) {
        assert.equal(
            fs.existsSync(path.join(workerDir, mod)),
            true,
            `Required voiceWorker submodule ${mod} must exist in discord/voiceWorker/`
        );
    }
});

test("Voice Worker module resolution: directory and explicit index resolve identically", () => {
    const dirResolved = require.resolve("../voiceWorker");
    const explicitResolved = require.resolve("../voiceWorker/index");
    const expectedTarget = path.resolve(__dirname, "../voiceWorker/index.js");

    assert.equal(dirResolved, expectedTarget, "require.resolve('../voiceWorker') must resolve to index.js");
    assert.equal(explicitResolved, expectedTarget, "require.resolve('../voiceWorker/index') must resolve to index.js");
    assert.equal(dirResolved, explicitResolved, "Directory and index resolution must be identical");

    const fromDir = require("../voiceWorker");
    const fromIndex = require("../voiceWorker/index");
    assert.equal(fromDir, fromIndex, "require('../voiceWorker') and require('../voiceWorker/index') must return the same instance");
});

test("Voice Worker export contract: all public lifecycle, control, diagnostic, and helper APIs are preserved", () => {
    const worker = require("../voiceWorker/index");

    const expectedFunctions = [
        "setMainClient",
        "setShuttingDown",
        "setProtectedChecker",
        "getClientPoolSize",
        "getWorkerDiagnostics",
        "cleanupVolatileState",
        "ensureVoiceSession",
        "startSession",
        "repairFailedStopSessionForTokenGuild",
        "stopSession",
        "stopAll",
        "pauseAll",
        "autoResume",
        "forceReconnectSession",
        "healthCheck",
        "cleanupIdleSessions",
        "clearHibernateTimer",
        "getVoiceLogs",
        "sendSessionStoppedDM",
        "sendTokenInvalidDM",
        "sendSessionOnlineDM",
        "applyNaturalSettings",
        "startNaturalTimer",
        "stopNaturalTimer",
        "getNaturalSettings",
        "applyAutoDeafSettings",
        "startAutoDeafTimer",
        "stopAutoDeafTimer",
        "getAutoDeafSettings"
    ];

    for (const fn of expectedFunctions) {
        assert.equal(typeof worker[fn], "function", `Export ${fn} must be a function`);
    }

    assert.equal(typeof worker.channelLock, "object", "Export channelLock must be an object");
    assert.notEqual(worker.channelLock, null, "Export channelLock must not be null");
    assert.equal(typeof worker._test, "object", "Export _test must be an object");
    assert.notEqual(worker._test, null, "Export _test must not be null");
});
