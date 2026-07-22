/*
================================================================================
  Verify Mode Utils
  ใช้ normalize ค่า verifyType จากหลาย format ให้ระบบอ่านตรงกัน

  Dashboard v2 mode:
  - oauth  = OAuth2 Verification
  - direct = กดรับยศทันที

  Legacy mode:
  - oauth2
  - direct-role
  - direct-discord-authorize-long-lived-state
================================================================================
*/

const VERIFY_MODES = Object.freeze({
  OAUTH: "oauth",
  DIRECT: "direct"
});

const RULE_ACTIONS = Object.freeze(["allow", "deny_role", "timeout", "kick", "ban"]);
const SECURITY_RULE_KEYS = Object.freeze([
  "vpnProxyTor",
  "hosting",
  "ipDuplicate",
  "deviceDuplicate",
  "previouslyBlockedIp",
  "spoofedHeader",
  "unknownLookup"
]);

const DEFAULT_SECURITY_RULES = Object.freeze({
  vpnProxyTor: Object.freeze({ enabled: true, action: "deny_role", timeoutMinutes: 60 }),
  hosting: Object.freeze({ enabled: false, action: "deny_role", timeoutMinutes: 60 }),
  ipDuplicate: Object.freeze({ enabled: false, action: "allow", timeoutMinutes: 60, threshold: 3 }),
  deviceDuplicate: Object.freeze({ enabled: false, action: "allow", timeoutMinutes: 60, threshold: 2 }),
  previouslyBlockedIp: Object.freeze({ enabled: false, action: "deny_role", timeoutMinutes: 60 }),
  spoofedHeader: Object.freeze({ enabled: false, action: "deny_role", timeoutMinutes: 60 }),
  unknownLookup: Object.freeze({ enabled: false, action: "deny_role", timeoutMinutes: 60 })
});

const LEGACY_VERIFY_MODE_MAP = Object.freeze({
  oauth: VERIFY_MODES.OAUTH,
  oauth2: VERIFY_MODES.OAUTH,
  "oauth-2": VERIFY_MODES.OAUTH,
  "discord-oauth": VERIFY_MODES.OAUTH,
  "discord_oauth": VERIFY_MODES.OAUTH,
  "direct-discord-authorize-long-lived-state": VERIFY_MODES.OAUTH,
  "direct_discord_authorize_long_lived_state": VERIFY_MODES.OAUTH,
  "link": VERIFY_MODES.OAUTH,
  "url": VERIFY_MODES.OAUTH,

  direct: VERIFY_MODES.DIRECT,
  "direct-role": VERIFY_MODES.DIRECT,
  direct_role: VERIFY_MODES.DIRECT,
  instant: VERIFY_MODES.DIRECT,
  "instant-role": VERIFY_MODES.DIRECT,
  instant_role: VERIFY_MODES.DIRECT,
  button: VERIFY_MODES.DIRECT,
  "button-role": VERIFY_MODES.DIRECT,
  button_role: VERIFY_MODES.DIRECT
});

function normalizeVerifyMode(value) {
  if (value === true) return VERIFY_MODES.OAUTH;
  if (value === false) return VERIFY_MODES.DIRECT;

  const raw = String(value || "").trim().toLowerCase();

  if (!raw) return VERIFY_MODES.OAUTH;

  return LEGACY_VERIFY_MODE_MAP[raw] || VERIFY_MODES.OAUTH;
}

