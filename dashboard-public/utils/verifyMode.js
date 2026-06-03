/*
================================================================================
  Verify Mode Utils
  ใช้ normalize ค่า verifyType จากหลาย format ให้ระบบอ่านตรงกัน
================================================================================
*/

const VERIFY_MODES = Object.freeze({
  OAUTH: "oauth",
  DIRECT: "direct"
});

const LEGACY_VERIFY_MODE_MAP = Object.freeze({
  oauth: VERIFY_MODES.OAUTH,
  oauth2: VERIFY_MODES.OAUTH,
  "discord-oauth": VERIFY_MODES.OAUTH,
  "discord_oauth": VERIFY_MODES.OAUTH,
  "direct-discord-authorize-long-lived-state": VERIFY_MODES.OAUTH,

  direct: VERIFY_MODES.DIRECT,
  "direct-role": VERIFY_MODES.DIRECT,
  direct_role: VERIFY_MODES.DIRECT,
  instant: VERIFY_MODES.DIRECT,
  "instant-role": VERIFY_MODES.DIRECT,
  button: VERIFY_MODES.DIRECT
});

function normalizeVerifyMode(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) return VERIFY_MODES.OAUTH;

  return LEGACY_VERIFY_MODE_MAP[raw] || VERIFY_MODES.OAUTH;
}

function toLegacyCommandVerifyMode(value) {
  const mode = normalizeVerifyMode(value);
  return mode === VERIFY_MODES.DIRECT ? "direct-role" : "oauth2";
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
    next.verifyType ||
    next.oauthMode ||
    next.mode ||
    "oauth"
  );

  if (!next.buttonText && next.buttonLabel) {
    next.buttonText = next.buttonLabel;
  }

  if (!next.buttonLabel && next.buttonText) {
    next.buttonLabel = next.buttonText;
  }

  if (!next.buttonText) {
    next.buttonText = "✅ ยืนยันตัวตน ✅";
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
    next.verifyType ||
    next.oauthMode ||
    next.panel.verifyType
  );

  next.oauthMode = next.verifyType;

  return next;
}

module.exports = {
  VERIFY_MODES,
  normalizeVerifyMode,
  toLegacyCommandVerifyMode,
  toDashboardVerifyMode,
  isOauthMode,
  isDirectMode,
  getVerifyModeLabel,
  normalizePanel,
  normalizeVerificationConfig
};
