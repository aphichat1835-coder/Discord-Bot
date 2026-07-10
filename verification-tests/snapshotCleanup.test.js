"use strict";

const {
    cleanupSnapshotGarbage,
    _test
} = require("../discord/verification/services/snapshotCleanup");

function queryResult(value, rejected = null) {
    return {
        where: jest.fn().mockReturnThis(),
        gt: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: rejected
            ? jest.fn().mockRejectedValue(rejected)
            : jest.fn().mockResolvedValue(value)
    };
}

function snapshotModel(candidates = []) {
    return {
        find: jest.fn(() => queryResult(candidates)),
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

    test("reference traversal includes nested member-role versions", () => {
        expect([..._test.referencedVersions({
            member: {
                version: "member-version",
                roleRef: { version: "roles-version" }
            }
        })]).toEqual(["member-version", "roles-version"]);
    });
});
