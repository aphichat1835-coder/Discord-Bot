"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    buildOAuthUserPrivacyUpdate,
    createManifest,
    deletionOperationKey,
    redactArchivedOAuthPayload,
    runMemberPrivacyDeletion,
    totalDeletionCount
} = require("../discord/verification/services/privacyDeletion");

function queryResult(value) {
    return {
        select() { return this; },
        session() { return this; },
        sort() { return this; },
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

function fakeMongoose(options = {}) {
    return {
        async startSession() {
            if (options.startError) throw options.startError;
            return {
                async withTransaction(operation) { return operation(); },
                async endSession() {
                    if (options.endError) throw options.endError;
                }
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

test("privacy manifest separates metadata, counters, and verification evidence", () => {
    const manifest = createManifest();
    manifest.counts = { logs: 2, snapshots: 3, ignored: -1 };
    manifest.deletedCount = totalDeletionCount(manifest.counts);

    assert.equal(manifest.schema, "privacy-deletion-v3");
    assert.equal(manifest.metadata.preservedGlobalSnapshots, true);
    assert.equal(manifest.deletedCount, 5);
    const legacyRouteStyleTotal = Object.values(manifest)
        .filter(value => Number.isFinite(Number(value)))
        .reduce((sum, value) => sum + Number(value), 0);
    assert.equal(legacyRouteStyleTotal, manifest.deletedCount);
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
            updateOne: async (_filter, update, options) => {
                jobUpdates.push({ update, options });
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
    assert.equal(result.manifest.metadata.preservedGlobalSnapshots, true);
    assert.equal(result.manifest.verification.remainingReferences, 0);
    assert.equal(result.manifest.counts.verifyLogsRedacted, 2);
    assert.equal(result.manifest.counts.memberRoleSnapshots, 3);
    assert.equal(result.manifest.deletedCount, totalDeletionCount(result.manifest.counts));
    assert.deepEqual(roleDeletes[0], {
        userId: "111111111111111111",
        snapshotVersion: { $in: ["member-version-a"] }
    });
    assert.equal(verifyUpdates[0].$set.reason, "privacy_deleted");
    assert.equal(verifyUpdates[0].$unset.ipInfo, "");
    assert.equal(oauthUpdates[0].$unset["snapshotRefs.member"], "");
    assert.equal(Object.hasOwn(oauthUpdates[0].$unset, "snapshotRefs.profile"), false);
    const completed = jobUpdates.find(entry => entry.update.$set?.status === "completed");
    assert.ok(completed);
    assert.ok(completed.options?.session);
});

test("privacy deletion fails closed when any guild-scoped reference remains", async () => {
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
    assert.equal(jobUpdates.some(update => update.$set?.status === "completed"), false);
    assert.ok(jobUpdates.some(update => update.$set?.status === "failed"));
});

test("privacy deletion records startSession failures without dereferencing a missing session", async () => {
    const jobUpdates = [];
    const startError = Object.assign(new Error("session unavailable"), { code: "SESSION_UNAVAILABLE" });
    const models = createModels({
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
            mongooseInstance: fakeMongoose({ startError })
        }),
        error => error === startError
    );
    assert.ok(jobUpdates.some(update => update.$set?.status === "failed"));
});

test("endSession failure never replaces the primary deletion error", async () => {
    const models = createModels({
        OAuthMemberSnapshot: createModel({
            find: () => queryResult([]),
            countDocuments: async () => 1
        })
    });
    const endError = new Error("end session failed");

    await assert.rejects(
        runMemberPrivacyDeletion({
            guildId: "guild-a",
            userId: "111111111111111111",
            requestedBy: "owner",
            models,
            mongooseInstance: fakeMongoose({ endError })
        }),
        error => {
            assert.equal(error.code, "PRIVACY_DELETION_INCOMPLETE");
            assert.equal(error.endSessionError, "end session failed");
            return true;
        }
    );
});

test("completion persistence failure prevents a successful deletion result", async () => {
    const jobUpdates = [];
    const completionError = Object.assign(new Error("job completion write failed"), { code: "COMPLETION_WRITE_FAILED" });
    const models = createModels({
        PrivacyDeletionJob: createModel({
            updateOne: async (_filter, update) => {
                jobUpdates.push(update);
                if (update.$set?.status === "completed") throw completionError;
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
        error => error === completionError
    );
    assert.ok(jobUpdates.some(update => update.$set?.status === "failed"));
});

test("privacy deletion reuses an active job without starting another transaction", async () => {
    let created = 0;
    let sessionsStarted = 0;
    const activeJob = {
        jobId: "active-job",
        status: "running",
        updatedAt: 9_900,
        attempt: 1,
        manifest: createManifest()
    };
    const models = createModels({
        PrivacyDeletionJob: createModel({
            findOne: () => queryResult(activeJob),
            create: async () => { created++; }
        })
    });
    const result = await runMemberPrivacyDeletion({
        guildId: "guild-a",
        userId: "111111111111111111",
        requestedBy: "owner",
        now: 10_000,
        models,
        mongooseInstance: { async startSession() { sessionsStarted++; throw new Error("must not start"); } }
    });

    assert.equal(result.jobId, "active-job");
    assert.equal(result.reused, true);
    assert.equal(result.pending, true);
    assert.equal(result.status, "running");
    assert.equal(created, 0);
    assert.equal(sessionsStarted, 0);
});

test("privacy deletion reuses a recently completed result", async () => {
    const manifest = createManifest();
    manifest.deletedCount = 7;
    const completed = {
        jobId: "completed-job",
        status: "completed",
        updatedAt: 9_800,
        completedAt: 9_800,
        attempt: 1,
        manifest
    };
    const models = createModels({
        PrivacyDeletionJob: createModel({ findOne: () => queryResult(completed) })
    });
    const result = await runMemberPrivacyDeletion({
        guildId: "guild-a",
        userId: "111111111111111111",
        requestedBy: "owner",
        now: 10_000,
        completedReuseMs: 500,
        models,
        mongooseInstance: { async startSession() { throw new Error("must not start"); } }
    });

    assert.equal(result.jobId, "completed-job");
    assert.equal(result.reused, true);
    assert.equal(result.pending, false);
    assert.equal(result.manifest.deletedCount, 7);
});

test("privacy deletion resolves a duplicate-key race to the winning active job", async () => {
    let reads = 0;
    const duplicate = Object.assign(new Error("duplicate active key"), { code: 11000 });
    const active = { jobId: "winner", status: "pending", updatedAt: 10_000, manifest: createManifest() };
    const models = createModels({
        PrivacyDeletionJob: createModel({
            findOne: () => queryResult(++reads === 1 ? null : active),
            create: async () => { throw duplicate; }
        })
    });
    const result = await runMemberPrivacyDeletion({
        guildId: "guild-a",
        userId: "111111111111111111",
        requestedBy: "owner",
        now: 10_000,
        models,
        mongooseInstance: { async startSession() { throw new Error("must not start"); } }
    });

    assert.equal(result.jobId, "winner");
    assert.equal(result.reused, true);
    assert.equal(reads, 2);
});

test("privacy deletion retries failed jobs with an incremented attempt", async () => {
    let createdJob = null;
    const failed = { jobId: "failed-job", status: "failed", updatedAt: 5_000, attempt: 2 };
    const models = createModels({
        PrivacyDeletionJob: createModel({
            findOne: () => queryResult(failed),
            create: async job => { createdJob = job; },
            updateOne: async () => writeResult(1)
        })
    });
    const result = await runMemberPrivacyDeletion({
        guildId: "guild-a",
        userId: "111111111111111111",
        requestedBy: "owner",
        now: 10_000,
        models,
        mongooseInstance: fakeMongoose()
    });

    assert.equal(result.success, true);
    assert.equal(result.reused, false);
    assert.equal(createdJob.attempt, 3);
    assert.equal(createdJob.activeKey, createdJob.operationKey);
});

test("privacy deletion marks stale active work failed before retrying", async () => {
    const updates = [];
    let createdJob = null;
    const stale = { jobId: "stale-job", status: "running", updatedAt: 1_000, attempt: 4 };
    const models = createModels({
        PrivacyDeletionJob: createModel({
            findOne: () => queryResult(stale),
            create: async job => { createdJob = job; },
            updateOne: async (filter, update) => {
                updates.push({ filter, update });
                return writeResult(1);
            }
        })
    });
    await runMemberPrivacyDeletion({
        guildId: "guild-a",
        userId: "111111111111111111",
        requestedBy: "owner",
        now: 20_000,
        staleJobMs: 5_000,
        models,
        mongooseInstance: fakeMongoose()
    });

    const staleUpdate = updates.find(item => item.update.$set?.errorCode === "PRIVACY_DELETION_STALE");
    assert.ok(staleUpdate);
    assert.equal(staleUpdate.update.$unset.activeKey, "");
    assert.equal(createdJob.attempt, 5);
});

test("privacy deletion operation keys isolate guild and member scope", () => {
    const first = deletionOperationKey("guild-a", "user-a");
    assert.notEqual(first, deletionOperationKey("guild-b", "user-a"));
    assert.notEqual(first, deletionOperationKey("guild-a", "user-b"));
    assert.equal(first, deletionOperationKey("guild-a", "user-a"));
});
