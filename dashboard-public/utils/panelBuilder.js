/*
================================================================================
  Verification Panel Builder
  สร้าง Discord message payload สำหรับส่ง/แก้แผงยืนยันตัวตน
================================================================================
*/

const { normalizeVerifyMode } = require("./verifyMode");

const DEFAULT_PANEL = Object.freeze({
  content: "",
  title: "🔐 ยืนยันตัวตนเพื่อเข้าดิส",
  description: "กดปุ่มด้านล่างเพื่อยืนยันตัวตนผ่าน Discord OAuth2",
  color: "#5865F2",
  imageUrl: "",
  thumbnailUrl: "",
  footerText: "Discord Verification System",
  titleUrl: "",
  buttonText: "✅ ยืนยันตัวตน ✅",
  buttonLabel: "✅ ยืนยันตัวตน ✅",
  verifyType: "oauth",
  showTimestamp: false
});

function sanitizeText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function sanitizeUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

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
  const next = {
    ...DEFAULT_PANEL,
    ...panel
  };

  next.content = sanitizeText(next.content, 2000);
  next.title = sanitizeText(next.title, 256) || DEFAULT_PANEL.title;
  next.description = sanitizeText(next.description, 4000) || DEFAULT_PANEL.description;
  next.color = sanitizeText(next.color, 16) || DEFAULT_PANEL.color;

  next.imageUrl = sanitizeUrl(next.imageUrl || next.image || next.gifUrl);
  next.thumbnailUrl = sanitizeUrl(next.thumbnailUrl || next.thumbnail);
  next.titleUrl = sanitizeUrl(next.titleUrl || next.url);

  next.footerText = sanitizeText(next.footerText || next.footer, 2048);

  const buttonText = sanitizeText(
    next.buttonText || next.buttonLabel,
    80
  ) || DEFAULT_PANEL.buttonText;

  next.buttonText = buttonText;
  next.buttonLabel = buttonText;

  next.verifyType = normalizeVerifyMode(
    next.verifyType ||
    next.mode ||
    next.oauthMode
  );

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
    description: panel.description,
    color: parseEmbedColor(panel.color)
  };

  if (panel.titleUrl) {
    embed.url = panel.titleUrl;
  }

  if (panel.imageUrl) {
    embed.image = {
      url: panel.imageUrl
    };
  }

  if (panel.thumbnailUrl) {
    embed.thumbnail = {
      url: panel.thumbnailUrl
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

  return {
    content: cleanPanel.content || "",
    embeds: [buildEmbed(cleanPanel)],
    components,
    allowed_mentions: allowedMentions
  };
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
  sanitizeText,
  sanitizeUrl,
  parseEmbedColor,
  normalizePanelInput,
  buildOAuthUrl,
  buildEmbed,
  buildPanelPayload,
  buildValidationSummary
};
