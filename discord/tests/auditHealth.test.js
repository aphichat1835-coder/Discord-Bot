const assert = require("node:assert/strict");
const test = require("node:test");

const auditHealth = require("../logging/auditHealth");

test("audit health includes delivery and channel repair state", async () => {
    const data = {
        audit_event_index_g1: [],
        audit_dead_letter_index_g1: ["d1"],
        audit_dead_letter_g1_d1: { id: "d1", reason: "send_failed" }
    };
    const sessionManager = { getSetting: async (key, fallback) => Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback };
    const guild = {
        id: "g1",
        members: { me: { permissions: { has: permission => permission === "VIEW_AUDIT_LOG" } } },
        channels: { cache: { find: () => null } }
    };
    const health = await auditHealth.buildAuditHealth({ guild, sessionManager, auditLogger: { getAuditStats: () => ({ sent: 1 }) } });
    assert.equal(health.permission.hasViewAuditLog, true);
    assert.equal(health.delivery.deadLetters, 1);
    assert.equal(health.channels.ok, false);
});
