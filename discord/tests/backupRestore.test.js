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


test("backup sorting does not mutate live Discord manager cache order", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const cache = new Collection([
        ["role-high", { id: "role-high", position: 10 }],
        ["role-low", { id: "role-low", position: 1 }]
    ]);
    const before = Array.from(cache.keys());
    const sorted = utility._test.sortedCollectionValues(cache, (a, b) => a.position - b.position);
    assert.deepEqual(sorted.map(item => item.id), ["role-low", "role-high"]);
    assert.deepEqual(Array.from(cache.keys()), before);
});

test("backup webhook events contain bounded operational metadata", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = {
        guild: { id: "111111111111111111", iconURL: () => null },
        user: { id: "222222222222222222", displayAvatarURL: () => null }
    };
    const success = utility._test.buildBackupCreatedEvent(interaction, "snapshot-1", {
        schemaVersion: 2, roles: [{}, {}], channels: [{}]
    }, 15);
    const failure = utility._test.buildBackupFailedEvent(interaction, new Error("database unavailable"), 20);
    assert.equal(success.code, "backup.created");
    assert.equal(success.context.Roles, 2);
    assert.equal(success.context.Channels, 1);
    assert.equal(failure.code, "backup.failed");
    assert.equal(failure.target, "ALERT");
    assert.match(failure.description, /database unavailable/);
});

test("restore planner skips existing and unsupported channels without counting unapplied overwrites", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const guildId = "111111111111111111";
    const roleId = "222222222222222222";
    const guild = {
        id: guildId,
        roles: {
            cache: new Collection([[roleId, { id: roleId, name: "Existing Role" }]]),
            everyone: { id: guildId, name: "@everyone" }
        },
        members: { cache: new Collection() },
        channels: {
            cache: new Collection([
                ["333333333333333333", {
                    id: "333333333333333333",
                    name: "general",
                    type: ChannelType.GuildText,
                    parentId: null
                }]
            ])
        }
    };

    const plan = utility._test.buildRestorePlan(guild, {
        roles: [{ id: roleId, name: "Existing Role", managed: false }],
        channels: [
            {
                id: "444444444444444444",
                name: "general",
                type: ChannelType.GuildText,
                parentId: null,
                permissionOverwrites: [{ id: roleId, type: "role", allow: "1024", deny: "0" }]
            },
            {
                id: "555555555555555555",
                name: "thread-copy",
                type: ChannelType.PublicThread,
                parentId: null,
                permissionOverwrites: [{ id: roleId, type: "role", allow: "1024", deny: "0" }]
            }
        ]
    }, guildId);

    assert.equal(plan.channelsToCreate, 0);
    assert.equal(plan.channelsSkipped, 2);
    assert.equal(plan.overwritesRestored, 0);
    assert.equal(plan.overwritesSkippedRoleMissing, 0);
});

test("restore overwrite resolution reports usable and missing targets without mutating aggregate state", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const guildId = "111111111111111111";
    const mappedRole = "222222222222222222";
    const existingMember = "333333333333333333";
    const missingRole = "444444444444444444";
    const missingMember = "555555555555555555";
    const guild = {
        id: guildId,
        roles: { cache: new Collection() },
        members: { cache: new Collection([[existingMember, { id: existingMember }]]) }
    };
    const roleIdMap = new Map([["666666666666666666", mappedRole]]);
    const channel = {
        permissionOverwrites: [
            { id: guildId, type: "role", allow: "1024", deny: "0" },
            { id: "666666666666666666", type: "role", allow: "2048", deny: "0" },
            { id: existingMember, type: "member", allow: "0", deny: "4096" },
            { id: missingRole, type: "role", allow: "0", deny: "8192" },
            { id: missingMember, type: "member", allow: "0", deny: "16384" }
        ]
    };

    const resolved = utility._test.buildResolvedOverwrites(guild, channel, roleIdMap, guildId);
    assert.equal(resolved.overwrites.length, 3);
    assert.deepEqual(resolved.stats, {
        restored: 3,
        skippedRoleMissing: 1,
        skippedMemberMissing: 1
    });
    assert.equal(resolved.overwrites[0].id, guildId);
    assert.equal(resolved.overwrites[0].allow, 1024n);
    assert.equal(resolved.overwrites[2].id, existingMember);

    const aggregate = { restored: 0, skippedRoleMissing: 0, skippedMemberMissing: 0 };
    utility._test.addOverwriteStats(aggregate, resolved.stats, { includeRestored: false });
    assert.deepEqual(aggregate, {
        restored: 0,
        skippedRoleMissing: 1,
        skippedMemberMissing: 1
    });
});
