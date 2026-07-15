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

test("internal event rollover deletes evicted records and keeps the index bounded", async () => {
    const values = new Map();
    const guildId = "guild";
    const ids = Array.from({ length: 500 }, (_, index) => `event-${index}`);
    values.set(storage.indexKey(guildId), ids);
    for (const id of ids) values.set(storage.storageKey(guildId, id), { eventId: id });
    const deleted = [];
    const sessionManager = {
        async getSetting(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
        async getSettingStrict(key) { return { found: values.has(key), value: values.get(key) ?? null }; },
        async setSetting(key, value) { values.set(key, value); return true; },
        async deleteSetting(key) { deleted.push(key); values.delete(key); return true; }
    };

    const result = await storage._test.saveFallback(sessionManager, {
        guildId,
        eventId: "event-new"
    });

    assert.equal(result.eventId, "event-new");
    assert.equal(values.get(storage.indexKey(guildId)).length, 500);
    assert.equal(values.get(storage.indexKey(guildId))[0], "event-new");
    assert.equal(values.has(storage.storageKey(guildId, "event-499")), false);
    assert.deepEqual(deleted, [storage.storageKey(guildId, "event-499")]);
});

test("internal event eviction retries a transient delete failure", async () => {
    let attempts = 0;
    const deleted = await storage._test.deleteSettingWithRetry({
        async deleteSetting() { attempts++; return attempts >= 2; }
    }, "internal_event_guild_event", 3);
    assert.equal(deleted, true);
    assert.equal(attempts, 2);
});

test("internal event save removes the new record when index persistence fails", async () => {
    const values = new Map();
    const guildId = "guild";
    const recordKey = storage.storageKey(guildId, "event-new");
    const sessionManager = {
        async getSetting(_key, fallback) { return fallback; },
        async getSettingStrict() { return { found: false, value: null }; },
        async setSetting(key, value) {
            if (key === storage.indexKey(guildId)) return false;
            values.set(key, value);
            return true;
        },
        async deleteSetting(key) { values.delete(key); return true; }
    };

    const result = await storage._test.saveFallback(sessionManager, { guildId, eventId: "event-new" });

    assert.equal(result, null);
    assert.equal(values.has(recordKey), false);
});

test("internal event index failure restores a previous record with the same id", async () => {
    const guildId = "guild";
    const recordKey = storage.storageKey(guildId, "same-event");
    const values = new Map([[recordKey, { guildId, eventId: "same-event", summary: "old" }]]);
    const sessionManager = {
        async getSetting(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
        async getSettingStrict(key) { return { found: values.has(key), value: values.get(key) ?? null }; },
        async setSetting(key, value) {
            if (key === storage.indexKey(guildId)) return false;
            values.set(key, value);
            return true;
        },
        async deleteSetting(key) { values.delete(key); return true; }
    };
    const result = await storage._test.saveFallback(sessionManager, { guildId, eventId: "same-event", summary: "new" });
    assert.equal(result, null);
    assert.equal(values.get(recordKey).summary, "old");
});

test("internal event save aborts before writing when a strict read fails", async () => {
    let writes = 0;
    const sessionManager = {
        async getSetting(_key, fallback) { return fallback; },
        async getSettingStrict() { throw new Error("database unavailable"); },
        async setSetting() { writes++; return true; }
    };

    await assert.rejects(
        storage._test.saveFallback(sessionManager, { guildId: "guild", eventId: "event-new" }),
        /database unavailable/
    );
    assert.equal(writes, 0);
});

test("general settings loader excludes internal event namespaces before applying its limit", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(require.resolve("../sessionManager"), "utf8");
    assert.match(source, /const INTERNAL_EVENT_SETTINGS = \/\^internal_event_\//);
    assert.match(source, /\{ key: INTERNAL_EVENT_SETTINGS \}/);
    assert.match(source, /INTERNAL_EVENT_SETTINGS\.test\(key\)/);
    assert.match(source, /function shouldCacheSettingKey\(key\)/);
    assert.match(source, /if \(shouldCacheSettingKey\(key\)\) settingsCache\.set/);
    assert.match(source, /if \(result\?\.acknowledged === false\) return false;/);
});
