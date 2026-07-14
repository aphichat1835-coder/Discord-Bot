"use strict";

const {
    cleanupSnapshotGarbage,
    _test
} = require("../discord/verification/services/snapshotCleanup");

function queryResult(value, rejected = null) {
    let resultLimit = null;
    const query = {
        where: jest.fn().mockReturnThis(),
        gt: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn(limit => {
            resultLimit = limit;
            return query;
        }),
        lean: rejected
            ? jest.fn().mockRejectedValue(rejected)
            : jest.fn(async () => resultLimit === null ? value : value.slice(0, resultLimit))
    };
    return query;
}

function snapshotModel(candidates = []) {
    const documents = candidates.map((candidate, index) => ({
        _id: candidate._id || `snapshot-${index + 1}`,
        ...candidate
    }));
    return {
        find: jest.fn(() => queryResult(documents)),
        countDocuments: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 })
    };
}

function referenceModel(documents = [], rejected = null) {
    return {
        find: jest.fn(() => queryResult(documents, rejected))
    };
}

function filteringSnapshotModel({ complete = [], incomplete = [] } = {}) {
    const withIds = (items, prefix) => items.map((item, index) => ({
        _id: item._id || `${prefix}-${index + 1}`,
        ...item
    }));
    const completeDocs = withIds(complete, "complete");
    const incompleteDocs = withIds(incomplete, "incomplete");
    const selectDocs = filter => filter?.complete === true ? completeDocs : incompleteDocs;
    return {
        find: jest.fn(filter => queryResult(selectDocs(filter))),
        countDocuments: jest.fn(filter => Promise.resolve(selectDocs(filter).length)),
        deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 })
    };
}

