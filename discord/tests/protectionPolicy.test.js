const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("../logging/protectionPolicy");
const { ProtectionWindowState } = require("../logging/protectionState");

test("protection policy defaults to audit only", () => {
    const decision = policy.buildProtectionDecision({ actionType: "ROLE_DELETE", actorId: "actor1", count: 3 }, {});
    assert.equal(decision.triggered, true);
    assert.equal(decision.mode, "audit_only");
    assert.equal(decision.recommendedAction, "none");
});

test("protection policy respects trusted actors", () => {
    const decision = policy.buildProtectionDecision(
        { actionType: "CHANNEL_DELETE", actorId: "owner", count: 10 },
        { trustedUsers: ["owner"] }
    );
    assert.equal(decision.trusted, true);
    assert.equal(decision.triggered, false);
});

test("protection window state counts events in window", () => {
    const state = new ProtectionWindowState();
    const first = state.record({ guildId: "g", actorId: "a", actionType: "ROLE_DELETE", now: 1000, windowMs: 1000 });
    const second = state.record({ guildId: "g", actorId: "a", actionType: "ROLE_DELETE", now: 1500, windowMs: 1000 });
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);
    assert.equal(state.count({ guildId: "g", actorId: "a", actionType: "ROLE_DELETE", now: 3000, windowMs: 1000 }), 0);
});
