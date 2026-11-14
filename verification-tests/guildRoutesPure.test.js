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

test("guildRoute resolveUrlFormatText and resolveWorkerReadyText readiness resolvers", () => {
  const { resolveUrlFormatText, resolveWorkerReadyText } = guildRoute._test;

  // resolveUrlFormatText
  expect(resolveUrlFormatText({ urlValid: true })).toBe("รูปแบบ Webhook URL ถูกต้องและพร้อมส่งข้อมูล");
  expect(resolveUrlFormatText({ urlValid: false, urlConfigured: true })).toBe("รูปแบบ Webhook URL ไม่ถูกต้อง");
  expect(resolveUrlFormatText({ urlValid: false, urlConfigured: false })).toBe("ยังไม่ได้ระบุ Webhook URL");

  // resolveWorkerReadyText
  expect(resolveWorkerReadyText({ databaseReady: { ok: false } })).toBe("ฐานข้อมูลไม่พร้อมทำงาน ไม่สามารถส่งข้อมูลได้");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: false } })).toBe("ระบบคิวส่งข้อมูลไม่พร้อมทำงาน");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: true }, urlValid: false })).toBe("รูปแบบ Webhook URL ไม่ถูกต้อง");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: true }, urlValid: true, enabled: false })).toBe("ระบบยังไม่เริ่มทำงาน กรุณาบันทึก URL และกดเริ่มทำงาน");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: true }, urlValid: true, enabled: true, activeJob: true })).toBe("ระบบกำลังส่งข้อมูลประวัติย้อนหลัง");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: true }, urlValid: true, enabled: true, stats: { retry: 1 } })).toBe("ระบบทำงานอยู่ (มีรายการรอส่งใหม่)");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: true }, urlValid: true, enabled: true, stats: { failed: 1 } })).toBe("ระบบทำงานอยู่ (พบข้อผิดพลาดบางรายการ)");
  expect(resolveWorkerReadyText({ databaseReady: { ok: true }, queueReady: { ok: true }, urlValid: true, enabled: true, stats: {} })).toBe("ระบบพร้อมส่งข้อมูลตามเวลาจริง");
});

test("guildRoute input cleaners, pagination, and error status resolvers", () => {
  const {
    cleanText,
    cleanHexColor,
    cleanUrl,
    parsePage,
    parseLimit,
    ipHistoryErrorStatus,
    pagination,
    sanitizeVerificationBasicFlags,
    sanitizeSingleSecurityRule
  } = guildRoute._test;

  // cleanText
  expect(cleanText(null)).toBeUndefined();
  expect(cleanText(undefined)).toBeUndefined();
  expect(cleanText("  hello world  ", 5)).toBe("hello");

  // cleanHexColor
  expect(cleanHexColor(null)).toBeUndefined();
  expect(cleanHexColor("")).toBeUndefined();
  expect(cleanHexColor("#FF00AA")).toBe("#FF00AA");
  expect(cleanHexColor("00FF00")).toBe("#00FF00");
  expect(cleanHexColor("invalid_hex")).toBeUndefined();

  // cleanUrl
  expect(cleanUrl(null)).toBeUndefined();
  expect(cleanUrl("")).toBeUndefined();
  expect(cleanUrl("not-a-url")).toBeUndefined();
  expect(cleanUrl("javascript:alert(1)")).toBeUndefined();
  expect(cleanUrl("https://example.com/webhook")).toBe("https://example.com/webhook");

  // parsePage & parseLimit
  expect(parsePage("-5")).toBe(0);
  expect(parsePage("3")).toBe(3);
  expect(parseLimit("0", 25, 100)).toBe(25);
  expect(parseLimit("1", 25, 100)).toBe(1);
  expect(parseLimit("200", 25, 100)).toBe(100);
  expect(parseLimit(null, 50, 100)).toBe(50);

  // ipHistoryErrorStatus
  expect(ipHistoryErrorStatus("invalid_history_kind")).toBe(400);
  expect(ipHistoryErrorStatus("ip_history_not_found")).toBe(404);
  expect(ipHistoryErrorStatus("other_error")).toBe(500);

  // pagination
  const p1 = pagination(0, 10, 25);
  expect(p1.hasMore).toBe(true);
  expect(p1.nextPage).toBe(1);
  expect(p1.prevPage).toBeNull();

  const p2 = pagination(2, 10, 25);
  expect(p2.hasMore).toBe(false);
  expect(p2.nextPage).toBeNull();
  expect(p2.prevPage).toBe(1);

  // sanitizeVerificationBasicFlags
  const flags = sanitizeVerificationBasicFlags({
    enabled: true,
    blockVPN: "true",
    minAccountAgeDays: "14",
    minConnections: "2",
    roleId: "123456789012345678",
    ignoredField: "skip"
  });
  expect(flags.enabled).toBe(true);
  expect(flags.blockVPN).toBe(true);
  expect(flags.minAccountAgeDays).toBe(14);
  expect(flags.minConnections).toBe(2);
  expect(flags.roleId).toBe("123456789012345678");
  expect(flags.ignoredField).toBeUndefined();

  // sanitizeSingleSecurityRule
  expect(sanitizeSingleSecurityRule(null, "ipDuplicate")).toBeNull();
  expect(sanitizeSingleSecurityRule([], "ipDuplicate")).toBeNull();
  const rule = sanitizeSingleSecurityRule({
    enabled: "true",
    action: "kick",
    timeoutMinutes: 120,
    threshold: 5
  }, "ipDuplicate");
  expect(rule.enabled).toBe(true);
  expect(rule.action).toBe("kick");
  expect(rule.timeoutMinutes).toBe(120);
  expect(rule.threshold).toBe(5);
});