describe("permanent-history snapshot garbage cleanup", () => {
    test("keeps every OAuthUser-referenced version and removes only unreferenced versions", async () => {
        const Model = snapshotModel([
            { userId: "12345678901234567", snapshotVersion: "kept-version" },
            { userId: "12345678901234567", snapshotVersion: "orphan-version" }
        ]);
        Model.deleteMany
            .mockResolvedValueOnce({ deletedCount: 2 })
            .mockResolvedValueOnce({ deletedCount: 3 });
        const OAuthUserModel = referenceModel([{
            discord: { userId: "12345678901234567" },
            snapshotRefs: { profile: { version: "kept-version", complete: true } }
        }]);
        const VerifyLogModel = referenceModel([]);

        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            scanMax: 10,
            models: { profile: Model },
            OAuthUserModel,
            VerifyLogModel
        });

        expect(summary).toMatchObject({
            mode: "permanent_history",
            referencedVersionsKept: 1,
            orphanVersions: 1,
            incompleteDocuments: 2,
            orphanDocuments: 3
        });
        const orphanDelete = Model.deleteMany.mock.calls[1][0];
        expect(orphanDelete).toEqual({ complete: true, _id: { $in: ["snapshot-2"] } });
    });

    test("keeps versions referenced by historical VerifyLog documents", async () => {
        const Model = snapshotModel([
            { userId: "12345678901234567", snapshotVersion: "history-version" }
        ]);
        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { guilds: Model },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([{
                userId: "12345678901234567",
                snapshotVersion: "history-version",
                deletedAt: 1
            }])
        });

        expect(summary.referencedVersionsKept).toBe(1);
        expect(summary.orphanVersions).toBe(0);
        expect(Model.deleteMany).toHaveBeenCalledTimes(1);
    });

    test("dry-run reports garbage without deleting documents", async () => {
        const Model = snapshotModel([
            { userId: "12345678901234567", snapshotVersion: "orphan-version" }
        ]);
        Model.countDocuments
            .mockResolvedValueOnce(4)
            .mockResolvedValueOnce(5);
        const summary = await cleanupSnapshotGarbage({
            dryRun: true,
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { member: Model },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        expect(summary.incompleteDocuments).toBe(4);
        expect(summary.orphanDocuments).toBe(5);
        expect(Model.deleteMany).not.toHaveBeenCalled();
    });

    test("reference lookup failure aborts before any deletion", async () => {
        const Model = snapshotModel([
            { userId: "12345678901234567", snapshotVersion: "candidate-version" }
        ]);
        await expect(cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { connections: Model },
            OAuthUserModel: referenceModel([], new Error("reference lookup failed")),
            VerifyLogModel: referenceModel([])
        })).rejects.toThrow("reference lookup failed");
        expect(Model.deleteMany).not.toHaveBeenCalled();
    });

    test("rechecks references immediately before deleting orphan candidates", async () => {
        const Model = snapshotModel([
            { userId: "12345678901234567", snapshotVersion: "newly-referenced" }
        ]);
        let reads = 0;
        const OAuthUserModel = {
            find: jest.fn(() => queryResult(reads++ === 0 ? [] : [{
                discord: { userId: "12345678901234567" },
                snapshotRefs: { profile: { version: "newly-referenced" } }
            }]))
        };

        await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { profile: Model },
            OAuthUserModel,
            VerifyLogModel: referenceModel([])
        });

        expect(Model.deleteMany).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(Model.deleteMany.mock.calls[0][0])).not.toContain("newly-referenced");
    });

    test("deletes orphan snapshots only from their originating model and id", async () => {
        const ProfileModel = snapshotModel([{
            _id: "stale-profile",
            userId: "12345678901234567",
            snapshotVersion: "shared-version"
        }]);
        const GuildModel = snapshotModel([]);
        ProfileModel.deleteMany
            .mockResolvedValueOnce({ deletedCount: 0 })
            .mockResolvedValueOnce({ deletedCount: 1 });

        await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { profile: ProfileModel, guilds: GuildModel },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        expect(ProfileModel.deleteMany).toHaveBeenLastCalledWith({
            complete: true,
            _id: { $in: ["stale-profile"] }
        });
        expect(GuildModel.deleteMany).not.toHaveBeenCalled();
    });

    test("reference traversal includes nested member-role versions", () => {
        expect([..._test.referencedVersions({
            member: {
                version: "member-version",
                roleRef: { version: "roles-version" }
            }
        })]).toEqual(["member-version", "roles-version"]);
    });

    test("incomplete snapshot deletion is bounded by the per-model batch", async () => {
        const Model = snapshotModel(Array.from({ length: 12 }, (_, index) => ({
            _id: `incomplete-${index}`,
            userId: "12345678901234567",
            snapshotVersion: `version-${index}`
        })));
        Model.deleteMany.mockResolvedValue({ deletedCount: 2 });

        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            scanMax: 0,
            models: { profile: Model },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        const incompleteDelete = Model.deleteMany.mock.calls[0][0];
        expect(incompleteDelete._id.$in).toHaveLength(10);
        expect(summary.scanMax).toBe(10);
        expect(summary.byModel.profile.incompleteBatchSize).toBe(10);
    });

    test("default cleanup lifecycle includes object chunk snapshots", () => {
        expect(_test.DEFAULT_MODELS.objectChunks).toBeDefined();
    });

    test("keeps object chunks referenced by OAuthUser snapshotRefs or VerifyLog history", async () => {
        const ObjectChunkModel = filteringSnapshotModel({
            complete: [
                {
                    _id: "object-active",
                    userId: "12345678901234567",
                    snapshotVersion: "active-object-version"
                },
                {
                    _id: "object-history",
                    userId: "12345678901234567",
                    snapshotVersion: "history-object-version"
                }
            ]
        });

        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { objectChunks: ObjectChunkModel },
            OAuthUserModel: referenceModel([{
                discord: { userId: "12345678901234567" },
                snapshotRefs: {
                    profile: {
                        version: "active-object-version",
                        format: "json-base64-chunks-v1",
                        complete: true
                    }
                }
            }]),
            VerifyLogModel: referenceModel([{
                userId: "12345678901234567",
                snapshotRef: {
                    member: {
                        version: "history-object-version",
                        format: "json-base64-chunks-v1",
                        complete: true
                    }
                }
            }])
        });

        expect(summary.referencedVersionsKept).toBe(2);
        expect(summary.orphanVersions).toBe(0);
        expect(ObjectChunkModel.deleteMany).not.toHaveBeenCalled();
    });

    test("deletes stale incomplete object chunks after the grace period", async () => {
        const ObjectChunkModel = filteringSnapshotModel({
            incomplete: [{
                _id: "object-incomplete",
                userId: "12345678901234567",
                snapshotVersion: "incomplete-version"
            }]
        });
        ObjectChunkModel.deleteMany.mockResolvedValueOnce({ deletedCount: 1 });

        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { objectChunks: ObjectChunkModel },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        expect(summary.byModel.objectChunks.incomplete).toBe(1);
        expect(ObjectChunkModel.deleteMany).toHaveBeenCalledWith({
            _id: { $in: ["object-incomplete"] }
        });
    });

    test("deletes complete object chunks only when no active or historical reference remains", async () => {
        const ObjectChunkModel = filteringSnapshotModel({
            complete: [{
                _id: "object-orphan",
                userId: "12345678901234567",
                snapshotVersion: "orphan-object-version"
            }]
        });
        ObjectChunkModel.deleteMany.mockResolvedValueOnce({ deletedCount: 1 });

        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { objectChunks: ObjectChunkModel },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        expect(summary.orphanVersions).toBe(1);
        expect(summary.byModel.objectChunks.orphaned).toBe(1);
        expect(ObjectChunkModel.deleteMany).toHaveBeenCalledWith({
            complete: true,
            _id: { $in: ["object-orphan"] }
        });
    });

    test("object chunk cleanup dry-run reports candidates without deleting", async () => {
        const ObjectChunkModel = filteringSnapshotModel({
            complete: [{
                _id: "object-dry-orphan",
                userId: "12345678901234567",
                snapshotVersion: "dry-orphan-version"
            }],
            incomplete: [{
                _id: "object-dry-incomplete",
                userId: "12345678901234567",
                snapshotVersion: "dry-incomplete-version"
            }]
        });

        const summary = await cleanupSnapshotGarbage({
            dryRun: true,
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { objectChunks: ObjectChunkModel },
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        expect(summary.byModel.objectChunks).toMatchObject({
            incomplete: 1,
            orphaned: 1
        });
        expect(ObjectChunkModel.deleteMany).not.toHaveBeenCalled();
    });

    test("retries persisted rollback recovery metadata during a later cleanup run", async () => {
        const RecoveryModel = referenceModel([{
            userId: "12345678901234567",
            snapshotVersion: "recovery-version"
        }]);
        const rollbackFn = jest.fn().mockResolvedValue({ complete: true });
        const Model = filteringSnapshotModel();

        const summary = await cleanupSnapshotGarbage({
            now: 2 * 60 * 60 * 1000,
            graceHours: 1,
            models: { profile: Model },
            RecoveryModel,
            rollbackFn,
            OAuthUserModel: referenceModel([]),
            VerifyLogModel: referenceModel([])
        });

        expect(summary.recovery).toMatchObject({
            scanned: 1,
            completed: 1,
            pending: 0,
            dryRun: false
        });
        expect(rollbackFn).toHaveBeenCalledWith(expect.objectContaining({
            userId: "12345678901234567",
            version: "recovery-version",
            RecoveryModel
        }));
    });

    test("explicit zero cleanup values use safe floors instead of defaults", () => {
        expect(_test.boundedNumber(0, 24, 1)).toBe(1);
        expect(_test.boundedNumber(0, 200, 10, 1000)).toBe(10);
        expect(_test.boundedNumber("invalid", 200, 10, 1000)).toBe(200);
    });
});

test("recovery cleanup selects only records whose nextRetryAt is due", async () => {
    const filterSeen = [];
    const RecoveryModel = {
        find: jest.fn(filter => {
            filterSeen.push(filter);
            return queryResult([{ userId: "u1", snapshotVersion: "v1", nextRetryAt: 900 }]);
        })
    };
    const rollbackFn = jest.fn().mockResolvedValue({ complete: true });
    const result = await _test.processRecoveryQueue({
        dryRun: false,
        scanMax: 10,
        RecoveryModel,
        rollbackFn,
        now: 1000
    });
    expect(result.completed).toBe(1);
    expect(filterSeen[0]).toEqual({
        complete: { $ne: true },
        $or: [
            { nextRetryAt: { $exists: false } },
            { nextRetryAt: null },
            { nextRetryAt: { $lte: 1000 } }
        ]
    });
});
