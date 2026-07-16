"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { buildRuntimeStatusPayload } = require("../index/dashboardState");

function buildPayload() {
    const sessions = new Map([
        ["active", { sessionId: "active", state: "active" }],
        ["failed", { sessionId: "failed", state: "failed", tokenInvalid: true }]
    ]);
    const metrics = {
        uptime: Date.now() - 1000,
        requests: 10,
        errors: 1,
        reconnects: 2
    };

    return buildRuntimeStatusPayload({
        sessionManager: {
            getAllSessions: () => sessions,
            isSessionRunnable: session => session.state === "active" && session.tokenInvalid !== true,
            systemMetrics: metrics,
            getCachedSetting: (_key, fallback) => fallback
        },
        voiceWorker: {
            getVoiceLogs: () => [],
            getClientPoolSize: () => 1,
            getWorkerDiagnostics: () => ({ ready: true, clientPool: 1 })
        },
        webLogs: [],
        client: { isReady: () => true, user: { tag: "Bot#0001" } },
        config: { limits: { maxSessions: 30 } },
        botReadyAt: Date.now() - 500,
        serializeVoiceSession: session => ({ sessionId: session.sessionId })
    });
}

test("dashboard reports process RSS separately from V8 heap", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const payload = buildPayload();
    assert.equal(payload.ramMB, payload.rssMB);
    assert.ok(Number(payload.rssMB) > 0);
    assert.ok(Number(payload.heapUsedMB) > 0);
    assert.ok(Number(payload.heapTotalMB) >= Number(payload.heapUsedMB));
    assert.equal(payload.requestCount, 10);
    assert.equal(payload.errorCount, 1);
    assert.equal(payload.rateIsEstimate, true);
});

test("dashboard hides terminal Voice sessions from active cards", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const payload = buildPayload();
    assert.equal(payload.sessions, 1);
    assert.deepEqual(payload.sessionList, [{ sessionId: "active" }]);
});

test("session detail consumes the current API response contract", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const source = fs.readFileSync("discord/index/views.js", "utf8");
    assert.equal(source.includes("if(!d.found)"), false);
    assert.ok(source.includes("d.success===false || !d.session"));
    assert.ok(source.includes("Process RAM (RSS)"));
    assert.ok(source.includes("Error Events"));
});
