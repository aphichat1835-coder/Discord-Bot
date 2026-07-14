const assert = require("node:assert/strict");
const test = require("node:test");

const storage = require("../logging/internalEventStorage");

test("internal event filters accept supported fields and time bounds", () => {
    const record = {
        source: "protection",
        category: "moderation",
        severity: "warning",
        actionType: "TIMEOUT",
        actorId: "actor",
        targetId: "target",
        channelId: "channel",
        createdAt: 200
    };

    assert.equal(storage._test.matchesFilters(record, { source: "protection", from: 100, to: 300 }), true);
    assert.equal(storage._test.matchesFilters(record, { severity: "error" }), false);
    assert.equal(storage._test.matchesFilters(record, { from: 201 }), false);
    assert.equal(storage._test.matchesFilters(record, { to: 199 }), false);
});

test("internal event filters reject unknown fields and malformed time bounds", () => {
    const record = { source: "internal", createdAt: 200 };

    assert.equal(storage._test.matchesFilters(record, { unsupported: "value" }), false);
    assert.equal(storage._test.matchesFilters(record, { from: "not-a-number" }), false);
    assert.equal(storage._test.matchesFilters(record, { source: "" }), true);
});
