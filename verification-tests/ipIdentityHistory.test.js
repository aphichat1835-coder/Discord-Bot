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
    test("role event ids are stable across role ordering and duplicates", () => {
        const base = {
            guildId: "12345678901234567",
            ipHash: "ip-hash",
            userId: "22345678901234567",
            roleId: "32345678901234567",
            result: "success",
            at: 100
        };
        const first = history._test.roleEventId({ ...base, roles: ["3", "1", "2", "1"] });
        const second = history._test.roleEventId({ ...base, roles: ["2", "3", "1"] });
        expect(first).toBe(second);
        expect(history._test.historyRoles({ roles: ["3", "1", "2", "1"] })).toEqual(["1", "2", "3"]);
        const compatible = history._test.compatibleRoleEventIds({ ...base, roles: ["3", "1", "2", "1"] });
        expect(compatible).toContain(first);
        expect(compatible).toContain(history._test.legacyOrderedRoleEventId({ ...base, roles: ["3", "1", "2", "1"] }));
        expect(history._test.roleEventFilter({ ...base, roles: ["3", "1", "2", "1"] }))
            .toEqual({ eventId: { $in: compatible } });
    });

    test("rejects non-snowflake history lookup identifiers before database access", () => {
        expect(() => history._test.strictSnowflake("$gt", "invalid_user_id"))
            .toThrow("invalid_user_id");
        expect(history._test.strictSnowflake("12345678901234567", "invalid_user_id"))
            .toBe("12345678901234567");
    });

    test("migration counters accept only fixed legacy categories", () => {
        const counter = { users: 0, devices: 0, roles: 0 };

        history._test.incrementMigrationCounter(counter, "users");
        history._test.incrementMigrationCounter(counter, "devices");
        history._test.incrementMigrationCounter(counter, "roles");

        expect(counter).toEqual({ users: 1, devices: 1, roles: 1 });
        expect(() => history._test.incrementMigrationCounter(counter, "__proto__"))
            .toThrow("invalid migration category");
        expect(counter).toEqual({ users: 1, devices: 1, roles: 1 });
    });

    test("writes user/device aggregates and one immutable role event without embedded caps", async () => {
        const UserHistoryModel = {
            updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }),
            countDocuments: jest.fn().mockResolvedValue(201)
        };
        const DeviceHistoryModel = {
            updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 })
        };
        const RoleHistoryModel = { updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }) };
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
        expect(RoleHistoryModel.updateOne.mock.calls[0][1].$setOnInsert.roles).toHaveLength(120);
        expect(RoleHistoryModel.updateOne.mock.calls[0][2]).toEqual({ upsert: true });
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
        const summary = await history._test.migrateLegacyLink(link, {
            UserHistory: UserHistoryModel,
            DeviceHistory: DeviceHistoryModel,
            RoleHistory: RoleHistoryModel
        }, 100);

        expect(summary).toMatchObject({ failed: 0, complete: true });
        expect(summary.written).toEqual({ users: 1, devices: 1, roles: 1 });
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
            {
                $set: { historyMigrationVersion: 1, historyMigratedAt: 100 },
                $unset: {
                    historyMigrationAttemptedAt: "",
                    historyMigrationFailureCount: "",
                    historyMigrationLastErrorCode: ""
                }
            }
        );
    });

    test("isolates legacy write failures, keeps the link retryable, and continues the batch", async () => {
        const links = [
            {
                _id: "link-failed",
                guildId: "guild",
                ipHash: "hash-failed",
                users: [{ userId: "bad-user" }, { userId: "later-user" }],
                deviceFingerprints: [],
                roleSnapshots: []
            },
            {
                _id: "link-good",
                guildId: "guild",
                ipHash: "hash-good",
                users: [{ userId: "good-user" }],
                deviceFingerprints: [],
                roleSnapshots: []
            }
        ];
        const query = queryResult(links);
        const IpIdentityLinkModel = {
            find: jest.fn(() => query),
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
        };
        const UserHistoryModel = {
            updateOne: jest.fn(filter => {
                if (filter.userId === "bad-user") {
                    return Promise.reject(Object.assign(new Error("sensitive database detail"), {
                        code: "write failed: private detail"
                    }));
                }
                return Promise.resolve({});
            })
        };

        const result = await history.migrateLegacyHistory({
            IpIdentityLinkModel,
            UserHistoryModel,
            DeviceHistoryModel: { updateOne: jest.fn() },
            RoleHistoryModel: { updateOne: jest.fn() },
            limit: 10,
            now: 200
        });

        expect(result).toMatchObject({ scanned: 2, migrated: 1, failed: 1 });
        expect(result.failures).toEqual([{ index: 0, code: "Error" }]);
        expect(UserHistoryModel.updateOne).toHaveBeenCalledTimes(3);
        expect(IpIdentityLinkModel.updateOne).toHaveBeenCalledWith(
            { _id: "link-failed" },
            {
                $set: {
                    historyMigrationAttemptedAt: 200,
                    historyMigrationLastErrorCode: "Error"
                },
                $inc: { historyMigrationFailureCount: 1 }
            }
        );
        expect(IpIdentityLinkModel.updateOne).not.toHaveBeenCalledWith(
            { _id: "link-failed" },
            expect.objectContaining({
                $set: expect.objectContaining({ historyMigrationVersion: 1 })
            })
        );
        expect(IpIdentityLinkModel.updateOne).toHaveBeenCalledWith(
            { _id: "link-good" },
            expect.objectContaining({
                $set: { historyMigrationVersion: 1, historyMigratedAt: 200 }
            })
        );
        expect(query.sort).toHaveBeenCalledWith({ historyMigrationAttemptedAt: 1, _id: 1 });
    });

    test("retries an incomplete legacy link without deleting its source arrays", async () => {
        const link = {
            _id: "link-retry",
            guildId: "guild",
            ipHash: "hash",
            users: [{ userId: "user" }],
            deviceFingerprints: [],
            roleSnapshots: []
        };
        const originalUsers = JSON.parse(JSON.stringify(link.users));
        const IpIdentityLinkModel = { updateOne: jest.fn().mockResolvedValue({}) };
        const UserHistoryModel = { updateOne: jest.fn().mockRejectedValueOnce(new Error("temporary")) };
        const options = {
            IpIdentityLinkModel,
            UserHistoryModel,
            DeviceHistoryModel: { updateOne: jest.fn() },
            RoleHistoryModel: { updateOne: jest.fn() },
            now: 300
        };

        const first = await history.ensureLegacyLinkMigrated(link, options);
        UserHistoryModel.updateOne.mockResolvedValueOnce({});
        const second = await history.ensureLegacyLinkMigrated(link, { ...options, now: 400 });

        expect(first).toMatchObject({ migrated: false, failed: true });
        expect(second).toMatchObject({ migrated: true });
        expect(UserHistoryModel.updateOne).toHaveBeenCalledTimes(2);
        expect(link.users).toEqual(originalUsers);
        expect(link.historyMigrationVersion).toBe(1);
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
        expect(UserHistoryModel.updateOne).toHaveBeenCalledTimes(2);
        expect(UserHistoryModel.updateOne.mock.calls[0][1].$inc).toMatchObject({
            verifyCount: 1,
            successCount: 1
        });
        expect(UserHistoryModel.updateOne.mock.calls[1][1].$inc).toMatchObject({
            verifyCount: 1,
            successCount: 1
        });
        expect(DeviceHistoryModel.updateOne).toHaveBeenCalledTimes(2);
        expect(DeviceHistoryModel.updateOne.mock.calls[0][1].$inc).toEqual({ count: 1 });
        expect(IpIdentityLinkModel.updateOne.mock.calls[0][1].$inc).toEqual({ totalVerifications: 1 });
        expect(IpIdentityLinkModel.updateOne.mock.calls[1][1].$inc).toEqual({ totalVerifications: 1 });
        expect(RoleHistoryModel.updateOne.mock.calls[0][1].$setOnInsert.eventId)
            .not.toBe(RoleHistoryModel.updateOne.mock.calls[1][1].$setOnInsert.eventId);
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
