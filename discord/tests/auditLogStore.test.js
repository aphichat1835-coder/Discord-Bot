const assert = require("node:assert/strict");
const test = require("node:test");

const auditLogStore = require("../logging/auditLogStore");
const auditStorage = require("../logging/auditStorage");

test("audit log store builds filtered query", () => {
    assert.deepEqual(auditLogStore.buildListQuery("guild1", {
        category: "security",
        actorId: "actor1",
        ignored: "nope"
    }), {
        guildId: "guild1",
        category: "security",
        actorId: "actor1"
    });
});

test("audit storage normalizes records", () => {
    const record = auditStorage.normalizeAuditRecord({
        eventId: "event1",
        guildId: "guild1",
        actionType: "WEBHOOK_DELETE",
        actorId: "actor1",
        evidence: ["a", "b"]
    });
    assert.equal(record.eventId, "event1");
    assert.equal(record.guildId, "guild1");
    assert.equal(record.actionType, "WEBHOOK_DELETE");
    assert.equal(record.evidence.length, 2);
});
