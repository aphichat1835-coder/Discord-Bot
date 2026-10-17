"use strict";

const orchestrator = require("../discord/verification/services/verificationOrchestrator");
const GuildConfig = require("../discord/verification/models/GuildConfig");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const VerifyLog = require("../discord/verification/models/VerifyLog");
const IpIdentityLink = require("../discord/verification/models/IpIdentityLink");
const ipIdentityHistory = require("../discord/verification/services/ipIdentityHistoryService");
const snapshotBudget = require("../discord/verification/services/snapshotBudget");
const oauthTokenManager = require("../discord/tokens/oauthTokenManager");

describe("Verification Orchestrator Pure Units & Edge Cases", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const validGuildId = "123456789012345678";
    const validUserId = "987654321098765432";
    const validRoleId = "112233445566778899";
    const validIpHash = "a".repeat(64);

    describe("isPanelRevisionValid", () => {
        test("returns ok: true if guildConfig has no verification configuration", () => {
            expect(orchestrator.isPanelRevisionValid(null, {})).toEqual({ ok: true });
            expect(orchestrator.isPanelRevisionValid({}, {})).toEqual({ ok: true });
        });

        test("returns ok: true when panelRevision matches", () => {
            const guildConfig = { verification: { panelRevision: 2 } };
            const stateObj = { panelRevision: 2 };
            expect(orchestrator.isPanelRevisionValid(guildConfig, stateObj)).toEqual({
                ok: true,
                stateRev: 2,
                latest: 2
            });
        });

        test("returns ok: false when panelRevision does not match", () => {
            const guildConfig = { verification: { panelRevision: 3 } };
            const stateObj = { panelRevision: 1 };
            expect(orchestrator.isPanelRevisionValid(guildConfig, stateObj)).toEqual({
                ok: false,
                stateRev: 1,
                latest: 3
            });
        });

        test("defaults to 1 if revision is undefined in either guildConfig or stateObj", () => {
            const guildConfig = { verification: {} };
            const stateObj = {};
            expect(orchestrator.isPanelRevisionValid(guildConfig, stateObj)).toEqual({
                ok: true,
                stateRev: 1,
                latest: 1
            });
        });
    });

    describe("fitVerifyLogBudget", () => {
        test("returns unchanged doc when payload fits within snapshot budget", () => {
            const doc = {
                guildId: validGuildId,
                userId: validUserId,
                result: "success"
            };
            const payload = { ...doc };
            const res = orchestrator.fitVerifyLogBudget(doc, payload);
            expect(res.degraded).toBe(false);
            expect(res.doc).toEqual(doc);
        });

        test("catches budget exceed error and constructs degraded minimal audit document", () => {
            const spy = jest.spyOn(snapshotBudget, "assertSnapshotBudget").mockImplementationOnce(() => {
                throw new Error("verify_log_budget_exceeded: 65000 > 60000");
            });

            const doc = { guildId: validGuildId, userId: validUserId };
            const payload = {
                guildId: validGuildId,
                userId: validUserId,
                roleId: validRoleId,
                result: "success",
                reason: "verified_ok",
                verifiedAt: 1700000000000
            };

            const res = orchestrator.fitVerifyLogBudget(doc, payload);
            expect(res.degraded).toBe(true);
            expect(res.doc.dataQuality.degraded).toBe(true);
            expect(res.doc.dataQuality.budgetExceeded).toBe(true);
            expect(res.doc.dataQuality.errorMessage).toContain("verify_log_budget_exceeded");
            expect(res.doc.userId).toBe(validUserId);
            expect(res.doc.verifiedAt).toBe(1700000000000);

            spy.mockRestore();
        });
    });

    describe("loadExistingIpLinkContext", () => {
        test("returns empty context when ipInfo or guildId is missing", async () => {
            const res1 = await orchestrator.loadExistingIpLinkContext({ ipInfo: null, guildId: validGuildId });
            expect(res1).toEqual({ existingIpLink: null, updatedIpInfo: null, trackedUsers: [] });

            const res2 = await orchestrator.loadExistingIpLinkContext({ ipInfo: { ipHash: "" }, guildId: validGuildId });
            expect(res2.existingIpLink).toBeNull();

            const res3 = await orchestrator.loadExistingIpLinkContext({ ipInfo: { ipHash: validIpHash }, guildId: null });
            expect(res3.existingIpLink).toBeNull();
        });

        test("throws invalid_snowflake error for invalid guildId", async () => {
            await expect(orchestrator.loadExistingIpLinkContext({
                ipInfo: { ipHash: validIpHash },
                guildId: "short_id"
            })).rejects.toMatchObject({ code: "invalid_snowflake" });
        });

        test("throws invalid_ip_hash error for invalid ipHash", async () => {
            await expect(orchestrator.loadExistingIpLinkContext({
                ipInfo: { ipHash: "not_a_valid_hash" },
                guildId: validGuildId
            })).rejects.toMatchObject({ code: "invalid_ip_hash" });
        });

        test("loads existing IP link and tracked users on valid query", async () => {
            const mockLink = { guildId: validGuildId, ipHash: validIpHash, totalVerifications: 5 };
            const mockTrackedUsers = [{ userId: validUserId, count: 2 }];

            jest.spyOn(IpIdentityLink, "findOne").mockReturnValue({
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockReturnValue({
                    where: jest.fn().mockReturnThis(),
                    equals: jest.fn().mockReturnValue({
                        lean: jest.fn().mockResolvedValue(mockLink)
                    })
                })
            });

            jest.spyOn(ipIdentityHistory, "listTrackedUsersForLink").mockResolvedValue(mockTrackedUsers);

            const res = await orchestrator.loadExistingIpLinkContext({
                ipInfo: { ipHash: validIpHash, country: "TH" },
                guildId: validGuildId
            });

            expect(res.existingIpLink).toEqual(mockLink);
            expect(res.trackedUsers).toEqual(mockTrackedUsers);
            expect(res.updatedIpInfo.country).toBe("TH");

            jest.restoreAllMocks();
        });
    });

    describe("loadExistingDeviceContext", () => {
        test("returns empty or current user context when device or fingerprintHash is missing", async () => {
            const res1 = await orchestrator.loadExistingDeviceContext({ device: null, guildId: validGuildId });
            expect(res1).toEqual({ uniqueUsers: 0, userIds: [] });

            const res2 = await orchestrator.loadExistingDeviceContext({
                device: { fingerprintHash: "" },
                guildId: validGuildId,
                currentUserId: validUserId
            });
            expect(res2).toEqual({ uniqueUsers: 1, userIds: [validUserId] });
        });

        test("aggregates unique users from deviceFingerprints and users fields", async () => {
            const mockLinks = [
                {
                    deviceFingerprints: [
                        { fingerprintHash: "fp_test_123", userId: "111111111111111111" }
                    ],
                    users: [
                        { lastDeviceFingerprintHash: "fp_test_123", userId: "222222222222222222" },
                        { lastDeviceFingerprintHash: "different_fp", userId: "333333333333333333" }
                    ]
                }
            ];

            jest.spyOn(IpIdentityLink, "find").mockReturnValue({
                select: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(mockLinks)
            });

            const res = await orchestrator.loadExistingDeviceContext({
                device: { fingerprintHash: "fp_test_123" },
                guildId: validGuildId,
                currentUserId: validUserId
            });

            expect(res.uniqueUsers).toBe(3);
            expect(res.userIds).toContain("111111111111111111");
            expect(res.userIds).toContain("222222222222222222");
            expect(res.userIds).toContain(validUserId);
            expect(res.userIds).not.toContain("333333333333333333");

            jest.restoreAllMocks();
        });

        test("handles safeSideEffect error gracefully and returns fallback", async () => {
            jest.spyOn(IpIdentityLink, "find").mockImplementation(() => {
                throw new Error("DB_FIND_FAILED");
            });

            const res = await orchestrator.loadExistingDeviceContext({
                device: { fingerprintHash: "fp_test_err" },
                guildId: validGuildId,
                currentUserId: validUserId
            });

            expect(res.uniqueUsers).toBe(1);
            expect(res.userIds).toEqual([validUserId]);

            jest.restoreAllMocks();
        });
    });

    describe("saveVerifyLogSafe", () => {
        test("persists verify log and marks isBudgetDegraded: false", async () => {
            const mockCreated = { _id: "log_1", guildId: validGuildId, userId: validUserId };
            jest.spyOn(VerifyLog, "create").mockResolvedValue(mockCreated);

            const payload = {
                guildId: validGuildId,
                userId: validUserId,
                roleId: validRoleId,
                result: "success",
                trackingSnapshot: { ipHash: validIpHash }
            };

            const result = await orchestrator.saveVerifyLogSafe(payload);
            expect(result).toBe(mockCreated);
            expect(result.isBudgetDegraded).toBe(false);

            jest.restoreAllMocks();
        });

        test("catches persistence failure safely without throwing", async () => {
            jest.spyOn(VerifyLog, "create").mockRejectedValue(new Error("WRITE_CONFLICT"));

            const result = await orchestrator.saveVerifyLogSafe({
                guildId: validGuildId,
                userId: validUserId
            });
            expect(result).toBeNull();

            jest.restoreAllMocks();
        });
    });

    describe("saveOAuthUserSafe", () => {
        test("returns failed response safely when profile is missing or invalid", async () => {
            const res = await orchestrator.saveOAuthUserSafe({
                profile: null
            });
            expect(res).toEqual({ saved: false, code: "save_oauth_user_failed_safely" });
        });

        test("successfully formats profile and commits verification activation", async () => {
            jest.spyOn(oauthTokenManager, "commitVerificationActivation").mockResolvedValue({
                activated: true
            });

            const profile = {
                id: validUserId,
                username: "testuser",
                discriminator: "0001",
                globalName: "Test User",
                email: "test@example.com",
                emailVerified: true,
                locale: "th",
                mfaEnabled: true,
                premiumType: 2,
                flags: 64,
                publicFlags: 64,
                badgeFlags: ["DISCORD_NITRO"],
                accountCreatedAt: 1600000000000,
                accountAgeDays: 500
            };

            const res = await orchestrator.saveOAuthUserSafe({
                profile,
                tokenData: { accessToken: "token_123" },
                connections: [{ type: "github", verified: true }],
                guildId: validGuildId,
                roleId: validRoleId,
                result: "success",
                findings: [],
                trackingSnapshot: { ipHash: validIpHash }
            });

            expect(res).toEqual({
                saved: true,
                activated: true
            });

            jest.restoreAllMocks();
        });
    });

    describe("updateIpIdentityTrackingSafe", () => {
        test("returns null if guildId, profile id, or ipHash is missing", async () => {
            expect(await orchestrator.updateIpIdentityTrackingSafe({})).toBeNull();
            expect(await orchestrator.updateIpIdentityTrackingSafe({
                guildId: validGuildId,
                profile: { id: null },
                ipInfo: { ipHash: validIpHash }
            })).toBeNull();
            expect(await orchestrator.updateIpIdentityTrackingSafe({
                guildId: validGuildId,
                profile: { id: validUserId },
                ipInfo: null
            })).toBeNull();
        });

        test("updates and returns ip tracking metrics on valid inputs", async () => {
            jest.spyOn(IpIdentityLink, "findOne").mockReturnValue({
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockReturnValue({
                    where: jest.fn().mockReturnThis(),
                    equals: jest.fn().mockResolvedValue(null)
                })
            });

            jest.spyOn(ipIdentityHistory, "recordIpIdentityHistory").mockResolvedValue({ ok: true });

            jest.spyOn(IpIdentityLink, "findOneAndUpdate").mockResolvedValue({
                firstSeenAt: 1700000000000,
                lastSeenAt: 1700000050000,
                totalVerifications: 3,
                uniqueUsers: 2
            });

            const res = await orchestrator.updateIpIdentityTrackingSafe({
                guildId: validGuildId,
                guildName: "Test Guild",
                profile: { id: validUserId, username: "tester" },
                ipInfo: {
                    ipHash: validIpHash,
                    country: "TH",
                    countryCode: "TH",
                    isVPN: false,
                    isProxy: false,
                    isTOR: false,
                    hosting: false
                },
                device: {},
                roleId: validRoleId,
                result: "success",
                findings: []
            });

            expect(res).toEqual({
                ipHash: validIpHash,
                firstSeenAt: 1700000000000,
                lastSeenAt: 1700000050000,
                totalVerifications: 3,
                uniqueUsers: 2
            });

            jest.restoreAllMocks();
        });
    });

    describe("executeVerification Preconditions and Guards", () => {
        test("throws invalid_snowflake error when stateObj contains invalid guildId snowflake", async () => {
            const req = {
                ip: "127.0.0.1",
                headers: {},
                body: { state: "invalid", code: "code123" }
            };
            const stateObj = { guildId: "not_a_snowflake" };

            await expect(orchestrator.executeVerification({
                req,
                code: "oauth_code",
                stateObj,
                adminConfig: {}
            })).rejects.toMatchObject({ code: "invalid_snowflake" });
        });

        test("returns guild_config_not_found when GuildConfig does not exist", async () => {
            jest.spyOn(GuildConfig, "findOne").mockReturnValue({
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockResolvedValue(null)
            });

            const req = { ip: "127.0.0.1", headers: {} };
            const stateObj = { guildId: validGuildId };

            const res = await orchestrator.executeVerification({
                req,
                code: "oauth_code",
                stateObj,
                adminConfig: {}
            });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe("guild_config_not_found");

            jest.restoreAllMocks();
        });

        test("returns verification_disabled when verification is turned off", async () => {
            jest.spyOn(GuildConfig, "findOne").mockReturnValue({
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockResolvedValue({
                    guildId: validGuildId,
                    verification: { enabled: false }
                })
            });

            const req = { ip: "127.0.0.1", headers: {} };
            const stateObj = { guildId: validGuildId };

            const res = await orchestrator.executeVerification({
                req,
                code: "oauth_code",
                stateObj,
                adminConfig: {}
            });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe("verification_disabled");

            jest.restoreAllMocks();
        });

        test("returns panel_revision_mismatched when panel revision is outdated", async () => {
            jest.spyOn(GuildConfig, "findOne").mockReturnValue({
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockResolvedValue({
                    guildId: validGuildId,
                    verification: { enabled: true, roleId: validRoleId, panelRevision: 5 }
                })
            });

            const req = { ip: "127.0.0.1", headers: {} };
            const stateObj = { guildId: validGuildId, panelRevision: 2 };

            const res = await orchestrator.executeVerification({
                req,
                code: "oauth_code",
                stateObj,
                adminConfig: {}
            });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe("panel_revision_mismatch");

            jest.restoreAllMocks();
        });
    });

    describe("_test Pure Helpers & Sanitizers", () => {
        const {
            safeString,
            safeNullableString,
            safeNumberOrNull,
            safeSnowflakeStrict,
            safeIpHashStrict,
            objectOrEmpty,
            sanitizeSideEffectError,
            getGuildName,
            getConfiguredRoleId,
            getConfiguredRoleName,
            getLatestPanelRevision,
            getStatePanelRevision,
            buildVerificationSnapshots
        } = orchestrator._test;

        test("safeString and safeNullableString contracts", () => {
            expect(safeString(null)).toBe("");
            expect(safeString(undefined)).toBe("");
            expect(safeString("hello\u0000world")).toBe("helloworld");
            expect(safeString("long_text", 4)).toBe("long");

            expect(safeNullableString(null)).toBeNull();
            expect(safeNullableString("")).toBeNull();
            expect(safeNullableString("valid")).toBe("valid");
        });

        test("safeNumberOrNull contract", () => {
            expect(safeNumberOrNull(123)).toBe(123);
            expect(safeNumberOrNull("456")).toBe(456);
            expect(safeNumberOrNull(undefined)).toBeNull();
            expect(safeNumberOrNull("abc")).toBeNull();
            expect(safeNumberOrNull(NaN)).toBeNull();
        });

        test("safeSnowflakeStrict and safeIpHashStrict boundaries", () => {
            expect(safeSnowflakeStrict("123456789012345678")).toBe("123456789012345678");
            expect(() => safeSnowflakeStrict("12345")).toThrow();
            expect(() => safeSnowflakeStrict(null)).toThrow();

            const hex64 = "f".repeat(64);
            expect(safeIpHashStrict(hex64)).toBe(hex64);
            expect(() => safeIpHashStrict("short")).toThrow();
            expect(() => safeIpHashStrict("g".repeat(64))).toThrow();
        });

        test("objectOrEmpty and sanitizeSideEffectError contracts", () => {
            expect(objectOrEmpty(null)).toEqual({});
            expect(objectOrEmpty([1, 2])).toEqual({});
            expect(objectOrEmpty("string")).toEqual({});
            expect(objectOrEmpty({ a: 1 })).toEqual({ a: 1 });

            expect(sanitizeSideEffectError(null)).toBeNull();
            expect(sanitizeSideEffectError(new Error("sample"))).toEqual({
                message: "sample",
                code: null
            });
            const customErr = new Error("custom");
            customErr.code = "CUSTOM_ERR";
            expect(sanitizeSideEffectError(customErr)).toEqual({
                message: "custom",
                code: "CUSTOM_ERR"
            });
        });

        test("guild configuration attribute readers", () => {
            expect(getGuildName(null)).toBe("Discord Server");
            expect(getGuildName({ guildName: "My Guild" })).toBe("My Guild");
            expect(getGuildName({ name: "Fallback Name" })).toBe("Fallback Name");

            expect(getConfiguredRoleId(null)).toBeNull();
            expect(getConfiguredRoleId({ verification: { roleId: "r1" } })).toBe("r1");
            expect(getConfiguredRoleId({}, "fallback_role")).toBe("fallback_role");

            expect(getConfiguredRoleName(null)).toBe("Member");
            expect(getConfiguredRoleName({ verification: { roleName: "Verified" } })).toBe("Verified");

            expect(getLatestPanelRevision(null)).toBe(1);
            expect(getLatestPanelRevision({ verification: { panelRevision: 4 } })).toBe(4);

            expect(getStatePanelRevision(null)).toBe(1);
            expect(getStatePanelRevision({ panelRevision: 7 })).toBe(7);
        });

        test("buildVerificationSnapshots formats profile and connections accurately", () => {
            const profile = {
                username: "alice",
                globalName: "Alice Wonderland",
                discriminator: "0001",
                accountCreatedAt: 1600000000000,
                accountAgeDays: 400,
                email: "alice@test.local",
                emailVerified: true,
                locale: "en-US",
                mfaEnabled: true,
                premiumType: 1,
                badgeFlags: ["HOUSE_BRAVERY"]
            };
            const connections = [
                { type: "github", verified: true },
                { type: "steam", verified: false }
            ];

            const snapshots = buildVerificationSnapshots(profile, connections);
            expect(snapshots.discordSnapshot.username).toBe("alice");
            expect(snapshots.discordSnapshot.email).toBe("alice@test.local");
            expect(snapshots.discordSnapshot.connectionsCount).toBe(2);
            expect(snapshots.connectionsSnapshot).toEqual([
                { type: "github", verified: true },
                { type: "steam", verified: false }
            ]);
        });
    });
});
