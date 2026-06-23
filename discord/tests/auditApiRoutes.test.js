const assert = require("node:assert/strict");
const test = require("node:test");

const { filterRecords } = require("../index/auditApiRoutes");
const auditHealth = require("../logging/auditHealth");

test("audit API filter narrows records", () => {
    const records = [
        { eventId: "1", category: "server", severity: "warning", actionType: "ROLE_UPDATE", actorId: "a" },
        { eventId: "2", category: "security", severity: "danger", actionType: "WEBHOOK_DELETE", actorId: "b" }
    ];
    assert.deepEqual(filterRecords(records, { category: "security" }).map(r => r.eventId), ["2"]);
    assert.deepEqual(filterRecords(records, { actorId: "a" }).map(r => r.eventId), ["1"]);
});

test("audit health reports permission status", () => {
    const health = auditHealth.permissionHealth({
        members: {
            me: {
                permissions: { has: permission => permission === "VIEW_AUDIT_LOG" }
            }
        }
    });
    assert.equal(health.hasViewAuditLog, true);
});
