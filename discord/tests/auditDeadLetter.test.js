const assert = require("node:assert/strict");
const test = require("node:test");

const deadLetter = require("../logging/auditDeadLetter");

test("audit dead letter normalizes failed log records", () => {
    const record = deadLetter.normalizeDeadLetter({
        guildId: "g1",
        category: "voice",
        actionType: "VOICE_MOVE",
        reason: "send_failed",
        payload: { title: "Voice moved" }
    });
    assert.equal(record.guildId, "g1");
    assert.equal(record.category, "voice");
    assert.equal(record.actionType, "VOICE_MOVE");
    assert.equal(record.reason, "send_failed");
    assert.equal(record.payload.title, "Voice moved");
});

test("audit dead letter keys are stable", () => {
    assert.equal(deadLetter.deadLetterIndexKey("guild1"), "audit_dead_letter_index_guild1");
    assert.equal(deadLetter.deadLetterRecordKey("guild1", "id1"), "audit_dead_letter_guild1_id1");
});
