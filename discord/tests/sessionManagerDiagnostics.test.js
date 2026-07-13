const assert = require("node:assert/strict");
const test = require("node:test");

const sessionManager = require("../sessionManager");

test("session manager diagnostics expose bounded load limits", () => {
    const diagnostics = sessionManager.getSessionDiagnostics();
    const database = sessionManager.getDatabaseStatus();

    assert.equal(typeof diagnostics.limits.sessionLoadMax, "number");
    assert.equal(typeof diagnostics.limits.approvedGuildsLoadMax, "number");
    assert.equal(typeof diagnostics.limits.pendingGuildsLoadMax, "number");
    assert.equal(typeof diagnostics.limits.botSettingsLoadMax, "number");
    assert.equal(typeof diagnostics.limits.panelStatesLoadMax, "number");
    assert.equal(diagnostics.lastLoad.max, diagnostics.limits.sessionLoadMax);
    assert.deepEqual(database.loadLimits, diagnostics.limits);
});
