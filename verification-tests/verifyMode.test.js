"use strict";

const {
  VERIFY_MODES,
  RULE_ACTIONS,
  SECURITY_RULE_KEYS,
  DEFAULT_SECURITY_RULES,
  normalizeVerifyMode,
  normalizeRuleAction,
  clampNumber,
  normalizeSecurityRule,
  normalizeSecurityRules,
  normalizeVerificationConfig
} = require("../discord/verification/utils/verifyMode");

describe("verification modes", () => {
  test.each([
    ["oauth", VERIFY_MODES.OAUTH],
    ["oauth2", VERIFY_MODES.OAUTH],
    [true, VERIFY_MODES.OAUTH],
    ["direct", VERIFY_MODES.DIRECT],
    ["direct-role", VERIFY_MODES.DIRECT],
    [false, VERIFY_MODES.DIRECT]
  ])("normalizes %p to %s", (input, expected) => {
    expect(normalizeVerifyMode(input)).toBe(expected);
  });

  test("keeps panel and top-level modes synchronized", () => {
    const result = normalizeVerificationConfig({
      verifyType: "direct",
      panel: { title: "รับยศ", buttonLabel: "รับยศทันที" }
    });
    expect(result.verifyType).toBe(VERIFY_MODES.DIRECT);
    expect(result.oauthMode).toBe(VERIFY_MODES.DIRECT);
    expect(result.panel.verifyType).toBe(VERIFY_MODES.DIRECT);
    expect(result.panel.buttonText).toBe("รับยศทันที");
  });
});

describe("independent verification security rules", () => {
  test("exposes seven independently configurable checks", () => {
    expect(SECURITY_RULE_KEYS).toEqual([
      "vpnProxyTor",
      "hosting",
      "ipDuplicate",
      "deviceDuplicate",
      "previouslyBlockedIp",
      "spoofedHeader",
      "unknownLookup"
    ]);
    expect(Object.keys(DEFAULT_SECURITY_RULES)).toEqual(SECURITY_RULE_KEYS);
  });

  test("supports only concrete Discord moderation outcomes", () => {
    expect(RULE_ACTIONS).toEqual(["allow", "deny_role", "timeout", "kick", "ban"]);
    expect(normalizeRuleAction("TIMEOUT")).toBe("timeout");
    expect(normalizeRuleAction("invalid", "kick")).toBe("kick");
    expect(normalizeRuleAction("invalid", "invalid")).toBe("allow");
  });

  test("normalizes each rule without a shared master switch", () => {
    const rules = normalizeSecurityRules({
      ipDuplicate: { enabled: true, action: "kick", threshold: 4 },
      deviceDuplicate: { enabled: false, action: "ban", threshold: 2 },
      spoofedHeader: { enabled: true, action: "timeout", timeoutMinutes: 90 }
    });
    expect(rules.ipDuplicate).toMatchObject({ enabled: true, action: "kick", threshold: 4 });
    expect(rules.deviceDuplicate).toMatchObject({ enabled: false, action: "ban", threshold: 2 });
    expect(rules.spoofedHeader).toMatchObject({ enabled: true, action: "timeout", timeoutMinutes: 90 });
    expect(rules.hosting.enabled).toBe(false);
  });

  test("clamps thresholds and timeout duration to safe ranges", () => {
    expect(normalizeSecurityRule(
      { enabled: true, action: "timeout", timeoutMinutes: 999999, threshold: 0 },
      { action: "allow", timeoutMinutes: 60, threshold: 2 }
    )).toEqual({ enabled: true, action: "timeout", timeoutMinutes: 40320, threshold: 1 });
    expect(clampNumber("5", 1, 20, 3)).toBe(5);
    expect(clampNumber(NaN, 1, 20, 3)).toBe(3);
  });

  test("normalizes the full config and discards unsupported keys", () => {
    const result = normalizeVerificationConfig({
      verifyType: "oauth",
      blockHosting: true,
      unsupportedLegacyPolicy: { enabled: true },
      securityRules: {
        unknownLookup: { enabled: true, action: "deny_role" }
      }
    });
    expect(result.verifyType).toBe(VERIFY_MODES.OAUTH);
    expect(result.blockHosting).toBe(true);
    expect(result.securityRules.unknownLookup).toMatchObject({ enabled: true, action: "deny_role" });
  });
});
