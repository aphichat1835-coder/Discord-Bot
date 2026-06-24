const assert = require("node:assert/strict");
const test = require("node:test");

const eventMap = require("../logging/auditEventMap");
const formatter = require("../logging/auditGenericFormatter");
const storage = require("../logging/auditStorage");
const reconciler = require("../logging/auditReconciler");

test("audit event map resolves categories and severities", () => {
    assert.equal(eventMap.categoryForAuditEvent("MESSAGE_DELETE"), "message");
    assert.equal(eventMap.categoryForAuditEvent("MEMBER_MOVE"), "voice");
    assert.equal(eventMap.categoryForAuditEvent("WEBHOOK_DELETE"), "security");
    assert.equal(eventMap.categoryForAuditEvent("ROLE_UPDATE"), "server");
    assert.equal(eventMap.severityForAuditEvent("ROLE_DELETE"), "danger");
    assert.equal(eventMap.severityForAuditEvent("ROLE_CREATE"), "success");
    assert.equal(eventMap.severityForAuditEvent("ROLE_UPDATE"), "warning");
});

test("generic audit formatter renders options and changes safely", () => {
    const entry = {
        id: "entry1",
        action: "CHANNEL_UPDATE",
        user_id: "actor1",
        target_id: "target1",
        options: { channel_id: "channel1" },
        changes: [{ key: "name", old: "old", new: "new" }],
        createdTimestamp: Date.now()
    };
    const embed = formatter.renderGenericAuditEntry(entry);
    const json = embed.toJSON();
    assert.match(json.title, /CHANNEL_UPDATE/);
    assert.ok(json.fields.some(field => field.name === "Options"));
    assert.ok(json.fields.some(field => field.name === "Changes"));
});

test("audit storage saves and lists records with settings fallback", async () => {
    const settings = new Map();
    const sessionManager = {
        async setSetting(key, value) { settings.set(key, value); return true; },
        async getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; }
    };
    const saved = await storage.saveAuditRecord(sessionManager, {
        eventId: "event1",
        guildId: "guild1",
        actionType: "ROLE_UPDATE",
        actorId: "actor1"
    });
    assert.equal(saved.eventId, "event1");
    const listed = await storage.listAuditRecords(sessionManager, "guild1", 5);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].actionType, "ROLE_UPDATE");
});

test("audit reconciler normalizes entries", () => {
    const normalized = reconciler.normalizeEntry({
        id: "entry1",
        action: "WEBHOOK_DELETE",
        user_id: "actor1",
        target_id: "target1",
        options: { channel_id: "channel1" },
        createdTimestamp: 123
    });
    assert.equal(normalized.action, "WEBHOOK_DELETE");
    assert.equal(normalized.category, "security");
    assert.equal(normalized.actorId, "actor1");
    assert.equal(normalized.targetId, "target1");
});

test("audit reconciler pages backward until the saved cursor", async () => {
    const settings = new Map([
        [reconciler.cursorKey("guild1"), { lastEntryId: "old" }]
    ]);
    const sessionManager = {
        async getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
        async setSetting(key, value) { settings.set(key, value); return true; }
    };
    const pages = [
        [{ id: "newest", action: "ROLE_UPDATE", createdTimestamp: 300 }, { id: "middle", action: "ROLE_UPDATE", createdTimestamp: 200 }],
        [{ id: "older", action: "ROLE_UPDATE", createdTimestamp: 150 }, { id: "old", action: "ROLE_UPDATE", createdTimestamp: 100 }]
    ];
    const calls = [];
    const guild = {
        id: "guild1",
        channels: { cache: { get: () => null, find: () => null } },
        async fetchAuditLogs(options) {
            calls.push(options);
            const page = pages.shift() || [];
            return { entries: { values: () => page.values() } };
        }
    };

    const result = await reconciler.runAuditReconcile(guild, sessionManager, { limit: 2, maxPages: 3 });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].before, "middle");
    assert.equal(result.scanned, 3);
    assert.equal(result.lastEntryId, "newest");
    assert.equal(settings.get(reconciler.cursorKey("guild1")).lastEntryId, "newest");
});
