const assert = require("node:assert/strict");
const test = require("node:test");

const deadLetter = require("../logging/auditDeadLetter");
const repair = require("../logging/auditChannelRepair");

test("audit dead letter normalizes records", () => {
    const record = deadLetter.normalizeDeadLetter({ guildId: "g", category: "server", actionType: "ROLE_UPDATE" });
    assert.equal(record.guildId, "g");
    assert.equal(record.category, "server");
    assert.equal(record.actionType, "ROLE_UPDATE");
    assert.equal(record.attempts, 0);
});

test("audit channel repair detects missing channels", () => {
    const guild = { id: "g", channels: { cache: { find: fn => [{ id: "1", name: "log-ข้อความ" }].find(fn) } } };
    const plan = repair.buildAuditChannelRepairPlan(guild);
    assert.equal(plan.ok, false);
    assert.ok(plan.present.some(item => item.category === "message"));
    assert.ok(plan.missing.length > 0);
});
