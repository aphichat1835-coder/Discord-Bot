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

test("audit retention cleanup reads shared audit settings", async () => {
    const settings = new Map([
        ["audit_settings_guild1", { retentionDays: "0" }]
    ]);
    const sessionManager = {
        async getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; }
    };
    const client = {
        guilds: {
            cache: new Map([["guild1", { id: "guild1" }]])
        }
    };

    const results = await retention.cleanupClientAuditLogs(client, sessionManager, { retentionDays: 1 });

    assert.equal(results.length, 1);
    assert.equal(results[0].skipped, true);
    assert.equal(results[0].reason, "forever");
});
