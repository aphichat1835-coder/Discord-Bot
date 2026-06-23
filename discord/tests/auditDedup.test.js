const assert = require("node:assert/strict");
const test = require("node:test");

const { AuditDedupCache, auditEntryKey, gatewayEventKey } = require("../logging/auditDedup");

test("audit dedup cache detects repeated keys", () => {
    const cache = new AuditDedupCache({ ttlMs: 1000, maxKeys: 10 });
    assert.equal(cache.seen("a", 100), false);
    assert.equal(cache.seen("a", 200), true);
    assert.equal(cache.seen("a", 1200), false);
});

test("audit dedup key helpers are stable", () => {
    assert.equal(auditEntryKey("guild1", "entry1"), "audit:guild1:entry1");
    assert.equal(gatewayEventKey("guild1", "ROLE_UPDATE", "role1", 10), "gateway:guild1:ROLE_UPDATE:role1:10");
});
