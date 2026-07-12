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

const POLICY_ACTIONS = Object.freeze(["off", "log_only", "delay", "block"]);

const DEFAULT_ANTI_ALT = Object.freeze({
  enabled: false,
  ipDuplicateAction: "log_only",
  maxUsersPerIp: 3,
  deviceDuplicateAction: "log_only",
  maxUsersPerDevice: 2,
  previouslyBlockedIpAction: "delay",
  spoofedHeaderAction: "delay",
  unknownLookupAction: "delay",
  delayMs: 5000
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

function normalizeAction(value, fallback = "log_only") {
  const raw = String(value || "").trim().toLowerCase();
  const safeFallback = POLICY_ACTIONS.includes(fallback) ? fallback : "log_only";

  return POLICY_ACTIONS.includes(raw) ? raw : safeFallback;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeAntiAltConfig(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};

  return {
    enabled: raw.enabled === true,
    ipDuplicateAction: normalizeAction(raw.ipDuplicateAction, DEFAULT_ANTI_ALT.ipDuplicateAction),
    maxUsersPerIp: clampNumber(raw.maxUsersPerIp, 1, 20, DEFAULT_ANTI_ALT.maxUsersPerIp),
    deviceDuplicateAction: normalizeAction(raw.deviceDuplicateAction, DEFAULT_ANTI_ALT.deviceDuplicateAction),
    maxUsersPerDevice: clampNumber(raw.maxUsersPerDevice, 1, 20, DEFAULT_ANTI_ALT.maxUsersPerDevice),
    previouslyBlockedIpAction: normalizeAction(raw.previouslyBlockedIpAction, DEFAULT_ANTI_ALT.previouslyBlockedIpAction),
    spoofedHeaderAction: normalizeAction(raw.spoofedHeaderAction, DEFAULT_ANTI_ALT.spoofedHeaderAction),
    unknownLookupAction: normalizeAction(raw.unknownLookupAction, DEFAULT_ANTI_ALT.unknownLookupAction),
    delayMs: clampNumber(raw.delayMs, 0, 10000, DEFAULT_ANTI_ALT.delayMs)
  };
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

  if (Object.hasOwn(next, "antiAlt")) {
    next.antiAlt = normalizeAntiAltConfig(next.antiAlt || {});
  }

  return next;
}

module.exports = {
  VERIFY_MODES,
  POLICY_ACTIONS,
  DEFAULT_ANTI_ALT,
  normalizeVerifyMode,
  normalizeAction,
  clampNumber,
  normalizeAntiAltConfig,
  toLegacyCommandVerifyMode,
  toLegacyOauthMode,
  toDashboardVerifyMode,
  isOauthMode,
  isDirectMode,
  getVerifyModeLabel,
  normalizePanel,
  normalizeVerificationConfig
};
