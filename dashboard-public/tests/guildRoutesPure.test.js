const guildRoute = require("../routes/guild");
const guildDashboardRoute = require("../routes/guildDashboard");

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

test("guild dashboard safeLog preserves normalized empty result fallback", () => {
  const log = guildDashboardRoute._test.safeLog({ _id: "log1" });

  expect(log.result).toBe("");
});
