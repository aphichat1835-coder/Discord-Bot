"use strict";

const VerifyLog = require("../discord/verification/models/VerifyLog");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const cryptoUtils = require("../discord/verification/utils/crypto");
const ownerService = require("../discord/verification/ownerService");
const ipIdentityHistory = require("../discord/verification/services/ipIdentityHistoryService");

describe("Owner full member data", () => {
  const previousKey = process.env.ENCRYPTION_KEY;

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
    jest.spyOn(OAuthUser, "findOne").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        discord: { userId: "user" },
        oauth: {
          encryptedAccessToken: cryptoUtils.encryptToken("access-token-value"),
          encryptedRefreshToken: cryptoUtils.encryptToken("refresh-token-value"),
          scope: "identify guilds email"
        }
      })
    });

    await expect(ownerService.revealOAuthTokens({ guildId: "guild", userId: "user" }))
      .resolves.toMatchObject({
        success: true,
        oauth: {
          accessToken: "access-token-value",
          refreshToken: "refresh-token-value",
          scope: "identify guilds email"
        }
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
