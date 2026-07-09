"use strict";

const VerifyLog = require("../discord/verification/models/VerifyLog");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const GuildConfig = require("../discord/verification/models/GuildConfig");
const cryptoUtils = require("../discord/verification/utils/crypto");
const ownerService = require("../discord/verification/ownerService");
const sensitiveAudit = require("../discord/verification/services/sensitiveAuditService");

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
                        action: "owner_reveal_raw_ip",
                        actor: "owner-dashboard",
                        reason: "investigate duplicate account",
                        viewedAt: expect.any(Number)
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
                        action: "owner_reveal_oauth_token",
                        reason: "owner review"
                    })
                }
            }),
            expect.objectContaining({ sort: expect.any(Object) })
        );
    });

    test("still reveals OAuth tokens with failed audit status when audit writes fail open by owner decision", async () => {
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

        const result = await ownerService.revealOAuthTokens({
            guildId: "guild",
            userId: "user",
            reason: "owner review",
            actor: "owner-dashboard"
        });

        expect(result.oauth.accessToken).toBe("access-token-value");
        expect(result.oauth.refreshToken).toBe("refresh-token-value");
        expect(result.auditStatus).toBe("failed");
        expect(result.audit.failOpen).toBe(true);
        expect(JSON.stringify(result.audit)).not.toContain("access-token-value");
        expect(JSON.stringify(result.audit)).not.toContain("refresh-token-value");
    });
});
