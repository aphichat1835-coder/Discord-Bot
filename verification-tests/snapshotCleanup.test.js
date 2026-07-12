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
        expect(JSON.stringify(orphanDelete)).toContain("orphan-version");
        expect(JSON.stringify(orphanDelete)).not.toContain("kept-version");
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

    test("explicit zero cleanup values use safe floors instead of defaults", () => {
        expect(_test.boundedNumber(0, 24, 1)).toBe(1);
        expect(_test.boundedNumber(0, 200, 10, 1000)).toBe(10);
        expect(_test.boundedNumber("invalid", 200, 10, 1000)).toBe(200);
    });
});
