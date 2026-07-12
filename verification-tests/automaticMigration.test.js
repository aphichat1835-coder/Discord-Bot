"use strict";

const {
    runAutomaticMigration,
    contentHash,
    config,
    _test
} = require("../discord/verification/services/automaticMigration");
const { archiveSourceDocument } = require("../discord/verification/services/migrationArchive");
const { restoreCursor } = require("../scripts/restoreVerificationMigration");

function queryCursor(cursor = {}) {
    const chain = {
        select: jest.fn(() => chain),
        sort: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        lean: jest.fn(() => chain),
        cursor: jest.fn(() => cursor)
    };
    return chain;
}

function sourceModel(source, counts = [1, 0]) {
    return {
        collection: { name: "oauthusers" },
        countDocuments: jest.fn()
            .mockResolvedValueOnce(counts[0])
            .mockResolvedValueOnce(counts[1]),
        find: jest.fn(() => queryCursor({})),
        findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(source) })),
        bulkWrite: jest.fn()
    };
}

function stateModel() {
    return {
        findOneAndUpdate: jest.fn().mockResolvedValue({ _id: "state" }),
        updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
    };
}

describe("automatic verification migration backup", () => {
    test("configuration defaults to enabled and remains bounded", () => {
        expect(config({})).toMatchObject({ enabled: true, scanMax: 200, batchSize: 100 });
        expect(config({ AUTO_VERIFICATION_MIGRATION: "false" }).enabled).toBe(false);
    });

    test("content hashes are stable for unchanged source data", () => {
        const source = { _id: "user-1", discord: { userId: "123" } };
        expect(contentHash(source)).toBe(contentHash(source));
    });

    test("archive stores the full source once and reuses an existing backup", async () => {
        const source = { _id: "user-1", discord: { userId: "123" }, oauth: { encryptedAccessToken: "encrypted" } };
        const OAuthUserModel = sourceModel(source);
        const ArchiveModel = {
            updateOne: jest.fn()
                .mockResolvedValueOnce({ upsertedCount: 1 })
                .mockResolvedValueOnce({ upsertedCount: 0 })
        };

        await expect(archiveSourceDocument("user-1", { OAuthUserModel, ArchiveModel }))
            .resolves.toMatchObject({ created: true });
        await expect(archiveSourceDocument("user-1", { OAuthUserModel, ArchiveModel }))
            .resolves.toMatchObject({ created: false });
        expect(ArchiveModel.updateOne.mock.calls[0][1].$setOnInsert.payload).toEqual(source);
        expect(ArchiveModel.updateOne.mock.calls[0][0]).not.toHaveProperty("contentHash");
    });

    test("backs up each legacy source before migration and marks completion", async () => {
        const source = { _id: "user-1", discord: { userId: "123" } };
        const OAuthUserModel = sourceModel(source);
        const ArchiveModel = { updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }) };
        const StateModel = stateModel();
        const migrateCursor = jest.fn(async options => {
            expect(ArchiveModel.updateOne).not.toHaveBeenCalled();
            await options.beforeMigrate({ _id: "user-1" });
            expect(ArchiveModel.updateOne).toHaveBeenCalledTimes(1);
            return { scanned: 1, eligible: 1, updated: 1, batches: 1 };
        });

        const result = await runAutomaticMigration({
            OAuthUserModel,
            ArchiveModel,
            StateModel,
            migrateCursor,
            settings: { enabled: true, scanMax: 10, batchSize: 10 }
        });

        expect(result).toMatchObject({ complete: true, remaining: 0, backup: { created: 1, reused: 0 } });
        expect(StateModel.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ _id: expect.any(String) }),
            expect.objectContaining({ $set: expect.objectContaining({ status: "complete" }) })
        );
    });

    test("backup failure aborts migration and records failed state", async () => {
        const source = { _id: "user-1", discord: { userId: "123" } };
        const OAuthUserModel = sourceModel(source, [1, 1]);
        const ArchiveModel = { updateOne: jest.fn().mockRejectedValue(new Error("backup unavailable")) };
        const StateModel = stateModel();
        const migrateCursor = jest.fn(async options => {
            await options.beforeMigrate({ _id: "user-1" });
        });

        await expect(runAutomaticMigration({
            OAuthUserModel,
            ArchiveModel,
            StateModel,
            migrateCursor,
            settings: { enabled: true, scanMax: 10, batchSize: 10 }
        })).rejects.toThrow("backup unavailable");
        expect(StateModel.updateOne).toHaveBeenLastCalledWith(
            expect.any(Object),
            expect.objectContaining({ $set: expect.objectContaining({ status: "failed" }) })
        );
    });

    test("persistent migration cursor wraps instead of starving earlier failed records", async () => {
        const source = { _id: "user-1", discord: { userId: "123" } };
        const OAuthUserModel = sourceModel(source, [2, 1]);
        const StateModel = stateModel();
        StateModel.findOneAndUpdate.mockResolvedValue({
            _id: "state",
            cursorSourceId: "stale-last-id"
        });
        const migrateCursor = jest.fn()
            .mockResolvedValueOnce({ scanned: 0, eligible: 0, updated: 0, batches: 0, lastScannedId: null })
            .mockResolvedValueOnce({ scanned: 1, eligible: 1, updated: 1, batches: 1, lastScannedId: "user-1" });

        const result = await runAutomaticMigration({
            OAuthUserModel,
            ArchiveModel: { updateOne: jest.fn() },
            StateModel,
            migrateCursor,
            settings: { enabled: true, scanMax: 10, batchSize: 10 }
        });

        expect(migrateCursor).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ cursorWrapped: true, nextCursor: "user-1", remaining: 1 });
        expect(StateModel.updateOne).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({ $set: expect.objectContaining({ cursorSourceId: "user-1" }) })
        );
    });

    test("migration cursor applies a strict after-id filter", () => {
        const find = jest.fn(() => queryCursor({}));
        _test.migrationCursor({ find }, { $or: [{ legacy: true }] }, 50, "cursor-id");
        expect(find).toHaveBeenCalledWith({
            $and: [{ $or: [{ legacy: true }] }, { _id: { $gt: "cursor-id" } }]
        });
    });

    test("restore is dry-run by default and force-apply replaces archived sources", async () => {
        async function* archives() {
            yield { payload: { _id: "user-1", discord: { userId: "123" } } };
        }
        const replaceOne = jest.fn().mockResolvedValue({ acknowledged: true });
        await expect(restoreCursor({ cursor: archives(), replaceOne }))
            .resolves.toMatchObject({ mode: "dry-run", found: 1, restored: 0 });
        expect(replaceOne).not.toHaveBeenCalled();

        await expect(restoreCursor({ cursor: archives(), apply: true, force: true, replaceOne }))
            .resolves.toMatchObject({ mode: "apply", found: 1, restored: 1 });
        expect(replaceOne).toHaveBeenCalledWith(
            { _id: "user-1" },
            expect.objectContaining({ _id: "user-1" }),
            { upsert: true }
        );
    });
});
