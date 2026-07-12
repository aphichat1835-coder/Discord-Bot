"use strict";

const VerifyLog = require("../discord/verification/models/VerifyLog");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const GuildConfig = require("../discord/verification/models/GuildConfig");
const cryptoUtils = require("../discord/verification/utils/crypto");
const ownerService = require("../discord/verification/ownerService");
const sensitiveAudit = require("../discord/verification/services/sensitiveAuditService");
const ipIdentityHistory = require("../discord/verification/services/ipIdentityHistoryService");

describe("audited Owner raw-IP reveal", () => {
    const previousKey = process.env.ENCRYPTION_KEY;

    beforeAll(() => {
        process.env.ENCRYPTION_KEY = "owner-reveal-test-key-at-least-32-bytes";
    });

    afterAll(() => {
        if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = previousKey;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        sensitiveAudit._test.buckets.clear();
    });

    test("requires a non-empty reason before querying data", async () => {
        const find = jest.spyOn(VerifyLog, "findOne");
        await expect(ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: " "
        })).rejects.toMatchObject({ code: "reason_required" });
        expect(find).not.toHaveBeenCalled();
    });

    test("rejects an oversized reason instead of silently truncating audit data", async () => {
        await expect(ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: "x".repeat(501)
        })).rejects.toMatchObject({ code: "reason_too_long" });
    });

    test("decrypts only for the response and appends an audit event", async () => {
        const encryptedRawIp = cryptoUtils.encryptIP("203.0.113.25");
        jest.spyOn(VerifyLog, "findOne").mockReturnValue({
            sort: jest.fn().mockResolvedValue({
                _id: "log-id",
                ipInfo: {
                    encryptedRawIp,
                    country: "Thailand",
                    countryCode: "TH",
                    city: "Bangkok",
                    isp: "Example",
                    isVPN: false,
                    isProxy: false,
                    isTOR: false,
                    hosting: false
                }
            })
        });
        const update = jest.spyOn(VerifyLog, "updateOne").mockResolvedValue({
            modifiedCount: 1
        });
        jest.spyOn(GuildConfig, "updateOne").mockResolvedValue({ modifiedCount: 1 });

        const result = await ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: "investigate duplicate account",
            actor: "owner-dashboard"
        });

        expect(result.rawIp).toBe("203.0.113.25");
        expect(result.auditStatus).toBe("recorded");
        expect(update).toHaveBeenCalledWith(
            { _id: "log-id" },
            {
                $push: {
                    sensitiveAccessLog: expect.objectContaining({
                        $each: [expect.objectContaining({
                            action: "owner_reveal_raw_ip",
                            actor: "owner-dashboard",
                            reason: "investigate duplicate account",
                            viewedAt: expect.any(Number)
                        })],
                        $slice: expect.any(Number)
                    })
                }
            }
        );
        expect(GuildConfig.updateOne).toHaveBeenCalledWith(
            { guildId: "guild" },
            expect.objectContaining({
                $push: expect.objectContaining({
                    "security.sensitiveDataAccess.accessLog": expect.any(Object)
                })
            })
        );
    });

    test("reveals decrypted OAuth tokens only through audited owner action", async () => {
        jest.spyOn(OAuthUser, "findOne").mockReturnValue({
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue({
                discord: { userId: "user" },
                oauth: {
                    encryptedAccessToken: cryptoUtils.encryptToken("access-token-value"),
                    encryptedRefreshToken: cryptoUtils.encryptToken("refresh-token-value"),
                    scope: "identify guilds.join",
                    tokenType: "Bearer"
                }
            })
        });
        jest.spyOn(GuildConfig, "updateOne").mockResolvedValue({ modifiedCount: 1 });
        jest.spyOn(VerifyLog, "findOneAndUpdate").mockResolvedValue({ _id: "log-id" });

        const result = await ownerService.revealOAuthTokens({
            guildId: "guild",
            userId: "user",
            reason: "owner review",
            actor: "owner-dashboard"
        });

        expect(result.oauth.accessToken).toBe("access-token-value");
        expect(result.oauth.refreshToken).toBe("refresh-token-value");
        expect(result.auditStatus).toBe("recorded");
        expect(GuildConfig.updateOne).toHaveBeenCalledWith(
            { guildId: "guild" },
            expect.objectContaining({
                $push: expect.objectContaining({
                    "security.sensitiveDataAccess.accessLog": expect.any(Object)
                })
            })
        );
        expect(VerifyLog.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: "guild", userId: "user" }),
            expect.objectContaining({
                $push: {
                    sensitiveAccessLog: expect.objectContaining({
                        $each: [expect.objectContaining({
                            action: "owner_reveal_oauth_token",
                            reason: "owner review"
                        })],
                        $slice: expect.any(Number)
                    })
                }
            }),
            expect.objectContaining({ sort: expect.any(Object) })
        );
    });

    test("blocks OAuth token reveal when every audit write fails", async () => {
        jest.spyOn(OAuthUser, "findOne").mockReturnValue({
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue({
                discord: { userId: "user" },
                oauth: {
                    encryptedAccessToken: cryptoUtils.encryptToken("access-token-value"),
                    encryptedRefreshToken: cryptoUtils.encryptToken("refresh-token-value")
                }
            })
        });
        jest.spyOn(GuildConfig, "updateOne").mockRejectedValue(new Error("audit db down"));
        jest.spyOn(VerifyLog, "findOneAndUpdate").mockRejectedValue(new Error("audit db down"));

        await expect(ownerService.revealOAuthTokens({
            guildId: "guild",
            userId: "user",
            reason: "owner review",
            actor: "owner-dashboard"
        })).rejects.toMatchObject({ code: "audit_write_failed" });
    });

    test("blocks raw IP reveal when every audit write fails", async () => {
        jest.spyOn(VerifyLog, "findOne").mockReturnValue({
            sort: jest.fn().mockResolvedValue({
                _id: "log-id",
                ipInfo: { encryptedRawIp: cryptoUtils.encryptIP("203.0.113.25") }
            })
        });
        jest.spyOn(GuildConfig, "updateOne").mockRejectedValue(new Error("audit db down"));
        jest.spyOn(VerifyLog, "updateOne").mockRejectedValue(new Error("audit db down"));

        await expect(ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: "owner review",
            actor: "owner-dashboard"
        })).rejects.toMatchObject({ code: "audit_write_failed" });
    });

    test("blocks token reveal when audit updates match no records", async () => {
        jest.spyOn(OAuthUser, "findOne").mockReturnValue({
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue({
                discord: { userId: "user" },
                oauth: { encryptedAccessToken: cryptoUtils.encryptToken("access-token-value") }
            })
        });
        jest.spyOn(GuildConfig, "updateOne").mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
        jest.spyOn(VerifyLog, "findOneAndUpdate").mockResolvedValue(null);

        await expect(ownerService.revealOAuthTokens({
            guildId: "guild",
            userId: "user",
            reason: "owner review"
        })).rejects.toMatchObject({ code: "audit_write_failed" });
    });

    test("sensitive reveal limiter evicts expired buckets", () => {
        sensitiveAudit._test.buckets.set("expired", [1]);
        sensitiveAudit._test.buckets.set("active", [Date.now()]);

        const remaining = sensitiveAudit._test.sweepBuckets(Date.now());

        expect(remaining).toBe(1);
        expect(sensitiveAudit._test.buckets.has("expired")).toBe(false);
        expect(sensitiveAudit._test.buckets.has("active")).toBe(true);
    });

    test("Owner IP history keeps users, devices, roles, location, and risk data", () => {
        const detail = ownerService.ownerIpIdentityDetail({
            firstSeenAt: 10,
            lastSeenAt: 20,
            totalVerifications: 3,
            uniqueUsers: 2,
            lastCountry: "Thailand",
            lastCity: "Bangkok",
            lastIsp: "Example ISP",
            isVPN: true,
            lastRiskFlags: ["vpn"],
            users: [{ userId: "12345678901234567", lastRoles: ["role-a"] }],
            deviceFingerprints: [{ fingerprintHash: "hash" }],
            roleSnapshots: [{ userId: "12345678901234567", roles: ["role-a"] }]
        });

        expect(detail.location).toMatchObject({ country: "Thailand", city: "Bangkok", isp: "Example ISP" });
        expect(detail.signals.isVPN).toBe(true);
        expect(detail.lastRiskFlags).toEqual(["vpn"]);
        expect(detail.users).toHaveLength(1);
        expect(detail.deviceFingerprints).toHaveLength(1);
        expect(detail.roleSnapshots).toHaveLength(1);
    });

    test("Owner can paginate every canonical IP-history category", async () => {
        jest.spyOn(ipIdentityHistory, "findLinkForUser").mockResolvedValue({ ipHash: "hash" });
        jest.spyOn(ipIdentityHistory, "loadHistoryPage").mockResolvedValue({
            kind: "roles",
            items: [{ eventId: "event" }],
            page: 2,
            limit: 100,
            total: 501,
            hasMore: true
        });
        jest.spyOn(GuildConfig, "updateOne").mockResolvedValue({ modifiedCount: 1 });
        jest.spyOn(VerifyLog, "findOneAndUpdate").mockResolvedValue({ _id: "log-id" });

        await expect(ownerService.getOwnerIpHistoryPage({
            guildId: "guild",
            userId: "user",
            kind: "roles",
            page: 2,
            limit: 100
        })).resolves.toMatchObject({
            success: true,
            total: 501,
            hasMore: true,
            items: [{ eventId: "event" }]
        });
        expect(GuildConfig.updateOne).toHaveBeenCalled();
        expect(VerifyLog.findOneAndUpdate).toHaveBeenCalled();
    });
});