function normalizeRuleAction(value, fallback = "allow") {
  const raw = String(value || "").trim().toLowerCase();
  const safeFallback = RULE_ACTIONS.includes(fallback) ? fallback : "allow";
  return RULE_ACTIONS.includes(raw) ? raw : safeFallback;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeSecurityRule(value = {}, defaults = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : {};
  return {
    enabled: raw.enabled === true,
    action: normalizeRuleAction(raw.action, fallback.action || "allow"),
    timeoutMinutes: clampNumber(raw.timeoutMinutes, 1, 40320, fallback.timeoutMinutes || 60),
    ...(Object.hasOwn(fallback, "threshold") || Object.hasOwn(raw, "threshold") ? {
      threshold: clampNumber(raw.threshold, 1, 20, fallback.threshold || 2)
    } : {})
  };
}

function normalizeSecurityRules(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(SECURITY_RULE_KEYS.map(key => {
    const defaults = DEFAULT_SECURITY_RULES[key];
    const source = Object.hasOwn(raw, key) ? raw[key] : defaults;
    return [key, normalizeSecurityRule(source, defaults)];
  }));
}

function toLegacyCommandVerifyMode(value) {
  const mode = normalizeVerifyMode(value);
  return mode === VERIFY_MODES.DIRECT ? "direct-role" : "oauth2";
}

function toLegacyOauthMode(value) {
  const mode = normalizeVerifyMode(value);
  return mode === VERIFY_MODES.DIRECT
    ? "direct-role"
    : "direct-discord-authorize-long-lived-state";
}

function toDashboardVerifyMode(value) {
  return normalizeVerifyMode(value);
}

function isOauthMode(value) {
  return normalizeVerifyMode(value) === VERIFY_MODES.OAUTH;
}

function isDirectMode(value) {
  return normalizeVerifyMode(value) === VERIFY_MODES.DIRECT;
}

function getVerifyModeLabel(value) {
  return isDirectMode(value) ? "กดรับยศทันที" : "OAuth2 Verification";
}

function normalizePanel(panel = {}) {
  const next = { ...panel };

  next.verifyType = normalizeVerifyMode(
    next.verifyType ??
    next.oauthMode ??
    next.mode ??
    "oauth"
  );

  if (!next.buttonText && next.buttonLabel) {
    next.buttonText = next.buttonLabel;
  }

  if (!next.buttonLabel && next.buttonText) {
    next.buttonLabel = next.buttonText;
  }

  if (!next.buttonText) {
    next.buttonText = next.verifyType === VERIFY_MODES.DIRECT
      ? "🎭 รับยศ"
      : "✅ ยืนยันตัวตน ✅";
  }

  if (!next.buttonLabel) {
    next.buttonLabel = next.buttonText;
  }

  return next;
}

function normalizeVerificationConfig(config = {}) {
  const next = { ...config };

  next.panel = normalizePanel(next.panel || {});

  next.verifyType = normalizeVerifyMode(
    next.verifyType ??
    next.oauthMode ??
    next.panel.verifyType
  );

  next.oauthMode = next.verifyType;
  next.panel.verifyType = next.verifyType;

  if (!next.legacyOauthMode) {
    next.legacyOauthMode = toLegacyOauthMode(next.verifyType);
  }

  next.blockHosting = next.blockHosting === true;

  delete next[["anti", "Alt"].join("")];
  const ruleInput = next.securityRules && typeof next.securityRules === "object"
    ? { ...next.securityRules }
    : {};
  if (!Object.hasOwn(ruleInput, "vpnProxyTor") && next.blockVPN === true) {
    ruleInput.vpnProxyTor = { ...DEFAULT_SECURITY_RULES.vpnProxyTor, enabled: true };
  }
  if (!Object.hasOwn(ruleInput, "hosting") && next.blockHosting === true) {
    ruleInput.hosting = { ...DEFAULT_SECURITY_RULES.hosting, enabled: true };
  }
  next.securityRules = normalizeSecurityRules(ruleInput);

  return next;
}

module.exports = {
  VERIFY_MODES,
  RULE_ACTIONS,
  SECURITY_RULE_KEYS,
  DEFAULT_SECURITY_RULES,
  normalizeVerifyMode,
  normalizeRuleAction,
  clampNumber,
  normalizeSecurityRule,
  normalizeSecurityRules,
  toLegacyCommandVerifyMode,
  toLegacyOauthMode,
  toDashboardVerifyMode,
  isOauthMode,
  isDirectMode,
  getVerifyModeLabel,
  normalizePanel,
  normalizeVerificationConfig
};
