const assert = require("node:assert/strict");
const test = require("node:test");

const sessionManager = require("../sessionManager");
const utility = require("../commands/utility");

test("snapshot chunker preserves every item while bounding each chunk", () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ id: String(index), value: "x".repeat(120) }));
    const chunks = sessionManager.chunkSnapshotItems(items, 1024);
    assert.deepEqual(chunks.flat(), items);
    for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 1024);
    }
});

test("restore schema rejects malformed snowflakes and accepts serialized guild data", () => {
    const valid = {
        guild: { id: "111111111111111111" },
        roles: [{ id: "222222222222222222", name: "Role" }],
        channels: [{
            id: "333333333333333333",
            name: "general",
            parentId: null,
            permissionOverwrites: [{ id: "222222222222222222" }]
        }]
    };
    assert.equal(utility._test.isValidSnapshotSchema(valid), true);
    assert.equal(utility._test.isValidSnapshotSchema({ ...valid, guild: { id: "$ne" } }), false);
});

test("snapshot loader keeps legacy compatibility and rejects incomplete chunk pointers", async () => {
    const legacy = { roles: [], channels: [], schemaVersion: 1 };
    assert.deepEqual(await sessionManager.loadSnapshotData({ storageMode: "legacy", data: legacy }), legacy);
    assert.equal(await sessionManager.loadSnapshotData({
        storageMode: "chunked",
        complete: false,
        chunkMeta: {},
        data: {}
    }), null);
});

test("snapshot history schema keeps one additive active pointer without deleting versions", () => {
    const { SnapshotModel, getLatestSnapshotForGuild, reconcileSnapshotPointers } = sessionManager;
    assert.ok(SnapshotModel.schema.path("active"));
    assert.ok(SnapshotModel.schema.path("activationPending"));
    assert.ok(SnapshotModel.schema.path("supersededAt"));
    assert.ok(SnapshotModel.schema.path("supersededBy"));
    const activeIndex = SnapshotModel.schema.indexes().find(([keys]) => keys.guildId === 1);
    assert.ok(activeIndex);
    assert.equal(activeIndex[1].unique, true);
    assert.deepEqual(activeIndex[1].partialFilterExpression, { active: true });
    assert.equal(typeof getLatestSnapshotForGuild, "function");
    assert.equal(typeof reconcileSnapshotPointers, "function");
});