test("guildRoute panelDifferences, comparablePanel, and safeRollbackEmbed", () => {
  const {
    comparablePanel,
    panelDifferences,
    safeRollbackEmbed,
    panelRollbackPayload
  } = guildRoute._test;

  const p1 = {
    title: "Verify",
    description: "Click button to verify",
    color: "#00FF00",
    buttonLabel: "Verify"
  };
  const p2 = {
    title: "Verify",
    description: "Click button to verify",
    color: "#FF0000",
    buttonLabel: "Start"
  };

  const comp1 = comparablePanel(p1);
  const comp2 = comparablePanel(p2);
  expect(comp1.title).toBe("Verify");

  const diffs = panelDifferences(p1, p2);
  expect(diffs).toContain("color");
  expect(diffs).toContain("buttonLabel");

  const safeEmbed = safeRollbackEmbed({ title: "My Title", description: "My Desc", color: 0x00FF00 });
  expect(safeEmbed.title).toBe("My Title");

  const rollbackPayload = panelRollbackPayload({
    embeds: [{ title: "Restored Title", description: "Restored Desc" }],
    components: []
  });
  expect(rollbackPayload.embeds).toHaveLength(1);
  expect(rollbackPayload.embeds[0].title).toBe("Restored Title");
});

test("sanitizeVerificationBasicFlags normalizes legacy string boolean inputs", () => {
  const { sanitizeVerificationBasicFlags } = guildRoute._test;

  const disabled = sanitizeVerificationBasicFlags({
    blockVPN: "false",
    blockHosting: "0",
    requireEmail: "off",
    requireConnections: "no"
  });
  expect(disabled.blockVPN).toBe(false);
  expect(disabled.blockHosting).toBe(false);
  expect(disabled.requireEmail).toBe(false);
  expect(disabled.requireConnections).toBe(false);

  const enabled = sanitizeVerificationBasicFlags({
    blockVPN: "true",
    blockHosting: "1",
    requireEmail: "on",
    requireConnections: "yes"
  });
  expect(enabled.blockVPN).toBe(true);
  expect(enabled.blockHosting).toBe(true);
  expect(enabled.requireEmail).toBe(true);
  expect(enabled.requireConnections).toBe(true);
});

