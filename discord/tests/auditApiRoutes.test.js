const assert = require("node:assert/strict");
const test = require("node:test");

const { filterRecords, readAuditFilters, readLimit, loadDeadLetterRecords, applyAuditRuntimeSettings } = require("../index/auditApiRoutes");
const auditHealth = require("../logging/auditHealth");
const scheduler = require("../logging/auditReconcilerScheduler");

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

test("audit dead-letter API helper reads records", async () => {
    const data = {
        audit_dead_letter_index_g1: ["a"],
        audit_dead_letter_g1_a: { id: "a", guildId: "g1", reason: "send_failed" }
    };
    const sessionManager = { getSetting: async (key, fallback) => Object.hasOwn(data, key) ? data[key] : fallback };
    const records = await loadDeadLetterRecords(sessionManager, "g1", { limit: 10 });
    assert.equal(records.length, 1);
    assert.equal(records[0].reason, "send_failed");
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

test("audit settings can start and stop reconciler runtime", async () => {
    const client = { guilds: { cache: new Map() } };
    const sessionManager = { getSetting: async (_key, fallback) => fallback };

    try {
        const started = await applyAuditRuntimeSettings({
            client,
            sessionManager,
            settings: { reconcilerEnabled: true, reconcilerIntervalMs: 60000, reconcilerLimit: 1 }
        });
        assert.equal(started.started, true);

        const stopped = await applyAuditRuntimeSettings({
            client,
            sessionManager,
            settings: { reconcilerEnabled: false }
        });
        assert.equal(stopped.stopped, true);
    } finally {
        scheduler.stop();
    }
});

test("audit reconciler scheduler reads guild settings once per disabled guild cycle", async () => {
    let reads = 0;
    const client = { guilds: { cache: new Map([["g1", { id: "g1" }]]) } };
    const sessionManager = {
        getSetting: async (_key, fallback) => {
            reads += 1;
            return { ...fallback, reconcilerEnabled: false };
        }
    };

    try {
        const result = await scheduler.runOnce(client, sessionManager);
        assert.equal(result.ok, true);
        assert.equal(result.results[0].reason, "reconciler_disabled");
        assert.equal(reads, 1);
    } finally {
        scheduler.stop();
    }
});
