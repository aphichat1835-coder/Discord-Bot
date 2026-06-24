const snapshots = require("../utils/verificationSnapshots");

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
