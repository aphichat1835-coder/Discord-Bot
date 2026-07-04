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
