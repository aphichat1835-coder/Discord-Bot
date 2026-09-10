const guildRoute = require("../discord/verification/routes/guild");
const guildDashboardRoute = require("../discord/verification/routes/guildDashboard");
const fs = require("node:fs");

test("mergeVerificationConfig preserves the panel when security rules change", () => {
  const merged = guildRoute._test.mergeVerificationConfig(
    {
      verifyType: "oauth",
      panel: {
        verifyType: "oauth",
        title: "Existing title",
        description: "Existing description",
        buttonLabel: "Verify now"
      }
    },
    {
      securityRules: {
        ipDuplicate: { enabled: true, action: "kick", threshold: 4 }
      }
    }
  );

  expect(merged.panel.title).toBe("Existing title");
  expect(merged.panel.description).toBe("Existing description");
  expect(merged.panel.buttonLabel).toBe("Verify now");
  expect(merged.securityRules.ipDuplicate).toMatchObject({ enabled: true, action: "kick", threshold: 4 });
});

test("mergeVerificationConfig keeps direct mode when saving one independent rule", () => {
  const merged = guildRoute._test.mergeVerificationConfig(
    {
      verifyType: "direct",
      oauthMode: "direct",
      blockHosting: true,
      panel: {
        verifyType: "direct",
        title: "Direct verify"
      },
      securityRules: {
        ipDuplicate: { enabled: false, action: "allow", threshold: 9 }
      }
    },
    {
      securityRules: {
        ipDuplicate: { enabled: true, action: "ban", threshold: 4 }
      }
    }
  );

  expect(merged.verifyType).toBe("direct");
  expect(merged.oauthMode).toBe("direct");
  expect(merged.panel.verifyType).toBe("direct");
  expect(merged.blockHosting).toBe(true);
  expect(merged.securityRules.ipDuplicate).toMatchObject({ enabled: true, action: "ban", threshold: 4 });
});

test("guild dashboard computes factual review counts", async () => {
  const VerifyLog = require("../discord/verification/models/VerifyLog");
  const counts = [2, 1, 0, 1, 1, 1, 0, 0, 0];
  jest.spyOn(VerifyLog, "countDocuments").mockImplementation(() => Promise.resolve(counts.shift()));
  const overview = await guildDashboardRoute._test.buildStats("guild");
  expect(overview).toMatchObject({ total: 2, success: 1, failed: 1, reviewRequired: 1, vpn: 1 });
  jest.restoreAllMocks();
});

test("OAuth recovery role mutations require owner auth, current guild access, and CSRF", () => {
  const source = fs.readFileSync("discord/verification/routes/guild.js", "utf8");

  expect(source).toContain('router.post("/api/guild/:guildId/oauth-recovery/member/:userId/revoke-role", requireAdmin, requireGuildAdmin, requireCsrf');
  expect(source).toContain('router.post("/api/guild/:guildId/oauth-recovery/revoke-all-roles", requireAdmin, requireGuildAdmin, requireCsrf');
  expect(source).toContain('confirmation !== "REVOKE_OAUTH_RECOVERY_ROLES"');
  expect(source).toContain("oauth_recovery_confirmation_mismatch");
});


test("panel sync GET is read-only and never creates guild configuration", () => {
  const source = fs.readFileSync("discord/verification/routes/guild.js", "utf8");
  const start = source.indexOf('router.get("/api/guild/:guildId/verify/panel/sync"');
  const end = source.indexOf('router.post("/api/guild/:guildId/verify/validate"', start);
  const route = source.slice(start, end);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(route).toContain("GuildConfig.findOne({ guildId }).lean()");
  expect(route).not.toContain("ensureGuildConfig(");
  expect(route).not.toMatch(/updateOne|findOneAndUpdate|save\(/);
});
