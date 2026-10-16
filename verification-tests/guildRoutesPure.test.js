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

test("guildRoute panel comparison and rollback helpers work correctly", () => {
  const {
    safeRollbackEmbed,
    panelRollbackPayload,
    panelConfigFromDiscordMessage,
    comparablePanel,
    panelDifferences,
    clonePlainValue,
    tokenRevealErrorStatus
  } = guildRoute._test;

  // safeRollbackEmbed
  const rawEmbed = { title: "Title", extra: "Ignore", color: 0x5865f2 };
  const safe = safeRollbackEmbed(rawEmbed);
  expect(safe.title).toBe("Title");
  expect(safe.color).toBe(0x5865f2);
  expect(safe.extra).toBeUndefined();

  // panelRollbackPayload
  const payload = panelRollbackPayload({
    content: "Notice",
    embeds: [rawEmbed],
    components: []
  });
  expect(payload.content).toBe("Notice");
  expect(payload.embeds).toHaveLength(1);
  expect(payload.embeds[0].title).toBe("Title");

  // comparablePanel & panelDifferences
  const panelA = { title: "A", description: "Desc", color: "#5865F2" };
  const panelB = { title: "B", description: "Desc", color: "#5865F2" };
  const compA = comparablePanel(panelA);
  const compB = comparablePanel(panelB);
  const diffs = panelDifferences(compA, compB);
  expect(diffs).toContain("title");
  expect(diffs).not.toContain("description");

  // panelConfigFromDiscordMessage
  const discordMsg = {
    content: "Hello",
    embeds: [{ title: "Embed Title", description: "Embed Desc", color: 0x5865f2 }],
    components: [{ type: 1, components: [{ type: 2, label: "Click", url: "https://example.com" }] }]
  };
  const parsed = panelConfigFromDiscordMessage(discordMsg);
  expect(parsed.title).toBe("Embed Title");
  expect(parsed.description).toBe("Embed Desc");
  expect(parsed.buttonText).toBe("Click");
  expect(parsed.verifyType).toBe("oauth");

  // clonePlainValue
  expect(clonePlainValue({ a: 1 })).toEqual({ a: 1 });
  expect(clonePlainValue(null)).toEqual({});

  // tokenRevealErrorStatus
  expect(tokenRevealErrorStatus("member_not_found")).toBe(404);
  expect(tokenRevealErrorStatus("OTHER")).toBe(500);
});

test("guildRoute maskWebhookUrl, saveConfigWithRetry, and rollback helpers", async () => {
  const {
    maskWebhookUrl,
    saveConfigWithRetry,
    rollbackDiscordPanel,
    persistedPanelMatches
  } = guildRoute._test;

  // maskWebhookUrl
  expect(maskWebhookUrl(null)).toBe(null);
  expect(maskWebhookUrl("invalid-url")).toBe("••••••••••••");
  expect(maskWebhookUrl("https://discord.com/api/webhooks/1234567890/tokenABC123")).toMatch(/1234567890/);

  // saveConfigWithRetry success
  const mockConfigSuccess = {
    attempts: 0,
    async save() {
      this.attempts++;
      return this;
    }
  };
  const saved = await saveConfigWithRetry(mockConfigSuccess, 2);
  expect(saved).toBe(mockConfigSuccess);
  expect(mockConfigSuccess.attempts).toBe(1);

  // saveConfigWithRetry failure
  const mockConfigFail = {
    attempts: 0,
    async save() {
      this.attempts++;
      throw new Error("DB_WRITE_ERROR");
    }
  };
  await expect(saveConfigWithRetry(mockConfigFail, 1)).rejects.toThrow("DB_WRITE_ERROR");

  // rollbackDiscordPanel failure handling
  const rb = await rollbackDiscordPanel("chan_1", "msg_1", {});
  expect(rb.complete).toBe(false);

  // persistedPanelMatches
  const GuildConfig = require("../discord/verification/models/GuildConfig");
  jest.spyOn(GuildConfig, "findOne").mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve({
        verification: { channelId: "c1", messageId: "m1", panelRevision: "r1" }
      })
    })
  });
  const pm = await persistedPanelMatches("guild_1", { channelId: "c1", messageId: "m1", panelRevision: "r1" });
  expect(pm.status).toBe("matched");
  jest.restoreAllMocks();
});


