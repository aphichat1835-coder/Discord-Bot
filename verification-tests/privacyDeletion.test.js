"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    buildOAuthUserPrivacyUpdate,
    redactArchivedOAuthPayload,
    runMemberPrivacyDeletion
} = require("../discord/verification/services/privacyDeletion");

function queryResult(value) {
    return {
        select() { return this; },
        session() { return this; },
        lean: async () => value
    };
}

function writeResult(count = 1) {
    return { acknowledged: true, modifiedCount: count, deletedCount: count, matchedCount: count };
}

function createModel(overrides = {}) {
    return {
        create: async () => ({}),
        updateOne: async () => writeResult(),
        updateMany: async () => writeResult(),
        deleteMany: async () => writeResult(),
        countDocuments: async () => 0,
        find: () => queryResult([]),
        findOne: () => queryResult(null),
        ...overrides
    };
}

function createModels(overrides = {}) {
    const base = {
        VerifyLog: createModel(),
        OAuthUser: createModel(),
        IpIdentityLink: createModel(),
        IpIdentityUserHistory: createModel(),
        IpIdentityDeviceHistory: createModel(),
        IpIdentityRoleHistory: createModel(),
        OAuthMemberSnapshot: createModel(),
        OAuthMemberRoleSnapshot: createModel(),
        OAuthObjectChunkSnapshot: createModel(),
        OAuthSnapshotRecovery: createModel(),
        VerificationMigrationArchive: createModel(),
        VerificationRecovery: createModel(),
        PrivacyDeletionJob: createModel()
    };
    return { ...base, ...overrides };
}

function fakeMongoose() {
    return {
        async startSession() {
            return {
                async withTransaction(operation) { return operation(); },
                async endSession() {}
            };
        }
    };
}

test("OAuth member deletion removes only guild-scoped state", () => {
    const update = buildOAuthUserPrivacyUpdate({
        lastMember: { guildId: "guild-a" },
        lastVerify: { guildId: "guild-a" },
        snapshotRefs: {
            profile: { version: "global-profile" },
            guilds: { version: "global-guilds" },
            connections: { version: "global-connections" },
            member: { guildId: "guild-a", version: "member-a" },
            snapshotSet: { version: "set-a" }
        }
    }, "guild-a", 123);

    assert.deepEqual(update.$pull, { guilds: { id: "guild-a" } });
    assert.equal(update.$unset.lastMember, "");
    assert.equal(update.$unset.lastVerify, "");
    assert.equal(update.$unset.lastIpTracking, "");
    assert.equal(update.$unset["snapshotRefs.member"], "");
    assert.equal(update.$unset["snapshotRefs.snapshotSet"], "");
    assert.equal(Object.hasOwn(update.$unset, "snapshotRefs.profile"), false);
    assert.equal(Object.hasOwn(update.$unset, "snapshotRefs.guilds"), false);
    assert.equal(Object.hasOwn(update.$unset, "snapshotRefs.connections"), false);
});

test("migration archive redaction preserves other guilds and global snapshots", () => {
    const source = {
        guilds: [{ id: "guild-a" }, { id: "guild-b" }],
        lastMember: { guildId: "guild-a", nick: "private" },
        lastVerify: { guildId: "guild-a" },
        lastIpTracking: { ipHash: "private" },
        snapshotRefs: {
            profile: { version: "profile" },
            member: { guildId: "guild-a", version: "member" },
            snapshotSet: { version: "set" }
        },
        snapshotMeta: { member: { storedCount: 1 }, activation: { snapshotVersion: "set" } }
    };
    const result = redactArchivedOAuthPayload(source, { guildId: "guild-a", now: 500 });

    assert.equal(result.changed, true);
    assert.deepEqual(result.payload.guilds, [{ id: "guild-b" }]);
    assert.equal(result.payload.lastMember, undefined);
    assert.equal(result.payload.lastVerify, undefined);
    assert.equal(result.payload.lastIpTracking, undefined);
    assert.deepEqual(result.payload.snapshotRefs.profile, { version: "profile" });
    assert.equal(result.payload.snapshotRefs.member, undefined);
    assert.equal(result.payload.snapshotMeta.member, undefined);
    assert.deepEqual(source.guilds, [{ id: "guild-a" }, { id: "guild-b" }]);
});

test("privacy deletion redacts logs and deletes only matching member snapshot versions", async () => {
    const verifyUpdates = [];
    const roleDeletes = [];
    const oauthUpdates = [];
    const jobUpdates = [];
    const models = createModels({
        VerifyLog: createModel({
            updateMany: async (_filter, update) => {
                verifyUpdates.push(update);
                return writeResult(2);
            }
        }),
        OAuthMemberSnapshot: createModel({
            find: () => queryResult([{ snapshotVersion: "member-version-a" }]),
            deleteMany: async () => writeResult(1)
        }),
        OAuthMemberRoleSnapshot: createModel({
            deleteMany: async filter => {
                roleDeletes.push(filter);
                return writeResult(3);
            }
        }),
        OAuthUser: createModel({
            findOne: () => queryResult({
                _id: "oauth-id",
                lastMember: { guildId: "guild-a" },
                lastVerify: { guildId: "guild-a" },
                snapshotRefs: {
                    profile: { version: "profile-version" },
                    member: { guildId: "guild-a", version: "member-version-a" }
                }
            }),
            updateOne: async (_filter, update) => {
                oauthUpdates.push(update);
                return writeResult(1);
            }
        }),
        PrivacyDeletionJob: createModel({
            updateOne: async (_filter, update) => {
                jobUpdates.push(update);
                return writeResult(1);
            }
        })
    });

    const result = await runMemberPrivacyDeletion({
        guildId: "guild-a",
        userId: "111111111111111111",
        requestedBy: "owner",
        now: 1000,
        models,
        mongooseInstance: fakeMongoose()
    });

    assert.equal(result.success, true);
    assert.equal(result.manifest.scope, "guild_member");
    assert.equal(result.manifest.preservedGlobalSnapshots, true);
    assert.deepEqual(roleDeletes[0], {
        userId: "111111111111111111",
        snapshotVersion: { $in: ["member-version-a"] }
    });
    assert.equal(verifyUpdates[0].$set.reason, "privacy_deleted");
    assert.equal(verifyUpdates[0].$unset.ipInfo, "");
    assert.equal(oauthUpdates[0].$unset["snapshotRefs.member"], "");
    assert.equal(Object.hasOwn(oauthUpdates[0].$unset, "snapshotRefs.profile"), false);
    assert.ok(jobUpdates.some(update => update.$set?.status === "completed"));
});

test("privacy deletion fails closed when a guild-scoped reference remains", async () => {
    const jobUpdates = [];
    const models = createModels({
        OAuthMemberSnapshot: createModel({
            find: () => queryResult([]),
            countDocuments: async () => 1
        }),
        PrivacyDeletionJob: createModel({
            updateOne: async (_filter, update) => {
                jobUpdates.push(update);
                return writeResult(1);
            }
        })
    });

    await assert.rejects(
        runMemberPrivacyDeletion({
            guildId: "guild-a",
            userId: "111111111111111111",
            requestedBy: "owner",
            models,
            mongooseInstance: fakeMongoose()
        }),
        error => error?.code === "PRIVACY_DELETION_INCOMPLETE"
    );
    assert.ok(jobUpdates.some(update => update.$set?.status === "failed"));
});
