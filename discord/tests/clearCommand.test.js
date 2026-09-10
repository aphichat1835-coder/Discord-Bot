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

test("clear bulk-deletes recent messages and individually deletes old messages", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("clear falls back to sequential deletion when bulk deletion fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("clear reports individual failures without stopping later deletions", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("clear supports multi-batch deletion beyond 100 messages", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const now = Date.now();
    let totalMessagesInChannel = 250;
    const fetchCalls = [];
    const channel = {
        messages: {
            fetch: async (options) => {
                fetchCalls.push(options);
                const count = Math.min(options.limit || 100, totalMessagesInChannel);
                totalMessagesInChannel -= count;
                const batch = [];
                for (let i = 0; i < count; i++) {
                    batch.push(message(`msg-${i}`, DAY_MS, now, () => {}));
                }
                return new Map(batch.map(item => [item.id, item]));
            }
        },
        bulkDelete: async (items) => new Map(items.map(item => [item.id, item]))
    };

    const result = await moderation._test.deleteChannelMessages(channel, 250, now);

    assert.equal(result.requested, 250);
    assert.equal(result.fetched, 250);
    assert.equal(result.bulkDeleted, 250);
    assert.equal(result.deleted, 250);
    assert.equal(result.failed, 0);
    assert.equal(fetchCalls.length, 3); // 100, 100, 50
    assert.equal(fetchCalls[0].limit, 100);
    assert.equal(fetchCalls[1].limit, 100);
    assert.equal(fetchCalls[2].limit, 50);
});

test("clear deleteMessagesIndividually processes items in parallel batches", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const deleted = [];
    const messages = Array.from({ length: 12 }, (_, i) => ({
        id: `msg-${i}`,
        delete: async () => {
            deleted.push(i);
        }
    }));

    const result = await moderation._test.deleteMessagesIndividually(messages, { batchSize: 5, delayMs: 0 });

    assert.equal(result.deleted, 12);
    assert.equal(result.failed, 0);
    assert.equal(deleted.length, 12);
});
