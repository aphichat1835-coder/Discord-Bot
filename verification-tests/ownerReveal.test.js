"use strict";

const VerifyLog = require("../discord/verification/models/VerifyLog");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const GuildConfig = require("../discord/verification/models/GuildConfig");
const cryptoUtils = require("../discord/verification/utils/crypto");
const ownerService = require("../discord/verification/ownerService");
const ipIdentityHistory = require("../discord/verification/services/ipIdentityHistoryService");

describe("Owner full member data", () => {
  const previousKey = process.env.ENCRYPTION_KEY;
  const guildId = "123456789012345678";
  const userId = "223456789012345678";

  function queryResult(value) {
    return {
      where: jest.fn().mockReturnThis(),
      equals: jest.fn().mockReturnThis(),
      exists: jest.fn().mockReturnThis(),
      ne: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(value)
    };
  }

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "owner-reveal-test-key-at-least-32-bytes";
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  });

  afterEach(() => jest.restoreAllMocks());

  test("decrypts the latest stored IP without an extra approval workflow", async () => {
    jest.spyOn(VerifyLog, "findOne").mockReturnValue({
      sort: jest.fn().mockResolvedValue({
        _id: "log-id",
        ipInfo: {
          encryptedRawIp: cryptoUtils.encryptIP("203.0.113.25"),
          country: "Thailand",
          city: "Bangkok",
          isVPN: false
        }
      })
    });

    await expect(ownerService.revealRawIp({ guildId: "guild", userId: "user" }))
      .resolves.toMatchObject({ success: true, rawIp: "203.0.113.25", ipInfo: { country: "Thailand" } });
  });

  test("decrypts OAuth tokens directly for the authenticated Owner route", async () => {
    jest.spyOn(VerifyLog, "findOne").mockReturnValue(queryResult({ _id: "association" }));
    jest.spyOn(OAuthUser, "findOne").mockReturnValue(queryResult({
        discord: { userId },
        oauth: {
          encryptedAccessToken: cryptoUtils.encryptToken("access-token-value"),
          encryptedRefreshToken: cryptoUtils.encryptToken("refresh-token-value"),
          scope: "identify guilds email"
        }
    }));

    await expect(ownerService.revealOAuthTokens({ guildId, userId }))
      .resolves.toMatchObject({
        success: true,
        oauth: {
          accessToken: "access-token-value",
          refreshToken: "refresh-token-value",
          scope: "identify guilds email"
        }
      });
  });

  test("rejects OAuth token access when the user is unrelated to the selected guild", async () => {
    jest.spyOn(VerifyLog, "findOne").mockReturnValue(queryResult(null));
    jest.spyOn(OAuthUser, "findOne").mockReturnValue(queryResult(null));

    await expect(ownerService.revealOAuthTokens({ guildId, userId }))
      .rejects.toMatchObject({ code: "member_not_found" });

    const oauthQuery = OAuthUser.findOne.mock.results[0].value;
    expect(oauthQuery.where).toHaveBeenCalledWith("lastVerify.guildId");
    expect(oauthQuery.equals).toHaveBeenCalledWith(guildId);
  });

  test("rejects member and full-detail reads before loading unrelated OAuth secrets", async () => {
    jest.spyOn(VerifyLog, "findOne").mockReturnValue(queryResult(null));
    jest.spyOn(VerifyLog, "find").mockReturnValue(queryResult([]));
    jest.spyOn(OAuthUser, "findOne").mockReturnValue(queryResult(null));

    await expect(ownerService.getMemberDetail(guildId, userId, { canViewSensitive: true }))
      .rejects.toMatchObject({ code: "member_not_found" });
    await expect(ownerService.getOwnerFullMemberDetail({ guildId, userId }))
      .rejects.toMatchObject({ code: "member_not_found" });

    expect(OAuthUser.findOne).toHaveBeenCalledTimes(2);
    for (const result of OAuthUser.findOne.mock.results) {
      expect(result.value.where).toHaveBeenCalledWith("lastVerify.guildId");
    }
  });

  test("marks incomplete OAuth credentials for owner recovery without requiring optional Nitro scope", () => {
    const completeScopes = "identify email connections guilds guilds.members.read guilds.join";
    const complete = {
      encryptedAccessToken: cryptoUtils.encryptToken("access-token-value"),
      encryptedRefreshToken: cryptoUtils.encryptToken("refresh-token-value"),
      scope: completeScopes,
      expiresAt: Date.now() + 60_000
    };

    expect(ownerService.tokenRecoveryReasons(complete)).toEqual([]);
    expect(ownerService.tokenRecoveryReasons({ scope: completeScopes })).toEqual([
      "missing_access_token",
      "missing_refresh_token"
    ]);
    expect(ownerService.tokenRecoveryReasons({
      ...complete,
      scope: "identify email"
    })).toEqual(expect.arrayContaining([
      "missing_scope:connections",
      "missing_scope:guilds.members.read"
    ]));
  });

  test("recovery center only returns successful recipients whose stored OAuth is incomplete", async () => {
    const guildId = "12345678901234567";
    const incompleteUserId = "22345678901234567";
    const completeUserId = "32345678901234567";
    const roleId = "42345678901234567";
    const completeScopes = "identify email connections guilds guilds.members.read guilds.join";
    jest.spyOn(GuildConfig, "findOne").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ verification: { roleId } })
    });
    jest.spyOn(VerifyLog, "aggregate").mockResolvedValue([
      { _id: incompleteUserId, roleId, verifiedAt: 20 },
      { _id: completeUserId, roleId, verifiedAt: 10 }
    ]);
    jest.spyOn(OAuthUser, "find").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { discord: { userId: incompleteUserId, username: "needs-oauth" }, oauth: { scope: "identify" } },
        {
          discord: { userId: completeUserId, username: "complete" },
          oauth: {
            encryptedAccessToken: cryptoUtils.encryptToken("access-token-value"),
            encryptedRefreshToken: cryptoUtils.encryptToken("refresh-token-value"),
            scope: completeScopes,
            expiresAt: Date.now() + 60_000
          }
        }
      ])
    });

    await expect(ownerService.getOAuthRecoveryCenter(guildId)).resolves.toMatchObject({
      success: true,
      guildId,
      scanned: 2,
      count: 1,
      members: [{ userId: incompleteUserId, roleId }]
    });
  });

  test("keeps identity users, devices, roles, location, and factual findings", () => {
    const detail = ownerService.ownerIpIdentityDetail({
      firstSeenAt: 10,
      lastSeenAt: 20,
      totalVerifications: 3,
      uniqueUsers: 2,
      lastCountry: "Thailand",
      lastCity: "Bangkok",
      lastIsp: "Example ISP",
      isVPN: true,
      lastFindings: ["vpn"],
      users: [{ userId: "12345678901234567", lastRoles: ["role-a"] }],
      deviceFingerprints: [{ fingerprintHash: "hash" }],
      roleSnapshots: [{ userId: "12345678901234567", roles: ["role-a"] }]
    });

    expect(detail.location).toMatchObject({ country: "Thailand", city: "Bangkok", isp: "Example ISP" });
    expect(detail.signals.isVPN).toBe(true);
    expect(detail.lastFindings).toEqual(["vpn"]);
    expect(detail.users).toHaveLength(1);
    expect(detail.deviceFingerprints).toHaveLength(1);
    expect(detail.roleSnapshots).toHaveLength(1);
  });

  test("paginates every canonical IP-history category without writing access logs", async () => {
    jest.spyOn(ipIdentityHistory, "findLinkForUser").mockResolvedValue({ ipHash: "hash" });
    jest.spyOn(ipIdentityHistory, "loadHistoryPage").mockResolvedValue({
      kind: "roles",
      items: [{ eventId: "event" }],
      page: 2,
      limit: 100,
      total: 501,
      hasMore: true
    });

    await expect(ownerService.getOwnerIpHistoryPage({
      guildId: "guild",
      userId: "user",
      kind: "roles",
      page: 2,
      limit: 100
    })).resolves.toMatchObject({ success: true, total: 501, hasMore: true });
  });
});
