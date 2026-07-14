"use strict";

const {
    buildPatch,
    migrateCursor,
    bulkWriteFailureCount,
    badgeFlags,
    displayTag,
    avatarUrl,
    bannerUrl
} = require("../scripts/migrateVerificationSnapshots");

describe("verification additive migration", () => {
    test("backfills derived profile fields and additive snapshot metadata", () => {
        const patch = buildPatch({
            discord: {
                userId: "12345678901234567",
                username: "owner",
                discriminator: "0",
                avatarHash: "avatar",
                bannerHash: "a_banner",
                publicFlags: (1 << 0) | (1 << 17)
            },
            connections: [{ id: "1" }],
            guilds: [{ id: "2" }]
        }, 1234);

        expect(patch["discord.displayTag"]).toBe("owner");
        expect(patch["discord.avatarUrl"]).toContain("/avatars/12345678901234567/avatar.png");
        expect(patch["discord.bannerUrl"]).toContain("/banners/12345678901234567/a_banner.gif");
        expect(patch["discord.badgeFlags"]).toEqual(["STAFF", "VERIFIED_DEVELOPER"]);
        expect(patch.snapshotMeta).toMatchObject({
            version: 2,
            migratedAt: 1234,
            connections: { returnedCount: 1, storedCount: 1, truncated: false },
            guilds: { returnedCount: 1, storedCount: 1, truncated: false }
        });
    });

    test("preserves existing successful metadata and never creates token or raw-IP fields", () => {
        const existing = { status: "success", fetchedAt: 99 };
        const patch = buildPatch({
            discord: { username: "legacy", discriminator: "1234" },
            snapshotMeta: { connections: existing }
        });
        expect(patch.snapshotMeta.connections).toBe(existing);
        expect(JSON.stringify(patch)).not.toMatch(/token|rawIp|encryptedRawIp/i);
    });

    test("preserves stored badge labels when raw flag fields are unavailable", () => {
        const patch = buildPatch({
            discord: { username: "legacy", badgeFlags: ["STAFF", "HYPESQUAD"] }
        }, 1234);
        expect(patch["discord.badgeFlags"]).toEqual(["STAFF", "HYPESQUAD"]);
    });

    test("derived helpers preserve modern discriminator semantics", () => {
        expect(displayTag({ username: "modern", discriminator: "0" })).toBe("modern");
        expect(displayTag({ username: "legacy", discriminator: "1234" })).toBe("legacy#1234");
        expect(badgeFlags({ flags: 1 })).toEqual(["STAFF"]);
        expect(avatarUrl({})).toBeNull();
        expect(bannerUrl({})).toBeNull();
    });

    test("dry-run scans old records without issuing writes", async () => {
        const bulkWrite = jest.fn();
        const summary = await migrateCursor({
            cursor: [{
                _id: "legacy-1",
                discord: { username: "legacy", discriminator: "1234" }
            }],
            apply: false,
            batchSize: 1,
            bulkWrite,
            now: () => 100
        });
        expect(summary).toEqual({
            mode: "dry-run",
            scanned: 1,
            eligible: 1,
            updated: 0,
            batches: 1,
            batchErrors: 0,
            failedOperations: 0,
            snapshotCategoriesComplete: 0,
            snapshotCategoriesFailed: 0,
            lastScannedId: "legacy-1"
        });
        expect(bulkWrite).not.toHaveBeenCalled();
    });

    test("apply mode writes additive patches that remain readable by the model", async () => {
        const writes = [];
        const summary = await migrateCursor({
            cursor: [{
                _id: "legacy-1",
                discord: {
                    userId: "12345678901234567",
                    username: "legacy",
                    discriminator: "1234",
                    publicFlags: 1
                },
                connections: [],
                guilds: []
            }],
            apply: true,
            batchSize: 1,
            bulkWrite: async operations => {
                writes.push(...operations);
                return { modifiedCount: operations.length };
            },
            now: () => 200
        });
        expect(summary.updated).toBe(1);
        const patch = writes[0].updateOne.update.$set;
        expect(writes[0].updateOne.filter).toEqual({
            _id: "legacy-1",
            updatedAt: { $exists: false }
        });
        const OAuthUser = require("../discord/verification/models/OAuthUser");
        const readable = new OAuthUser({
            discord: {
                userId: "12345678901234567",
                username: "legacy",
                discriminator: "1234",
                displayTag: patch["discord.displayTag"],
                badgeFlags: patch["discord.badgeFlags"]
            },
            snapshotMeta: patch.snapshotMeta
        });
        expect(readable.validateSync()).toBeUndefined();
        expect(readable.discord.displayTag).toBe("legacy#1234");
        expect(readable.snapshotMeta.version).toBe(2);
        expect(JSON.stringify(writes)).not.toMatch(/encryptedAccessToken|encryptedRefreshToken|rawIp/i);
    });

    test("uses updatedAt as an optimistic concurrency guard", async () => {
        const writes = [];
        await migrateCursor({
            cursor: [{ _id: "legacy-1", updatedAt: 456, discord: { username: "legacy" } }],
            apply: true,
            bulkWrite: async operations => {
                writes.push(...operations);
                return { modifiedCount: 0 };
            },
            now: () => 500
        });
        expect(writes[0].updateOne.filter).toEqual({ _id: "legacy-1", updatedAt: 456 });
        expect(writes[0].updateOne.update.$set.updatedAt).toBe(500);
    });

    test("continues after a rejected bulk batch and reports the failure safely", async () => {
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
        const bulkWrite = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error("database details must stay hidden"), {
                code: "batch_failed"
            }))
            .mockResolvedValueOnce({ modifiedCount: 1 });
        const summary = await migrateCursor({
            cursor: [
                { _id: "legacy-1", discord: { username: "one" } },
                { _id: "legacy-2", discord: { username: "two" } }
            ],
            apply: true,
            batchSize: 1,
            bulkWrite,
            now: () => 500
        });

        expect(summary).toMatchObject({
            scanned: 2,
            batches: 2,
            batchErrors: 1,
            failedOperations: 1,
            updated: 1
        });
        expect(bulkWrite).toHaveBeenCalledTimes(2);
        expect(errorLog.mock.calls.flat().join(" ")).not.toContain("database details must stay hidden");
    });


    test("partial unordered bulk failures count only rejected operations", async () => {
        expect(bulkWriteFailureCount({ writeErrors: [{ index: 1 }] }, 3)).toBe(1);
        expect(bulkWriteFailureCount({ writeErrors: [], result: { modifiedCount: 2 } }, 3)).toBe(1);
        expect(bulkWriteFailureCount({ result: { matchedCount: 2, upsertedCount: 0 } }, 3)).toBe(1);

        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
        const summary = await migrateCursor({
            cursor: [
                { _id: "legacy-1", discord: { username: "one" } },
                { _id: "legacy-2", discord: { username: "two" } },
                { _id: "legacy-3", discord: { username: "three" } }
            ],
            apply: true,
            batchSize: 3,
            bulkWrite: async () => {
                throw Object.assign(new Error("partial"), {
                    code: 11000,
                    writeErrors: [{ index: 1 }],
                    result: { modifiedCount: 2, matchedCount: 2 }
                });
            },
            now: () => 500
        });
        expect(summary).toMatchObject({
            updated: 2,
            batchErrors: 1,
            failedOperations: 1
        });
        errorLog.mockRestore();
    });

    test("apply mode backfills complete chunk references without removing embedded data", async () => {
        const writes = [];
        const snapshotWriter = jest.fn().mockResolvedValue({
            version: "migration-v1",
            profile: {
                version: "migration-v1", returnedCount: 1, storedCount: 1,
                chunkCount: 1, complete: true, source: "migration"
            },
            connections: {
                version: "migration-v1", returnedCount: 2, storedCount: 2,
                chunkCount: 1, complete: true, source: "migration"
            },
            guilds: {
                version: "migration-v1", returnedCount: 3, storedCount: 3,
                chunkCount: 1, complete: true, source: "migration"
            },
            member: {
                version: "migration-v1", returnedCount: 2, storedCount: 1,
                chunkCount: 1, complete: true, source: "migration"
            }
        });
        const summary = await migrateCursor({
            cursor: [{
                _id: "legacy-1",
                discord: {
                    userId: "12345678901234567",
                    username: "legacy",
                    encryptedAccessToken: "encrypted-access",
                    encryptedRefreshToken: "encrypted-refresh",
                    rawIp: "encrypted-ip"
                },
                connections: [{ id: "1" }, { id: "2" }],
                guilds: [{ id: "1" }, { id: "2" }, { id: "3" }]
            }],
            apply: true,
            batchSize: 1,
            snapshotWriter,
            bulkWrite: async operations => {
                writes.push(...operations);
                return { modifiedCount: operations.length };
            },
            now: () => 300
        });

        expect(snapshotWriter).toHaveBeenCalledWith(expect.objectContaining({
            connections: expect.any(Array),
            guilds: expect.any(Array),
            profile: expect.not.objectContaining({
                encryptedAccessToken: expect.anything(),
                encryptedRefreshToken: expect.anything(),
                rawIp: expect.anything()
            })
        }));
        expect(summary.snapshotCategoriesComplete).toBe(3);
        expect(summary.snapshotCategoriesFailed).toBe(1);
        const patch = writes[0].updateOne.update.$set;
        expect(patch.snapshotRefs.connections).toMatchObject({ complete: true, storedCount: 2 });
        expect(patch.snapshotMeta.guilds).toMatchObject({ complete: true, returnedCount: 3, storedCount: 3 });
        expect(patch.snapshotRefs.member).toBeUndefined();
        expect(patch.snapshotMeta.member).toMatchObject({ status: "failed", complete: false });
        expect(writes[0].updateOne.update).not.toHaveProperty("$unset");
    });
});
