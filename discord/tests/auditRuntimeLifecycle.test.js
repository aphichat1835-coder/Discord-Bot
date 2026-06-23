const assert = require("node:assert/strict");
const test = require("node:test");

const lifecycle = require("../logging/auditRuntimeLifecycle");

test("audit runtime lifecycle exposes scheduler controls", () => {
    assert.equal(typeof lifecycle.startAuditRuntime, "function");
    assert.equal(typeof lifecycle.stopAuditRuntime, "function");
    assert.equal(typeof lifecycle.auditRuntimeStats, "function");
});

test("audit runtime lifecycle stays inactive by default", () => {
    const logs = [];
    const result = lifecycle.startAuditRuntime({
        client: { guilds: { cache: new Map() } },
        sessionManager: {},
        logger: { log: message => logs.push(message) }
    });
    assert.equal(result.started, false);
    assert.equal(result.reason, "disabled");
    assert.ok(logs.some(message => message.includes("inactive")));
});
