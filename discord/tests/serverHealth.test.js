"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../index/server");

function payload(overrides = {}) {
    return _test.buildReadinessPayload({
        client: { isReady: () => true },
        sessionManager: { getDatabaseStatus: () => ({ connected: true }) },
        voiceWorker: { getWorkerDiagnostics: () => ({ ready: true }) },
        commandsReady: () => true,
        featureFlags: { voice: true, verification: true },
        verification: { ready: true },
        ...overrides
    });
}

test("readiness is healthy only when every required runtime dependency is ready", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(payload().ready, true);
    assert.equal(payload({ client: { isReady: () => false } }).ready, false);
    assert.equal(payload({ sessionManager: { getDatabaseStatus: () => ({ connected: false }) } }).ready, false);
    assert.equal(payload({ verification: { ready: false } }).ready, false);
    assert.equal(payload({ voiceWorker: { getWorkerDiagnostics: () => ({ ready: false }) } }).ready, false);
    assert.equal(payload({ commandsReady: () => false }).ready, false);
});

test("disabled optional subsystems do not block readiness", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = payload({
        featureFlags: { voice: false, verification: false },
        voiceWorker: { getWorkerDiagnostics: () => ({ ready: false }) },
        verification: { ready: false }
    });
    assert.equal(result.ready, true);
    assert.equal(result.voiceReady, true);
    assert.equal(result.verificationReady, true);
});
