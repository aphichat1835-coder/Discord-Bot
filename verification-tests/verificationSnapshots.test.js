const snapshots = require("../discord/verification/utils/verificationSnapshots");

test("safeIpInfo preserves normalized ASN and hosting fields", () => {
  const ipInfo = snapshots.safeIpInfo({
    as: "AS123 Example",
    asn: "123",
    isHosting: true,
    hosting: false
  });

  expect(ipInfo.asn).toBe("123");
  expect(ipInfo.isHosting).toBe(true);
  expect(ipInfo.hosting).toBe(false);
});

test("safeIpInfo preserves location confidence without exposing raw IP", () => {
  const ipInfo = snapshots.safeIpInfo({
    rawIp: "203.0.113.10",
    encryptedRawIp: "encrypted",
    accuracyRadiusKm: 25,
    locationConfidence: "high",
    locationConfidenceScore: 88,
    locationConfidenceReasons: ["providers_agree_country"],
    lookupConsensusUsed: true,
    lookupProviderCount: 3,
    anycast: true,
    networkType: "Cellular"
  });

  expect(ipInfo).toMatchObject({
    rawIp: null,
    ip: null,
    accuracyRadiusKm: 25,
    locationConfidence: "high",
    locationConfidenceScore: 88,
    lookupConsensusUsed: true,
    lookupProviderCount: 3,
    anycast: true,
    networkType: "Cellular"
  });
  expect(JSON.stringify(ipInfo)).not.toContain("203.0.113.10");
  expect(JSON.stringify(ipInfo)).not.toContain("encrypted");
});

test("buildVerifyLogParts falls back to nested Discord member snapshot", () => {
  const parts = snapshots.buildVerifyLogParts({
    discordSnapshot: {
      member: {
        joinedAt: 123,
        roles: ["role1", "role2"]
      }
    }
  });

  expect(parts.member.joinedAt).toBe(123);
  expect(parts.member.roleCount).toBe(2);
  expect(parts.member.roles).toEqual(["role1", "role2"]);
});

test("safeDiscordSnapshot preserves explicit false and zero security values", () => {
  const snapshot = snapshots.safeDiscordSnapshot({
    profileSnapshot: {
      id: "u1",
      emailVerified: false,
      mfaEnabled: false,
      premiumType: 0,
      flags: 0,
      publicFlags: 0
    },
    emailVerified: true,
    mfaEnabled: true,
    premiumType: 2,
    flags: 64,
    publicFlags: 128
  });

  expect(snapshot.emailVerified).toBe(false);
  expect(snapshot.mfaEnabled).toBe(false);
  expect(snapshot.premiumType).toBe(0);
  expect(snapshot.flags).toBe(0);
  expect(snapshot.publicFlags).toBe(0);
});

test("VerifyLog owner summary includes raw IP and account detail directly", () => {
  const parts = snapshots.buildVerifyLogParts({
    ipInfo: { rawIp: "203.0.113.10", country: "TH" },
    discordSnapshot: { email: "owner-visible@example.test" }
  }, true);
  const common = snapshots.buildVerifyLogCommon(parts, { canViewSensitive: true });

  expect(parts.discord.email).toBe("owner-visible@example.test");
  expect(parts.ipInfo.rawIp).toBe("203.0.113.10");
  expect(common.rawIp).toBe("203.0.113.10");
  expect(common.sensitiveRedacted).toBe(false);
});
