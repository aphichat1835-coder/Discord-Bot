const assert = require("node:assert/strict");
const test = require("node:test");

const moderation = require("../commands/moderation");

const DAY_MS = 24 * 60 * 60 * 1000;

function message(id, ageMs, now, onDelete) {
    return {
        id,
        createdTimestamp: now - ageMs,
        delete: async () => onDelete(id)
    };
}

test("clear bulk-deletes recent messages and individually deletes old messages", async () => {
    const now = Date.now();
    const individuallyDeleted = [];
    const recent = [
        message("recent-1", DAY_MS, now, id => individuallyDeleted.push(id)),
        message("recent-2", DAY_MS, now, id => individuallyDeleted.push(id))
    ];
    const old = message("old-1", 20 * DAY_MS, now, id => individuallyDeleted.push(id));
    const fetched = new Map([...recent, old].map(item => [item.id, item]));
    const channel = {
        messages: { fetch: async () => fetched },
        bulkDelete: async items => new Map(items.map(item => [item.id, item]))
    };

    const result = await moderation._test.deleteChannelMessages(channel, 3, now);

    assert.deepEqual(result, {
        requested: 3,
        fetched: 3,
        bulkDeleted: 2,
        individualDeleted: 1,
        deleted: 3,
        failed: 0
    });
    assert.deepEqual(individuallyDeleted, ["old-1"]);
});

test("clear falls back to sequential deletion when bulk deletion fails", async () => {
    const now = Date.now();
    const individuallyDeleted = [];
    const messages = [
        message("one", DAY_MS, now, id => individuallyDeleted.push(id)),
        message("two", DAY_MS, now, id => individuallyDeleted.push(id))
    ];
    const channel = {
        messages: { fetch: async () => new Map(messages.map(item => [item.id, item])) },
        bulkDelete: async () => {
            throw Object.assign(new Error("bulk failed"), { code: 50034 });
        }
    };

    const result = await moderation._test.deleteChannelMessages(channel, 2, now);

    assert.equal(result.bulkDeleted, 0);
    assert.equal(result.individualDeleted, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(individuallyDeleted, ["one", "two"]);
});

test("clear reports individual failures without stopping later deletions", async () => {
    const now = Date.now();
    const deleted = [];
    const messages = [
        message("failed", 30 * DAY_MS, now, () => Promise.reject(new Error("missing"))),
        message("deleted", 30 * DAY_MS, now, id => deleted.push(id))
    ];
    const channel = {
        messages: { fetch: async () => new Map(messages.map(item => [item.id, item])) },
        bulkDelete: async () => new Map()
    };

    const result = await moderation._test.deleteChannelMessages(channel, 2, now);

    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(deleted, ["deleted"]);
});
