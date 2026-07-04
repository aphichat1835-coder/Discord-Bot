"use strict";

const {
    buildPatch,
    migrateCursor,
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
            batches: 1
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
});
