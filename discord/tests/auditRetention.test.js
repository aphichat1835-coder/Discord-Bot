const assert = require("node:assert/strict");
const test = require("node:test");

const retention = require("../logging/auditRetention");

test("audit retention normalizes days", () => {
    assert.equal(retention.normalizeRetentionDays("forever"), 0);
    assert.equal(retention.normalizeRetentionDays(0), 0);
    assert.equal(retention.normalizeRetentionDays(7), 7);
    assert.equal(retention.normalizeRetentionDays("bad", 30), 30);
});

test("audit retention computes cutoff", () => {
    const now = 1_000_000;
    assert.equal(retention.cutoffForRetention(0, now), null);
    assert.equal(retention.cutoffForRetention(1, now), now - retention.DAY_MS);
});