test("mergeVerificationConfig synchronizes legacy blockVPN and blockHosting into securityRules", () => {
  const { mergeVerificationConfig } = guildRoute._test;

  // Initial state with VPN enabled
  const base = {
    securityRules: {
      vpnProxyTor: { enabled: true, action: "deny_role" },
      hosting: { enabled: true, action: "deny_role" }
    }
  };

  // Disabling via string booleans
  const mergedDisabling = mergeVerificationConfig(base, {
    blockVPN: "false",
    blockHosting: "0"
  });
  expect(mergedDisabling.securityRules.vpnProxyTor.enabled).toBe(false);
  expect(mergedDisabling.blockVPN).toBe(false);
  expect(mergedDisabling.securityRules.hosting.enabled).toBe(false);
  expect(mergedDisabling.blockHosting).toBe(false);

  // Enabling via string booleans
  const mergedEnabling = mergeVerificationConfig(mergedDisabling, {
    blockVPN: "true",
    blockHosting: "1"
  });
  expect(mergedEnabling.securityRules.vpnProxyTor.enabled).toBe(true);
  expect(mergedEnabling.blockVPN).toBe(true);
  expect(mergedEnabling.securityRules.hosting.enabled).toBe(true);
  expect(mergedEnabling.blockHosting).toBe(true);

  // Synchronizing when securityRules is provided directly
  const mergedDirectRules = mergeVerificationConfig(mergedEnabling, {
    securityRules: {
      vpnProxyTor: { enabled: false },
      hosting: { enabled: false }
    }
  });
  expect(mergedDirectRules.securityRules.vpnProxyTor.enabled).toBe(false);
  expect(mergedDirectRules.blockVPN).toBe(false);
  expect(mergedDirectRules.securityRules.hosting.enabled).toBe(false);
  expect(mergedDirectRules.blockHosting).toBe(false);
});

test("serializeConfig exposes blockVPN and blockHosting consistently with security rule state", () => {
  const { serializeConfig } = guildRoute._test;

  const docVPNEnabled = {
    guildId: "123456789012345678",
    guildName: "Test Guild",
    verification: {
      securityRules: {
        vpnProxyTor: { enabled: true, action: "deny_role" },
        hosting: { enabled: false, action: "allow" }
      }
    }
  };

  const serialized1 = serializeConfig(docVPNEnabled);
  expect(serialized1.verification.blockVPN).toBe(true);
  expect(serialized1.verification.blockHosting).toBe(false);

  const docHostingEnabled = {
    toObject: () => ({
      guildId: "123456789012345678",
      guildName: "Test Guild",
      verification: {
        securityRules: {
          vpnProxyTor: { enabled: false, action: "allow" },
          hosting: { enabled: true, action: "deny_role" }
        }
      }
    })
  };

  const serialized2 = serializeConfig(docHostingEnabled);
  expect(serialized2.verification.blockVPN).toBe(false);
  expect(serialized2.verification.blockHosting).toBe(true);
});

test("mergeVerificationConfig synchronizes legacy blockVPN and blockHosting on unrelated saves", () => {
  const { mergeVerificationConfig } = guildRoute._test;

  // Legacy config with no stored securityRules
  const legacyDoc = {
    blockVPN: true,
    blockHosting: true,
    panel: { title: "Old Title" }
  };

  // Unrelated change: updating panel only
  const merged = mergeVerificationConfig(legacyDoc, {
    panel: { title: "New Title" }
  });

  expect(merged.securityRules.vpnProxyTor.enabled).toBe(true);
  expect(merged.blockVPN).toBe(true);
  expect(merged.securityRules.hosting.enabled).toBe(true);
  expect(merged.blockHosting).toBe(true);
  expect(merged.panel.title).toBe("New Title");

  // When stored securityRules explicitly disagrees with legacy flag, stored rule wins
  const conflictingDoc = {
    blockVPN: true,
    securityRules: {
      vpnProxyTor: { enabled: false, action: "allow" }
    }
  };
  const mergedConflict = mergeVerificationConfig(conflictingDoc, {
    panel: { title: "New Title" }
  });
  expect(mergedConflict.securityRules.vpnProxyTor.enabled).toBe(false);
  expect(mergedConflict.blockVPN).toBe(false);
});
