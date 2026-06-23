const assert = require("node:assert/strict");
const test = require("node:test");

const repair = require("../logging/auditChannelRepair");

test("audit channel repair plan reports missing channels", () => {
    const guild = { id: "g1", channels: { cache: { find: fn => [{ id: "1", name: "log-ข้อความ" }].find(fn) } } };
    const plan = repair.buildAuditChannelRepairPlan(guild);
    assert.equal(plan.guildId, "g1");
    assert.equal(plan.ok, false);
    assert.ok(plan.present.some(item => item.category === "message"));
    assert.ok(plan.missing.some(item => item.category === "member"));
});

test("audit channel repair expected names can be overridden", () => {
    const expected = repair.expectedAuditChannels({ message: "audit-message" });
    assert.equal(expected.message, "audit-message");
    assert.equal(expected.member, "log-สมาชิก");
});
