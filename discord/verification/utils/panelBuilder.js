"use strict";

/*
================================================================================
  Verification Panel Builder
  สร้าง Discord message payload สำหรับส่ง/แก้แผงยืนยันตัวตน
================================================================================
*/

const fs = require("node:fs");
const path = require("node:path");
const config = require("../../config.json");
const { normalizeVerifyMode } = require("./verifyMode");

const VERIFY_PANEL_BANNER_ATTACHMENT_NAME = "verification-panel-banner.webp";

function getVerifyPanelBannerPath() {
  try {
    return path.resolve(__dirname, "../../assets/verification-panel-banner.webp");
  } catch {
    return null;
  }
}

const DEFAULT_PANEL = Object.freeze({
  content: "",
  title: "<a:sn_pmt:1559878089750749244> 𝗩𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻 เพื่อรับยศ",
  description: "",
  color: "#5865F2",
  imageUrl: `attachment://${VERIFY_PANEL_BANNER_ATTACHMENT_NAME}`,
  thumbnailUrl: "",
  footerText: "",
  titleUrl: "",
  buttonText: "<a:ddd_pmt:1553844572873040044> vfy (user)",
  buttonLabel: "<a:ddd_pmt:1553844572873040044> vfy (user)",
  verifyType: "oauth",
  showTimestamp: false
});

function sanitizeText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function sanitizeUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (raw.startsWith("attachment://")) {
    return raw;
  }

  try {
    const u = new URL(raw);

    if (!["http:", "https:"].includes(u.protocol)) {
      return "";
    }

    return u.toString();
  } catch {
    return "";
  }
}

function parseEmbedColor(value) {
  const raw = String(value || "").trim();

  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return Number.parseInt(raw.slice(1), 16);
  }

  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return Number.parseInt(raw, 16);
  }

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffff) {
      return n;
    }
  }

  return 0x5865f2;
}

function normalizePanelInput(panel = {}) {
  const rawVerifyType = panel.verifyType ?? panel.mode ?? panel.oauthMode;
  const next = {
    ...DEFAULT_PANEL,
    ...panel
  };

  next.content = sanitizeText(next.content, 2000);
  next.title = sanitizeText(next.title, 256) || DEFAULT_PANEL.title;
  next.description = sanitizeText(next.description, 4000);
  const explicitImage = panel.imageUrl ?? panel.image ?? panel.gifUrl;
  next.imageUrl = explicitImage !== undefined
    ? sanitizeUrl(explicitImage)
    : sanitizeUrl(DEFAULT_PANEL.imageUrl);
  next.thumbnailUrl = sanitizeUrl(next.thumbnailUrl || next.thumbnail);
  next.titleUrl = sanitizeUrl(next.titleUrl || next.url);

  next.footerText = sanitizeText(next.footerText || next.footer, 2048);

  const buttonText = sanitizeText(
    next.buttonText || next.buttonLabel,
    80
  ) || DEFAULT_PANEL.buttonText;

  next.buttonText = buttonText;
  next.buttonLabel = buttonText;

  next.verifyType = normalizeVerifyMode(rawVerifyType);

  next.showTimestamp = !!next.showTimestamp;

  return next;
}

function buildOAuthUrl({ baseUrl, state }) {
  let cleanBase = String(baseUrl || "");
  while (cleanBase.endsWith("/")) {
    cleanBase = cleanBase.slice(0, -1);
  }
  const cleanState = String(state || "").trim();

  if (!cleanBase || !cleanState) {
    return "";
  }

  return `${cleanBase}/auth/discord?state=${encodeURIComponent(cleanState)}`;
}

function buildButtonUrl({ panel, oauthUrl, directCustomId }) {
  const mode = normalizeVerifyMode(panel.verifyType);

  if (mode === "direct") {
    return {
      type: 2,
      style: 3,
      label: panel.buttonText,
      custom_id: directCustomId || "verify_role_missing"
    };
  }

  const cleanOauthUrl = sanitizeUrl(oauthUrl);

  if (!cleanOauthUrl) {
    return {
      type: 2,
      style: 2,
      label: "OAuth URL ยังไม่พร้อม",
      custom_id: "verify_oauth_url_missing",
      disabled: true
    };
  }

  return {
    type: 2,
    style: 5,
    label: panel.buttonText,
    url: cleanOauthUrl
  };
}

function buildEmbed(panel) {
  const embed = {
    title: panel.title,
    color: parseEmbedColor(panel.color)
  };

  if (panel.description) {
    embed.description = panel.description;
  }

  const cleanTitleUrl = sanitizeUrl(panel.titleUrl);
  if (cleanTitleUrl) {
    embed.url = cleanTitleUrl;
  }

  const cleanImageUrl = sanitizeUrl(panel.imageUrl);
  if (cleanImageUrl) {
    embed.image = {
      url: cleanImageUrl
    };
  }

  const cleanThumbnailUrl = sanitizeUrl(panel.thumbnailUrl);
  if (cleanThumbnailUrl) {
    embed.thumbnail = {
      url: cleanThumbnailUrl
    };
  }

  if (panel.footerText) {
    embed.footer = {
      text: panel.footerText
    };
  }

  if (panel.showTimestamp) {
    embed.timestamp = new Date().toISOString();
  }

  return embed;
}

function buildPanelPayload({
  panel,
  oauthUrl,
  directCustomId,
  allowedMentions = { parse: [] }
} = {}) {
  const cleanPanel = normalizePanelInput(panel);

  const components = [
    {
      type: 1,
      components: [
        buildButtonUrl({
          panel: cleanPanel,
          oauthUrl,
          directCustomId
        })
      ]
    }
  ];

  const payload = {
    content: cleanPanel.content || "",
    embeds: [buildEmbed(cleanPanel)],
    components,
    allowed_mentions: allowedMentions
  };

  if (cleanPanel.imageUrl === `attachment://${VERIFY_PANEL_BANNER_ATTACHMENT_NAME}`) {
    const bannerPath = getVerifyPanelBannerPath();
    if (bannerPath && fs.existsSync(bannerPath)) {
      payload.files = [{ path: bannerPath, name: VERIFY_PANEL_BANNER_ATTACHMENT_NAME }];
    }
  }

  return payload;
}

function buildValidationSummary({ ok, checks = [], warnings = [], errors = [] }) {
  return {
    ok: !!ok && errors.length === 0 && checks.every((c) => c.ok !== false),
    checks,
    warnings,
    errors
  };
}

module.exports = {
  DEFAULT_PANEL,
  VERIFY_PANEL_BANNER_ATTACHMENT_NAME,
  getVerifyPanelBannerPath,
  sanitizeText,
  sanitizeUrl,
  parseEmbedColor,
  normalizePanelInput,
  buildOAuthUrl,
  buildEmbed,
  buildPanelPayload,
  buildValidationSummary
};
