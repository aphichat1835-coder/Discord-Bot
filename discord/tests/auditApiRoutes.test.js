const assert = require("node:assert/strict");
const test = require("node:test");

const { filterRecords, readAuditFilters, readLimit } = require("../index/auditApiRoutes");
const auditHealth = require("../logging/auditHealth");

test("audit API filter narrows records", () => {
    const records = [
        { eventId: "1", category: "server", severity: "warning", actionType: "ROLE_UPDATE", actorId: "a", createdAt: 100 },
        { eventId: "2", category: "security", severity: "danger", actionType: "WEBHOOK_DELETE", actorId: "b", createdAt: 200 }
    ];
    assert.deepEqual(filterRecords(records, { category: "security" }).map(r => r.eventId), ["2"]);
    assert.deepEqual(filterRecords(records, { actorId: "a" }).map(r => r.eventId), ["1"]);
    assert.deepEqual(filterRecords(records, { from: 150 }).map(r => r.eventId), ["2"]);
});

test("audit API helpers sanitize filters and limits", () => {
    assert.deepEqual(readAuditFilters({ category: "server", roleId: "r", ignored: "x", from: "10" }), {
        category: "server",
        roleId: "r",
        from: 10
    });
    assert.equal(readLimit({ limit: 9999 }, 50, 500), 500);
    assert.equal(readLimit({ limit: "bad" }, 25, 500), 25);
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
