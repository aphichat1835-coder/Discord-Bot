const assert = require("node:assert/strict");
const test = require("node:test");

const { buildAuditRouteMountPlan } = require("../logging/auditRouteMountPlan");

test("audit route mount plan documents required routes", () => {
    const plan = buildAuditRouteMountPlan();
    assert.equal(plan.serverModule, "discord/index/server.js");
    assert.equal(plan.patchDoc, "docs/AUDIT_SERVER_INTEGRATION_PATCH.md");
    assert.ok(plan.routes.includes("/api/audit/logs"));
    assert.ok(plan.routes.includes("/api/audit/export"));
    assert.ok(plan.routes.includes("/api/audit/health"));
    assert.ok(plan.routes.includes("/api/audit/dead-letters"));
    assert.ok(plan.routes.includes("/api/audit/settings"));
    assert.ok(plan.routes.includes("/audit-logs"));
});
