const assert = require("node:assert/strict");
const test = require("node:test");
const { ChannelType, Collection } = require("discord.js");

const sessionManager = require("../sessionManager");
const utility = require("../commands/utility");

test("snapshot chunker preserves every item while bounding each chunk", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const items = Array.from({ length: 50 }, (_, index) => ({ id: String(index), value: "x".repeat(120) }));
    const chunks = sessionManager.chunkSnapshotItems(items, 1024);
    assert.deepEqual(chunks.flat(), items);
    for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 1024);
    }
});

test("restore schema rejects malformed snowflakes and accepts serialized guild data", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const valid = {
        guild: { id: "111111111111111111" },
        roles: [{ id: "222222222222222222", name: "Role" }],
        channels: [{
            id: "333333333333333333",
            name: "general",
            parentId: null,
            permissionOverwrites: [{ id: "222222222222222222", type: "role", allow: "0", deny: "0" }]
        }]
    };
    assert.equal(utility._test.isValidSnapshotSchema(valid), true);
    const numericTypes = {
        ...valid,
        channels: [{
            ...valid.channels[0],
            permissionOverwrites: [
                { id: "222222222222222222", type: 0, allow: "0", deny: "0" },
                { id: "444444444444444444", type: 1, allow: "0", deny: "0" }
            ]
        }]
    };
    assert.equal(utility._test.isValidSnapshotSchema(numericTypes), true);
    assert.equal(utility._test.normalizeOverwriteType(0), "role");
    assert.equal(utility._test.normalizeOverwriteType(1), "member");
    assert.equal(utility._test.normalizeSnapshotChannelType(0), "GUILD_TEXT");
    assert.equal(utility._test.normalizeSnapshotChannelType(4), "GUILD_CATEGORY");
    assert.equal(utility._test.normalizeSnapshotChannelType("GUILD_VOICE"), "GUILD_VOICE");
    assert.deepEqual(
        utility._test.normalizeSnapshotChannels([{ id: "333333333333333333", type: 4 }]),
        [{ id: "333333333333333333", type: "GUILD_CATEGORY" }]
    );
    assert.equal(utility._test.isValidSnapshotSchema({ ...valid, guild: { id: "$ne" } }), false);

    assert.equal(utility._test.isValidSnapshotSchema({
        ...valid,
        channels: [{ ...valid.channels[0], permissionOverwrites: {} }]
    }), false);
    assert.equal(utility._test.isValidSnapshotSchema({
        ...valid,
        channels: [{
            ...valid.channels[0],
            permissionOverwrites: [{ id: "222222222222222222", type: "role", allow: "invalid", deny: "0" }]
        }]
    }), false);
    assert.equal(utility._test.isValidSnapshotSchema({
        ...valid,
        channels: [{
            ...valid.channels[0],
            permissionOverwrites: [{ id: "222222222222222222", type: "unknown", allow: "0", deny: "0" }]
        }]
    }), false);
});

test("restore private-delivery failure builds a structured operational event", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const event = utility._test.buildRestoreDeliveryFailureEvent({
        id: "555555555555555555",
        guild: { id: "111111111111111111", iconURL: () => null },
        user: { id: "222222222222222222", displayAvatarURL: () => null }
    });

    assert.equal(event.target, "LOG");
    assert.equal(event.severity, "WARNING");
    assert.equal(event.category, "BACKUP");
    assert.equal(event.code, "restore.result.private_delivery_failed");
    assert.equal(event.context["Guild ID"], "111111111111111111");
    assert.equal(event.context["User ID"], "222222222222222222");
});

test("restore planning maps numeric category parents before matching child channels", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldCategoryId = "333333333333333333";
    const currentCategoryId = "444444444444444444";
    const guild = {
        id: "111111111111111111",
        roles: { cache: new Collection(), everyone: null },
        members: { cache: new Collection() },
        channels: { cache: new Collection([
            [currentCategoryId, { id: currentCategoryId, name: "Category", type: ChannelType.GuildCategory, parentId: null }],
            ["555555555555555555", { id: "555555555555555555", name: "general", type: ChannelType.GuildText, parentId: currentCategoryId }]
        ]) }
    };
    const plan = utility._test.buildRestorePlan(guild, {
        roles: [],
        channels: [
            { id: oldCategoryId, name: "Category", type: ChannelType.GuildCategory, parentId: null, permissionOverwrites: [] },
            { id: "666666666666666666", name: "general", type: ChannelType.GuildText, parentId: oldCategoryId, permissionOverwrites: [] }
        ]
    }, guild.id);

    assert.equal(plan.channelsToCreate, 0);
    assert.equal(plan.channelsAmbiguous, 0);
});

test("snapshot loader keeps legacy compatibility and rejects incomplete chunk pointers", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const legacy = { roles: [], channels: [], schemaVersion: 1 };
    assert.deepEqual(await sessionManager.loadSnapshotData({ storageMode: "legacy", data: legacy }), legacy);
    assert.equal(await sessionManager.loadSnapshotData({
        storageMode: "chunked",
        complete: false,
        chunkMeta: {},
        data: {}
    }), null);
});

test("snapshot history schema keeps one additive active pointer without deleting versions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("restore snapshot identity binds payload, metadata, and preview target guild", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const backup = {
        guildId: "111111111111111111",
    };
    const data = { guild: { id: "111111111111111111" } };
    assert.equal(utility._test.snapshotIdentityMatches(backup, data, "111111111111111111"), true);
    assert.equal(utility._test.snapshotIdentityMatches(backup, data, "222222222222222222"), false);
    assert.equal(utility._test.snapshotIdentityMatches(
        backup,
        { guild: { id: "222222222222222222" } }
    ), false);
});
