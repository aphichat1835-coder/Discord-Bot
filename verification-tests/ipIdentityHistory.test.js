"use strict";

const history = require("../discord/verification/services/ipIdentityHistoryService");

function queryResult(value) {
    const query = {
        sort: jest.fn(() => query),
        skip: jest.fn(() => query),
        limit: jest.fn(() => query),
        lean: jest.fn().mockResolvedValue(value)
    };
    return query;
}

function findQuery(value) {
    const query = {
        sort: jest.fn(() => query),
        limit: jest.fn(() => query),
        lean: jest.fn().mockResolvedValue(value)
    };
    return query;
}

describe("unbounded IP identity history", () => {
    test("rejects non-snowflake history lookup identifiers before database access", () => {
        expect(() => history._test.strictSnowflake("$gt", "invalid_user_id"))
            .toThrow("invalid_user_id");
        expect(history._test.strictSnowflake("12345678901234567", "invalid_user_id"))
            .toBe("12345678901234567");
    });

    test("writes user/device aggregates and one immutable role event without embedded caps", async () => {
        const UserHistoryModel = {
            updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }),
            countDocuments: jest.fn().mockResolvedValue(201)
        };
        const DeviceHistoryModel = {
            updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 })
        };
        const RoleHistoryModel = { create: jest.fn().mockResolvedValue({}) };
        const result = await history.recordIpIdentityHistory({
            guildId: "12345678901234567",
            ipHash: "hash",
            profile: { id: "22345678901234567", username: "name" },
            device: { fingerprintHash: "fingerprint", browser: "Chrome" },
            memberInfo: { roles: Array.from({ length: 120 }, (_, index) => `role-${index}`) },
            roleId: "32345678901234567",
            result: "success",
            riskSummary: { score: 10, flags: [] },
            now: 100
        }, { UserHistoryModel, DeviceHistoryModel, RoleHistoryModel });

        expect(result.uniqueUsers).toBe(201);
        expect(UserHistoryModel.updateOne).toHaveBeenCalledTimes(1);
        expect(DeviceHistoryModel.updateOne).toHaveBeenCalledTimes(1);
        expect(RoleHistoryModel.create.mock.calls[0][0].roles).toHaveLength(120);
    });

    test("paginates canonical history without truncating the total", async () => {
        const items = Array.from({ length: 100 }, (_, index) => ({ userId: String(index) }));
        const query = queryResult(items);
        const UserHistoryModel = {
            find: jest.fn(() => query),
            countDocuments: jest.fn().mockResolvedValue(1200)
        };
        const result = await history.loadHistoryPage({
            guildId: "guild",
            ipHash: "hash",
            kind: "users",
            page: 3,
            limit: 100
        }, { UserHistoryModel });

        expect(result.items).toHaveLength(100);
        expect(result.total).toBe(1200);
        expect(result.hasMore).toBe(true);
        expect(query.skip).toHaveBeenCalledWith(300);
    });

    test("migrates every legacy embedded item additively before marking the link", async () => {
        const UserHistoryModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const DeviceHistoryModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const RoleHistoryModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const link = {
            guildId: "guild",
            ipHash: "hash",
            users: [{ userId: "user" }],
            deviceFingerprints: [{ userId: "user", fingerprintHash: "fp" }],
            roleSnapshots: [{ userId: "user", roles: ["role"], at: 1 }]
        };
        await history._test.migrateLegacyLink(link, {
            UserHistory: UserHistoryModel,
            DeviceHistory: DeviceHistoryModel,
            RoleHistory: RoleHistoryModel
        }, 100);

        expect(UserHistoryModel.updateOne).toHaveBeenCalledTimes(1);
        expect(DeviceHistoryModel.updateOne).toHaveBeenCalledTimes(1);
        expect(RoleHistoryModel.updateOne).toHaveBeenCalledTimes(1);
        expect(RoleHistoryModel.updateOne.mock.calls[0][1].$setOnInsert.source)
            .toBe("legacy_ip_identity_link");
    });

    test("bounded migration marks a link only after every legacy category is copied", async () => {
        const link = {
            _id: "link-1",
            guildId: "guild",
            ipHash: "hash",
            users: [{ userId: "user" }],
            deviceFingerprints: [],
            roleSnapshots: []
        };
        const query = queryResult([link]);
        const IpIdentityLinkModel = {
            find: jest.fn(() => query),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
        };
        const UserHistoryModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const result = await history.migrateLegacyHistory({
            IpIdentityLinkModel,
            UserHistoryModel,
            DeviceHistoryModel: { updateOne: jest.fn() },
            RoleHistoryModel: { updateOne: jest.fn() },
            limit: 10,
            now: 100
        });

        expect(result).toMatchObject({ scanned: 1, migrated: 1, version: 1 });
        expect(UserHistoryModel.updateOne).toHaveBeenCalledTimes(1);
        expect(IpIdentityLinkModel.updateOne).toHaveBeenCalledWith(
            { _id: "link-1" },
            { $set: { historyMigrationVersion: 1, historyMigratedAt: 100 } }
        );
    });

    test("recovers every eligible VerifyLog in a bounded batch and marks it after copying", async () => {
        const logs = [1, 2].map(at => ({
            _id: `log-${at}`,
            guildId: "12345678901234567",
            userId: "22345678901234567",
            roleId: "32345678901234567",
            result: "success",
            verifiedAt: at,
            ipInfo: { ipHash: "hash" },
            device: { fingerprintHash: "fingerprint" },
            memberSnapshot: { roles: ["role"] }
        }));
        const VerifyLogModel = {
            find: jest.fn(() => findQuery(logs)),
            updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
        };
        const IpIdentityLinkModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const UserHistoryModel = {
            updateOne: jest.fn().mockResolvedValue({}),
            countDocuments: jest.fn().mockResolvedValue(1)
        };
        const DeviceHistoryModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const RoleHistoryModel = { updateOne: jest.fn().mockResolvedValue({}) };

        const result = await history.migrateVerifyLogHistory({
            VerifyLogModel,
            IpIdentityLinkModel,
            UserHistoryModel,
            DeviceHistoryModel,
            RoleHistoryModel,
            limit: 2,
            now: 100
        });

        expect(result).toMatchObject({ scanned: 2, migrated: 2, skipped: 0, remaining: true });
        expect(RoleHistoryModel.updateOne).toHaveBeenCalledTimes(2);
        expect(RoleHistoryModel.updateOne.mock.calls[0][0].eventId)
            .not.toBe(RoleHistoryModel.updateOne.mock.calls[1][0].eventId);
        expect(VerifyLogModel.updateOne).toHaveBeenCalledTimes(2);
        expect(VerifyLogModel.updateOne).toHaveBeenLastCalledWith(
            { _id: "log-2" },
            { $set: { ipHistoryMigrationVersion: 1, ipHistoryMigratedAt: 100 } }
        );
        expect(IpIdentityLinkModel.updateOne).toHaveBeenLastCalledWith(
            { guildId: "12345678901234567", ipHash: "hash" },
            { $set: { uniqueUsers: 1, updatedAt: 100 } }
        );
    });

    test("uses the same deterministic role event id for embedded and VerifyLog recovery", () => {
        const link = { guildId: "guild", ipHash: "hash" };
        const role = { userId: "user", roleId: "role", roles: ["one"], result: "success", at: 10 };
        expect(history._test.legacyEventId(link, role)).toBe(history._test.roleEventId({
            guildId: "guild",
            ipHash: "hash",
            userId: "user",
            roleId: "role",
            roles: ["one"],
            result: "success",
            at: 10
        }));
    });

    test("runtime source no longer truncates canonical IP history arrays", () => {
        const source = require("node:fs").readFileSync(
            "discord/verification/routes/oauth.js",
            "utf8"
        );
        expect(source).not.toContain("IP_LINK_USERS_MAX");
        expect(source).not.toContain("IP_LINK_DEVICE_FINGERPRINTS_MAX");
        expect(source).not.toContain("IP_LINK_ROLE_SNAPSHOTS_MAX");
        expect(source).toContain("recordIpIdentityHistory");
    });
});
