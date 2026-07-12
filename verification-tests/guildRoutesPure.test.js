const guildRoute = require("../discord/verification/routes/guild");
const guildDashboardRoute = require("../discord/verification/routes/guildDashboard");

test("mergeVerificationConfig preserves existing panel on unrelated settings saves", () => {
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
      antiAlt: {
        enabled: true
      }
    }
  );

  expect(merged.panel.title).toBe("Existing title");
  expect(merged.panel.description).toBe("Existing description");
  expect(merged.panel.buttonLabel).toBe("Verify now");
  expect(merged.antiAlt.enabled).toBe(true);
});

test("mergeVerificationConfig keeps direct mode when saving only antiAlt patch", () => {
  const merged = guildRoute._test.mergeVerificationConfig(
    {
      verifyType: "direct",
      oauthMode: "direct",
      blockHosting: true,
      panel: {
        verifyType: "direct",
        title: "Direct verify"
      },
      antiAlt: {
        enabled: false,
        maxUsersPerIp: 9
      }
    },
    {
      antiAlt: {
        enabled: true
      }
    }
  );

  expect(merged.verifyType).toBe("direct");
  expect(merged.oauthMode).toBe("direct");
  expect(merged.panel.verifyType).toBe("direct");
  expect(merged.blockHosting).toBe(true);
  expect(merged.antiAlt.enabled).toBe(true);
  expect(merged.antiAlt.maxUsersPerIp).toBe(9);
});

test("guild dashboard safeLog preserves normalized empty result fallback", () => {
  const log = guildDashboardRoute._test.safeLog({ _id: "log1" });

  expect(log.result).toBe("");
});

test("token reveal maps failed audit persistence to service unavailable", () => {
  expect(guildRoute._test.tokenRevealErrorStatus("audit_write_failed")).toBe(503);
});
