/* eslint-disable complexity -- Legacy dashboard routes keep stable response shapes; refactor separately. */
/*
================================================================================
  Guild Admin Dashboard Routes — Dashboard Public v2

  Scope:
  - Guild admin session guard
  - Guild settings
  - Verification panel resources / validation / send / update / disable
  - Members / logs APIs with detailed verification data
  - Sensitive verification data visibility gated by owner approval
  - Existing reveal/delete behavior preserved without bypassing owner approval
  - Panel Revision / Rotate State for long-lived OAuth panel state
================================================================================
*/

const router = require("express").Router();
const crypto = require("crypto");

const GuildConfig = require("../models/GuildConfig");
const VerifyLog = require("../models/VerifyLog");
const OAuthUser = require("../models/OAuthUser");
const IPRevealRequest = require("../models/IPRevealRequest");
const IpIdentityLink = require("../models/IpIdentityLink");

const {
  createCompactCallbackState,
  getStateSecret
} = require("../utils/state");
const {
  normalizeGuildPermissions,
  canAccessGuildDashboard
} = require("../utils/guildPermissions");
const {
  normalizeVerifyMode,
  normalizeAction,
  clampNumber,
  normalizePanel,
  normalizeAntiAltConfig,
  normalizeVerificationConfig
} = require("../utils/verifyMode");

const {
  normalizePanelInput,
  buildPanelPayload,
  buildValidationSummary
} = require("../utils/panelBuilder");

const discordAPI = require("../utils/discordAPI");
const {
  normalizeSensitiveAccess,
  canViewSensitiveData,
  buildSensitiveAccessAuditUpdate
} = require("../utils/sensitiveAccess");
const {
  buildVerifyLogCommon,
  buildVerifyLogParts
} = require("../utils/verificationSnapshots");

const SNOWFLAKE_RE = /^\d{17,22}$/;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

function now() {
  return Date.now();
}

function safeConsoleError(scope, err) {
  console.error(`[GUILD-DASHBOARD:${scope}]`, err?.message || err);
}

function sendServerError(res, scope, err, fallback = "เกิดข้อผิดพลาดภายในระบบ") {
  safeConsoleError(scope, err);

  return res.status(500).json({
    success: false,
    error: fallback
  });
}

function getAdminUser(req) {
  return req.session?.adminUser || null;
}

function getAdminId(req) {
  const user = getAdminUser(req);
  return user?.id || user?.userId || user?.discordId || null;
}

async function recordSensitiveAccess(guildId, req, route) {
  try {
    await GuildConfig.updateOne(
      { guildId },
      buildSensitiveAccessAuditUpdate({
        actor: getAdminId(req) || "guild-admin",
        route
      })
    );
  } catch (err) {
    safeConsoleError("sensitive-access-audit", err);
  }
}

function getSessionGuilds(req) {
  if (Array.isArray(req.session?.adminGuilds)) return req.session.adminGuilds;
  if (Array.isArray(req.session?.adminUser?.adminGuilds)) return req.session.adminUser.adminGuilds;
  return [];
}

function normalizeGuild(guild = {}) {
  const policy = normalizeGuildPermissions(guild);
  return {
    id: String(guild.id || ""),
    name: String(guild.name || "Unknown Server"),
    icon: guild.icon || null,
    owner: policy.owner,
    permissions: String(guild.permissions || "0"),
    isAdmin: policy.isAdmin,
    isOwner: policy.isOwner,
    canManage: policy.canManage,
    canManageGuild: policy.canManageGuild,
    canManageRoles: policy.canManageRoles
  };
}

function getGuildFromSession(req, guildId) {
  return getSessionGuilds(req)
    .map(normalizeGuild)
    .find(guild => guild.id === String(guildId) && canAccessGuildDashboard(guild));
}

function requireAdmin(req, res, next) {
  if (!getAdminUser(req)) {
    return res.status(401).json({
      success: false,
      error: "กรุณา Login ก่อน",
      code: "admin_login_required"
    });
  }

  next();
}

function requireGuildAdmin(req, res, next) {
  const guildId = req.params.guildId || req.body?.guildId;
  const guild = getGuildFromSession(req, guildId);

  if (!guild) {
    return res.status(403).json({
      success: false,
      error: "ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้",
      code: "guild_admin_required"
    });
  }

  req.adminGuild = guild;
  next();
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map(v => String(v).trim().toUpperCase())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map(v => v.trim().toUpperCase())
      .filter(Boolean);
  }

  return [];
}

function cleanSnowflake(value) {
  const v = value ? String(value).trim() : "";
  if (!v) return null;
  return SNOWFLAKE_RE.test(v) ? v : null;
}

function cleanOptionalSnowflake(value) {
  const v = value ? String(value).trim() : "";
  if (!v) return null;
  return SNOWFLAKE_RE.test(v) ? v : null;
}

function cleanObjectId(value) {
  const v = value ? String(value).trim() : "";
  if (!v) return null;
  return OBJECT_ID_RE.test(v) ? v : null;
}

function cleanText(value, max = 1000) {
  if (value === null || value === undefined) return undefined;
  return String(value).trim().slice(0, max);
}

function cleanHexColor(value) {
  const v = value ? String(value).trim() : "";
  if (!v) return undefined;

  const normalized = v.startsWith("#") ? v : `#${v}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized)
    ? normalized.toUpperCase()
    : undefined;
}

function cleanUrl(value) {
  const v = value ? String(value).trim() : "";
  if (!v) return undefined;

  try {
    const url = new URL(v);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parsePage(value) {
  return Math.max(0, Number.parseInt(value, 10) || 0);
}

function parseLimit(value, fallback = 25, max = 100) {
  return Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
}

function getBaseFilter(guildId) {
  return {
    guildId,
    deletedAt: { $exists: false }
  };
}

function pagination(page, limit, total) {
  const hasMore = (page + 1) * limit < total;

  return {
    page,
    limit,
    total,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    prevPage: page > 0 ? page - 1 : null
  };
}

function getPublicBaseUrl(req) {
  const envUrl =
    process.env.PUBLIC_BASE_URL ||
    process.env.DASHBOARD_PUBLIC_URL ||
    process.env.PUBLIC_DASHBOARD_URL ||
    process.env.DASHBOARD_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "";

  if (envUrl) return trimTrailingSlashes(envUrl);

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return trimTrailingSlashes(`${proto}://${host}`);
}

function trimTrailingSlashes(value) {
  let text = String(value || "");
  while (text.endsWith("/")) text = text.slice(0, -1);
  return text;
}

function makeRequestId(prefix = "req") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeVerification(input = {}) {
  const out = {};

  if ("enabled" in input) out.enabled = !!input.enabled;
  if ("blockVPN" in input) out.blockVPN = !!input.blockVPN;
  if ("blockHosting" in input) out.blockHosting = !!input.blockHosting;
  if ("requireEmail" in input) out.requireEmail = !!input.requireEmail;
  if ("requireEmailVerified" in input) out.requireEmailVerified = !!input.requireEmailVerified;
  if ("requireConnections" in input) out.requireConnections = !!input.requireConnections;

  if ("minAccountAgeDays" in input) {
    out.minAccountAgeDays = Math.max(0, Math.min(3650, Number.parseInt(input.minAccountAgeDays, 10) || 0));
  }

  if ("minConnections" in input) {
    out.minConnections = Math.max(1, Math.min(20, Number.parseInt(input.minConnections, 10) || 1));
  }

  if ("roleId" in input) out.roleId = cleanOptionalSnowflake(input.roleId);
  if ("channelId" in input) out.channelId = cleanOptionalSnowflake(input.channelId);
  if ("messageId" in input) out.messageId = cleanOptionalSnowflake(input.messageId);

  if ("allowedCountries" in input) out.allowedCountries = normalizeStringArray(input.allowedCountries);
  if ("blockedCountries" in input) out.blockedCountries = normalizeStringArray(input.blockedCountries);

  if ("antiAlt" in input && input.antiAlt && typeof input.antiAlt === "object" && !Array.isArray(input.antiAlt)) {
    const rawAntiAlt = input.antiAlt;
    const antiAlt = {};
    if ("enabled" in rawAntiAlt) antiAlt.enabled = rawAntiAlt.enabled === true || rawAntiAlt.enabled === "true" || rawAntiAlt.enabled === "on";
    if ("ipDuplicateAction" in rawAntiAlt) antiAlt.ipDuplicateAction = normalizeAction(rawAntiAlt.ipDuplicateAction, "log_only");
    if ("maxUsersPerIp" in rawAntiAlt) antiAlt.maxUsersPerIp = clampNumber(rawAntiAlt.maxUsersPerIp, 1, 20, 3);
    if ("deviceDuplicateAction" in rawAntiAlt) antiAlt.deviceDuplicateAction = normalizeAction(rawAntiAlt.deviceDuplicateAction, "log_only");
    if ("maxUsersPerDevice" in rawAntiAlt) antiAlt.maxUsersPerDevice = clampNumber(rawAntiAlt.maxUsersPerDevice, 1, 20, 2);
    if ("previouslyBlockedIpAction" in rawAntiAlt) antiAlt.previouslyBlockedIpAction = normalizeAction(rawAntiAlt.previouslyBlockedIpAction, "delay");
    if ("spoofedHeaderAction" in rawAntiAlt) antiAlt.spoofedHeaderAction = normalizeAction(rawAntiAlt.spoofedHeaderAction, "delay");
    if ("unknownLookupAction" in rawAntiAlt) antiAlt.unknownLookupAction = normalizeAction(rawAntiAlt.unknownLookupAction, "delay");
    if ("delayMs" in rawAntiAlt) antiAlt.delayMs = clampNumber(rawAntiAlt.delayMs, 0, 10000, 5000);
    out.antiAlt = antiAlt;
  }

  if ("panel" in input && input.panel && typeof input.panel === "object") {
    const rawPanel = input.panel;
    const panel = {};

    if ("content" in rawPanel) panel.content = cleanText(rawPanel.content, 2000) || "";
    if ("title" in rawPanel) panel.title = cleanText(rawPanel.title, 256) || undefined;
    if ("description" in rawPanel) panel.description = cleanText(rawPanel.description, 4000) || undefined;
    if ("footerText" in rawPanel) panel.footerText = cleanText(rawPanel.footerText, 2048) || undefined;

    if ("buttonText" in rawPanel) {
      const buttonText = cleanText(rawPanel.buttonText, 80) || undefined;
      panel.buttonLabel = buttonText;
      panel.buttonText = buttonText;
    }

    if ("buttonLabel" in rawPanel) {
      const buttonText = cleanText(rawPanel.buttonLabel, 80) || undefined;
      panel.buttonLabel = buttonText;
      panel.buttonText = buttonText;
    }

    if ("buttonEmoji" in rawPanel) panel.buttonEmoji = cleanText(rawPanel.buttonEmoji, 80) || undefined;

    if ("verifyType" in rawPanel) {
      panel.verifyType = normalizeVerifyMode(rawPanel.verifyType);
    }

    if ("showTimestamp" in rawPanel) panel.showTimestamp = !!rawPanel.showTimestamp;

    const color = cleanHexColor(rawPanel.color);
    if (color !== undefined) panel.color = color;

    const imageUrl = cleanUrl(rawPanel.imageUrl);
    if (imageUrl !== undefined) panel.imageUrl = imageUrl;

    const thumbnailUrl = cleanUrl(rawPanel.thumbnailUrl);
    if (thumbnailUrl !== undefined) panel.thumbnailUrl = thumbnailUrl;

    const titleUrl = cleanUrl(rawPanel.titleUrl);
    if (titleUrl !== undefined) panel.titleUrl = titleUrl;

    out.panel = panel;
  }

  out.updatedAt = now();

  return out;
}

function mergeVerificationConfig(existing = {}, incoming = {}) {
  const current = normalizeVerificationConfig(existing || {});
  const clean = sanitizeVerification(incoming || {});
  const hasIncomingAntiAlt = Object.hasOwn(incoming || {}, "antiAlt");
  const hasIncomingPanel = Object.hasOwn(incoming || {}, "panel");
  const currentAntiAlt = current.antiAlt ?? {};
  const cleanAntiAlt = clean.antiAlt ?? {};
  const currentPanel = current.panel ?? {};
  const cleanPanel = clean.panel ?? {};
  const merged = {
    ...current,
    ...clean,
    /*
      สำคัญ:
      อย่าให้ save settings ปกติไปล้าง panelRevision เดิม
      panelRevision จะเปลี่ยนเฉพาะตอน send/update/disable เท่านั้น
    */
    panelRevision: current.panelRevision || clean.panelRevision || null,
    panelRevisionUpdatedAt: current.panelRevisionUpdatedAt || clean.panelRevisionUpdatedAt || null,
    antiAlt: hasIncomingAntiAlt
      ? normalizeAntiAltConfig({
          ...currentAntiAlt,
          ...cleanAntiAlt
        })
      : current.antiAlt,
    panel: normalizePanel(hasIncomingPanel
      ? {
          ...currentPanel,
          ...cleanPanel
        }
      : currentPanel),
    updatedAt: now()
  };
  merged.oauthMode = normalizeVerifyMode(merged.verifyType || merged.panel?.verifyType);
  merged.verifyType = merged.oauthMode;
  merged.panel.verifyType = merged.oauthMode;
  return normalizeVerificationConfig(merged);
}

function serializeConfig(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc || {};
  const verification = normalizeVerificationConfig(raw.verification || {});
  const security = raw.security || {};

  return {
    guildId: raw.guildId || "",
    guildName: raw.guildName || "",
    verification,
    security: {
      ...security,
      sensitiveDataAccess: normalizeSensitiveAccess(security)
    },
    setupBy: raw.setupBy || null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null
  };
}

function serializeGuildFromSession(guild = {}) {
  return {
    id: guild.id || "",
    name: guild.name || "Unknown Server",
    icon: guild.icon || null,
    owner: !!guild.owner,
    isOwner: !!guild.isOwner,
    isAdmin: !!guild.isAdmin,
    canManage: !!guild.canManage,
    canManageGuild: !!guild.canManageGuild,
    canManageRoles: !!guild.canManageRoles,
    permissions: guild.permissions || "0"
  };
}

function serializeVerifyLog(log = {}, options = {}) {
  const canViewSensitive = options.canViewSensitive === true;
  const parts = buildVerifyLogParts(log, canViewSensitive);
  const { raw } = parts;
  const common = buildVerifyLogCommon(parts, {
    canViewSensitive,
    defaultResult: "failed"
  });

  return {
    ...common,
    joinResult: raw.joinResult || null,
    roleAssignResult: raw.roleAssignResult || null,
    roleAssignmentResult: raw.roleAssignResult?.ok === true
      ? "success"
      : raw.roleAssignResult?.error
        ? "failed"
        : raw.roleAssignResult || null,
    roleResult: raw.roleAssignResult?.ok === true ? "success" : raw.roleAssignResult?.status || "",

    policyResult: common.result,
    requestId: raw.requestId || raw.debugRequestId || "",

    verifiedAt: raw.verifiedAt || null,
    createdAt: raw.createdAt || raw.verifiedAt || null
  };
}

function buildLogQuery(guildId, reqQuery = {}) {
  const filter = getBaseFilter(guildId);

  const result = String(reqQuery.result || "").trim().toLowerCase();
  if (["success", "failed", "blocked", "pending"].includes(result)) {
    filter.result = result;
  }

  const risk = String(reqQuery.risk || "").trim().toLowerCase();
  if (risk === "high") filter.riskScore = { $gte: 70 };
  if (risk === "medium") filter.riskScore = { $gte: 35, $lt: 70 };
  if (risk === "low") filter.riskScore = { $lt: 35 };

  const q = String(reqQuery.q || "").trim();
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const textMatch = { $regex: escaped, $options: "i" };

    filter.$or = [
      { userId: q },
      { roleId: q },
      { reason: textMatch },
      { requestId: q },
      { "discordSnapshot.username": textMatch },
      { "discordSnapshot.globalName": textMatch },
      { "discordSnapshot.email": textMatch },
      { "ipInfo.countryCode": textMatch },
      { "ipInfo.city": textMatch },
      { "ipInfo.isp": textMatch }
    ];
  }

  return filter;
}

function summarizeCounts(logs = []) {
  const summary = {
    total: logs.length,
    success: 0,
    failed: 0,
    blocked: 0,
    highRisk: 0,
    vpn: 0,
    proxy: 0,
    tor: 0,
    hosting: 0,
    pendingReveal: 0,
    successRate: 0
  };

  for (const log of logs) {
    const safe = serializeVerifyLog(log);

    if (safe.result === "success") summary.success++;
    if (safe.result === "failed") summary.failed++;
    if (safe.result === "blocked") summary.blocked++;
    if (Number(safe.riskScore || 0) >= 70) summary.highRisk++;

    if (safe.ipInfo?.isVPN) summary.vpn++;
    if (safe.ipInfo?.isProxy) summary.proxy++;
    if (safe.ipInfo?.isTOR) summary.tor++;
    if (safe.ipInfo?.isHosting) summary.hosting++;
  }

  summary.successRate = summary.total > 0
    ? Math.round((summary.success / summary.total) * 100)
    : 0;

  return summary;
}

function makePanelRevision(prefix = "panel") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

function buildDiscordAuthorizeUrl(req, { guildId, roleId, panelRevision = null }) {
  const dashboardUrl = getPublicBaseUrl(req);
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!dashboardUrl) throw new Error("Missing PUBLIC_BASE_URL/DASHBOARD_PUBLIC_URL");
  if (!clientId) throw new Error("Missing DISCORD_CLIENT_ID");

  const redirectUri = `${dashboardUrl}/auth/callback`;

  const state = createCompactCallbackState({
    guildId,
    roleId,
    expectedUserId: null,
    panelRevision
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify email connections guilds guilds.members.read guilds.join",
    state,
    prompt: "consent"
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function makePanelPayload(req, { guildId, verification }) {
  const panel = normalizePanelInput(verification.panel || {});
  const mode = normalizeVerifyMode(panel.verifyType || verification.verifyType || verification.oauthMode);

  let oauthUrl = "";

  if (mode === "oauth") {
    oauthUrl = buildDiscordAuthorizeUrl(req, {
      guildId,
      roleId: verification.roleId,
      panelRevision: verification.panelRevision
    });
  }

  return buildPanelPayload({
    panel: {
      ...panel,
      verifyType: mode
    },
    oauthUrl,
    directCustomId: `verify_role_${verification.roleId}`,
    allowedMentions: { parse: [] }
  });
}

async function ensureGuildConfig(guildId, guildName = "") {
  let config = await GuildConfig.findOne({ guildId });

  if (!config) {
    config = await GuildConfig.create({
      guildId,
      guildName,
      verification: normalizeVerificationConfig({}),
      createdAt: now(),
      updatedAt: now()
    });
  }

  return config;
}

async function loadValidationContext(guildId, verification) {
  const [guild, roles, channels, botUser] = await Promise.all([
    discordAPI.getGuild(guildId),
    discordAPI.getGuildRoles(guildId),
    discordAPI.getGuildChannels(guildId),
    discordAPI.getCurrentBotUser()
  ]);

  const botMember = botUser?.id
    ? await discordAPI.getBotMember(guildId, botUser.id)
    : null;

  const role = roles.find(r => String(r.id) === String(verification.roleId));
  const channel = channels.find(c => String(c.id) === String(verification.channelId));

  return {
    guild,
    roles,
    channels,
    botUser,
    botMember,
    role,
    channel
  };
}

async function validateVerificationConfig(req, guildId, verification) {
  const checks = [];
  const warnings = [];
  const errors = [];

  const roleId = cleanSnowflake(verification.roleId);
  const channelId = cleanSnowflake(verification.channelId);
  const mode = normalizeVerifyMode(verification.panel?.verifyType || verification.verifyType || verification.oauthMode);

  checks.push({
    name: "guild_admin_access",
    label: "ผู้ใช้มีสิทธิ์จัดการ guild นี้",
    ok: true,
    detail: "ผ่านจาก session guard"
  });

  if (!discordAPI.hasBotToken()) {
    errors.push("ไม่มี Bot Token ใน env");
    checks.push({
      name: "bot_token",
      label: "Bot Token พร้อมใช้งาน",
      ok: false,
      detail: "ไม่พบ BOT_TOKEN / DISCORD_BOT_TOKEN / TOKEN_MANAGER"
    });

    return buildValidationSummary({ ok: false, checks, warnings, errors });
  }

  checks.push({
    name: "bot_token",
    label: "Bot Token พร้อมใช้งาน",
    ok: true,
    detail: "พบ token จาก env"
  });

  if (!roleId) errors.push("ยังไม่ได้ตั้ง Role ID หรือ Role ID ไม่ถูกต้อง");
  if (!channelId) errors.push("ยังไม่ได้ตั้ง Channel ID หรือ Channel ID ไม่ถูกต้อง");

  checks.push({
    name: "role_id_format",
    label: "Role ID format ถูกต้อง",
    ok: !!roleId,
    detail: roleId || "Role ID ต้องเป็นตัวเลข 17–22 หลัก"
  });

  checks.push({
    name: "channel_id_format",
    label: "Channel ID format ถูกต้อง",
    ok: !!channelId,
    detail: channelId || "Channel ID ต้องเป็นตัวเลข 17–22 หลัก"
  });

  if (!roleId || !channelId) {
    return buildValidationSummary({ ok: false, checks, warnings, errors });
  }

  let context = null;

  try {
    context = await loadValidationContext(guildId, verification);
  } catch (err) {
    errors.push("โหลดข้อมูลจาก Discord API ไม่สำเร็จ");
    checks.push({
      name: "discord_api",
      label: "Discord API ใช้งานได้",
      ok: false,
      detail: err.message
    });

    return buildValidationSummary({ ok: false, checks, warnings, errors });
  }

  checks.push({
    name: "discord_api",
    label: "Discord API ใช้งานได้",
    ok: true,
    detail: "โหลด guild/roles/channels/bot member สำเร็จ"
  });

  if (!context.guild) {
    errors.push("บอทไม่อยู่ใน guild นี้ หรือไม่มีสิทธิ์อ่าน guild");
    checks.push({
      name: "bot_in_guild",
      label: "บอทอยู่ในเซิร์ฟเวอร์",
      ok: false,
      detail: "Discord API ไม่พบ guild"
    });
  } else {
    checks.push({
      name: "bot_in_guild",
      label: "บอทอยู่ในเซิร์ฟเวอร์",
      ok: true,
      detail: context.guild.name || guildId
    });
  }

  if (!context.botMember) {
    errors.push("ไม่พบ member object ของบอทใน guild");
    checks.push({
      name: "bot_member",
      label: "พบข้อมูลสมาชิกของบอท",
      ok: false,
      detail: "getBotMember ไม่สำเร็จ"
    });
  } else {
    checks.push({
      name: "bot_member",
      label: "พบข้อมูลสมาชิกของบอท",
      ok: true,
      detail: context.botUser?.username || context.botUser?.id || "bot"
    });
  }

  if (context.botMember) {
    const roleResult = discordAPI.validateBotCanManageRole({
      botMember: context.botMember,
      roles: context.roles,
      targetRoleId: roleId
    });

    checks.push(...roleResult.checks);
    warnings.push(...roleResult.warnings);
    errors.push(...roleResult.errors);

    const channelResult = discordAPI.validateBotCanUseChannel({
      botMember: context.botMember,
      roles: context.roles,
      channel: context.channel
    });

    checks.push(...channelResult.checks);
    warnings.push(...channelResult.warnings);
    errors.push(...channelResult.errors);
  }

  const panel = normalizePanelInput(verification.panel || {});

  checks.push({
    name: "button_text",
    label: "ข้อความปุ่มไม่เกิน 80 ตัว",
    ok: panel.buttonText.length <= 80,
    detail: `${panel.buttonText.length}/80`
  });

  if (panel.buttonText.length > 80) errors.push("ข้อความปุ่มยาวเกิน 80 ตัว");

  if (mode === "oauth") {
    const hasClient = !!process.env.DISCORD_CLIENT_ID;
    const hasSecret = !!process.env.DISCORD_CLIENT_SECRET;
    const hasStateSecret = !!getStateSecret();

    checks.push({
      name: "oauth_client_id",
      label: "DISCORD_CLIENT_ID พร้อม",
      ok: hasClient,
      detail: hasClient ? "ผ่าน" : "ไม่พบ DISCORD_CLIENT_ID"
    });

    checks.push({
      name: "oauth_client_secret",
      label: "DISCORD_CLIENT_SECRET พร้อม",
      ok: hasSecret,
      detail: hasSecret ? "ผ่าน" : "ไม่พบ DISCORD_CLIENT_SECRET"
    });

    checks.push({
      name: "state_secret",
      label: "State secret พร้อม",
      ok: hasStateSecret,
      detail: hasStateSecret ? "ผ่าน" : "ต้องมี VERIFY_STATE_SECRET หรือ secret สำรอง"
    });

    if (!hasClient) errors.push("ไม่พบ DISCORD_CLIENT_ID");
    if (!hasSecret) errors.push("ไม่พบ DISCORD_CLIENT_SECRET");
    if (!hasStateSecret) errors.push("ไม่พบ VERIFY_STATE_SECRET/API_SECRET/SESSION_SECRET/ENCRYPTION_KEY");
  }

  return buildValidationSummary({
    ok: errors.length === 0,
    checks,
    warnings,
    errors
  });
}

/* =============================================================================
   View Route
============================================================================= */

router.get("/guild/:guildId", requireAdmin, requireGuildAdmin, (req, res) => {
  res.sendFile(require("path").join(__dirname, "../views/guild.html"));
});

/* =============================================================================
   Guild List
============================================================================= */

router.get("/api/guilds", requireAdmin, (req, res) => {
  const guilds = getSessionGuilds(req)
    .map(normalizeGuild)
    .filter(guild => guild.canManage || guild.isAdmin || guild.isOwner || guild.owner);
  const preferredGuildId = SNOWFLAKE_RE.test(String(req.session?.preferredGuildId || ""))
    && guilds.some(guild => guild.id === String(req.session.preferredGuildId))
    ? String(req.session.preferredGuildId)
    : null;

  if (req.session?.preferredGuildId) delete req.session.preferredGuildId;

  res.json({
    success: true,
    guilds,
    preferredGuildId
  });
});
/* =============================================================================
   Config / Resources
============================================================================= */

router.get("/api/guild/:guildId/config", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);

    res.json({
      success: true,
      guild: serializeGuildFromSession(req.adminGuild),
      config: serializeConfig(config)
    });
  } catch (err) {
    return sendServerError(res, "config", err);
  }
});

router.post("/api/guild/:guildId/settings", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const adminId = getAdminId(req);

    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);
    const mergedVerification = mergeVerificationConfig(config.verification || {}, req.body || {});

    mergedVerification.updatedBy = adminId;
    mergedVerification.updatedAt = now();

    config.guildName = req.adminGuild?.name || config.guildName || guildId;
    config.verification = mergedVerification;
    config.updatedAt = now();

    await config.save();

    res.json({
      success: true,
      config: serializeConfig(config)
    });
  } catch (err) {
    return sendServerError(res, "settings", err);
  }
});

router.get("/api/guild/:guildId/verify/resources", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;

    const [guild, roles, channels, botUser] = await Promise.all([
      discordAPI.getGuild(guildId),
      discordAPI.getGuildRoles(guildId),
      discordAPI.getGuildChannels(guildId),
      discordAPI.getCurrentBotUser()
    ]);

    res.json({
      success: true,
      guild: guild || serializeGuildFromSession(req.adminGuild),
      botUser,
      roles,
      channels
    });
  } catch (err) {
    return sendServerError(res, "verify.resources", err, "โหลด roles/channels ไม่สำเร็จ");
  }
});

router.post("/api/guild/:guildId/verify/validate", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);
    const verification = mergeVerificationConfig(config.verification || {}, req.body || {});
    const validation = await validateVerificationConfig(req, guildId, verification);

    res.json({
      success: true,
      validation
    });
  } catch (err) {
    return sendServerError(res, "verify.validate", err, "ตรวจสอบ config ไม่สำเร็จ");
  }
});

/* =============================================================================
   Send / Update / Disable Verification Panel
============================================================================= */

router.post("/api/guild/:guildId/verify/panel/send", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const adminId = getAdminId(req);

    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);
    const verification = mergeVerificationConfig(config.verification || {}, req.body || {});
    const validation = await validateVerificationConfig(req, guildId, verification);

    if (validation.ok === false) {
      return res.status(400).json({
        success: false,
        error: "config ยังไม่ผ่าน validation",
        validation
      });
    }

    const channelId = cleanSnowflake(verification.channelId);

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: "Channel ID ไม่ถูกต้อง"
      });
    }

    /*
      สำคัญ:
      ส่งแผงใหม่ = rotate state ใหม่เสมอ
      แผงเก่าที่มี state เก่าจะถูก callback ปัดตกเมื่อ oauth.js เช็ก panelRevision
    */
    verification.panelRevision = makePanelRevision("panel");
    verification.panelRevisionUpdatedAt = now();

    const payload = makePanelPayload(req, { guildId, verification });
    const sent = await discordAPI.createChannelMessage(channelId, payload);

    if (!sent.ok) {
      return res.status(400).json({
        success: false,
        error: "ส่งแผงใหม่ไม่สำเร็จ",
        discordStatus: sent.status,
        discordError: sent.error
      });
    }

    verification.channelId = channelId;
    verification.messageId = sent.message?.id || verification.messageId || null;
    verification.updatedBy = adminId;
    verification.updatedAt = now();

    config.guildName = req.adminGuild?.name || config.guildName || guildId;
    config.verification = verification;
    config.updatedAt = now();

    await config.save();

    res.json({
      success: true,
      message: "ส่งแผงยืนยันตัวตนใหม่แล้ว",
      messageId: verification.messageId,
      channelId: verification.channelId,
      panelRevision: verification.panelRevision,
      panelRevisionUpdatedAt: verification.panelRevisionUpdatedAt,
      config: serializeConfig(config),
      validation
    });
  } catch (err) {
    return sendServerError(res, "verify.panel.send", err, "ส่งแผงยืนยันตัวตนไม่สำเร็จ");
  }
});

router.patch("/api/guild/:guildId/verify/panel/update", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const adminId = getAdminId(req);

    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);
    const verification = mergeVerificationConfig(config.verification || {}, req.body || {});
    const validation = await validateVerificationConfig(req, guildId, verification);

    if (validation.ok === false) {
      return res.status(400).json({
        success: false,
        error: "config ยังไม่ผ่าน validation",
        validation
      });
    }

    const channelId = cleanSnowflake(verification.channelId);
    const messageId = cleanSnowflake(verification.messageId);

    if (!channelId || !messageId) {
      return res.status(400).json({
        success: false,
        error: "ต้องมี Channel ID และ Message ID ของแผงเดิมก่อนถึงจะแก้ message เดิมได้"
      });
    }

    const existing = await discordAPI.fetchChannelMessage(channelId, messageId);

    if (!existing.ok) {
      return res.status(404).json({
        success: false,
        error: "หา message เดิมไม่เจอ หรือบอทไม่มีสิทธิ์อ่าน message นี้ ให้กดส่งแผงใหม่แทน",
        discordStatus: existing.status,
        discordError: existing.error
      });
    }

    /*
      สำคัญ:
      แก้แผงเดิม = rotate state ใหม่เสมอ
      message เดิมยังอยู่ แต่ URL ในปุ่มจะเปลี่ยนเป็น state revision ล่าสุด
    */
    verification.panelRevision = makePanelRevision("panel");
    verification.panelRevisionUpdatedAt = now();

    const payload = makePanelPayload(req, { guildId, verification });
    const edited = await discordAPI.editChannelMessage(channelId, messageId, payload);

    if (!edited.ok) {
      return res.status(400).json({
        success: false,
        error: "แก้แผงเดิมไม่สำเร็จ",
        discordStatus: edited.status,
        discordError: edited.error
      });
    }

    verification.channelId = channelId;
    verification.messageId = messageId;
    verification.updatedBy = adminId;
    verification.updatedAt = now();

    config.guildName = req.adminGuild?.name || config.guildName || guildId;
    config.verification = verification;
    config.updatedAt = now();

    await config.save();

    res.json({
      success: true,
      message: "แก้ไขแผงเดิมใน Discord แล้ว",
      messageId,
      channelId,
      panelRevision: verification.panelRevision,
      panelRevisionUpdatedAt: verification.panelRevisionUpdatedAt,
      config: serializeConfig(config),
      validation
    });
  } catch (err) {
    return sendServerError(res, "verify.panel.update", err, "แก้แผงยืนยันตัวตนเดิมไม่สำเร็จ");
  }
});

router.post("/api/guild/:guildId/verify/disable", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const adminId = getAdminId(req);

    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);
    const verification = mergeVerificationConfig(config.verification || {}, req.body || {});

    /*
      ปิดระบบ = rotate revision เป็น disabled ทันที
      ต่อให้มีคนกดแผงเก่า callback ก็จะไม่ตรงกับ revision ล่าสุด
    */
    verification.enabled = false;
    verification.panelRevision = makePanelRevision("disabled");
    verification.panelRevisionUpdatedAt = now();
    verification.updatedBy = adminId;
    verification.updatedAt = now();

    config.guildName = req.adminGuild?.name || config.guildName || guildId;
    config.verification = verification;
    config.updatedAt = now();

    await config.save();

    res.json({
      success: true,
      message: "ปิดระบบยืนยันตัวตนแล้ว",
      panelRevision: verification.panelRevision,
      panelRevisionUpdatedAt: verification.panelRevisionUpdatedAt,
      config: serializeConfig(config)
    });
  } catch (err) {
    return sendServerError(res, "verify.disable", err, "ปิดระบบยืนยันตัวตนไม่สำเร็จ");
  }
});

/* =============================================================================
   Logs / Members
============================================================================= */

router.get("/api/guild/:guildId/logs", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit, 25, 100);
    const skip = page * limit;

    const filter = buildLogQuery(guildId, req.query);

    const [config, total, logs] = await Promise.all([
      GuildConfig.findOne({ guildId }).select("security").lean(),
      VerifyLog.countDocuments(filter),
      VerifyLog.find(filter)
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);
    const canViewSensitive = canViewSensitiveData(config);
    if (canViewSensitive) {
      await recordSensitiveAccess(guildId, req, "/api/guild/:guildId/logs");
    }

    res.json({
      success: true,
      sensitiveDataAccess: normalizeSensitiveAccess(config?.security || {}),
      logs: logs.map(log => serializeVerifyLog(log, { canViewSensitive })),
      pagination: pagination(page, limit, total)
    });
  } catch (err) {
    return sendServerError(res, "logs", err, "โหลด logs ไม่สำเร็จ");
  }
});
router.get("/api/guild/:guildId/members", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit, 25, 100);
    const skip = page * limit;

    const filter = buildLogQuery(guildId, req.query);

    const [config, total, logs] = await Promise.all([
      GuildConfig.findOne({ guildId }).select("security").lean(),
      VerifyLog.countDocuments(filter),
      VerifyLog.find(filter)
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);
    const canViewSensitive = canViewSensitiveData(config);
    if (canViewSensitive) {
      await recordSensitiveAccess(guildId, req, "/api/guild/:guildId/members");
    }

    res.json({
      success: true,
      sensitiveDataAccess: normalizeSensitiveAccess(config?.security || {}),
      members: logs.map(log => serializeVerifyLog(log, { canViewSensitive })),
      pagination: pagination(page, limit, total)
    });
  } catch (err) {
    return sendServerError(res, "members", err, "โหลด members ไม่สำเร็จ");
  }
});

router.get("/api/guild/:guildId/stats", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;

    const logs = await VerifyLog.find(getBaseFilter(guildId))
      .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
      .limit(500)
      .lean();

    res.json({
      success: true,
      stats: summarizeCounts(logs)
    });
  } catch (err) {
    return sendServerError(res, "stats", err, "โหลดสถิติไม่สำเร็จ");
  }
});

/* =============================================================================
   Existing Reveal / Delete compatibility
============================================================================= */

router.post("/api/guild/:guildId/reveal-request", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const adminId = getAdminId(req);

    const targetUserId = cleanSnowflake(req.body?.targetUserId);
    const reason = cleanText(req.body?.reason, 500) || "Guild admin requested sensitive data reveal";

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: "targetUserId ไม่ถูกต้อง"
      });
    }

    const request = await IPRevealRequest.create({
      guildId,
      guildName: req.adminGuild?.name || guildId,
      requestedBy: adminId,
      targetUserId,
      reason,
      status: "pending",
      createdAt: now(),
      expiresAt: now() + 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      request: {
        id: String(request._id),
        targetUserId: request.targetUserId,
        status: request.status,
        reason: request.reason,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt
      }
    });
  } catch (err) {
    return sendServerError(res, "reveal-request", err, "สร้างคำขอ reveal ไม่สำเร็จ");
  }
});

router.delete("/api/guild/:guildId/member/:userId", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId, userId } = req.params;
    const adminId = getAdminId(req);

    const targetUserId = cleanSnowflake(userId);

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: "userId ไม่ถูกต้อง"
      });
    }

    const deletedAt = now();
    const deletedBy = adminId || "guild-admin";

    const [verifyLogs, oauthGuildData, oauthLastData, singleIpLinks, sharedIpLinks] = await Promise.all([
      VerifyLog.updateMany(
        {
          guildId,
          userId: targetUserId,
          deletedAt: { $exists: false }
        },
        {
          $set: {
            deletedAt,
            deletedBy
          }
        }
      ),
      OAuthUser.updateOne(
        {
          "discord.userId": targetUserId,
          deletedAt: { $exists: false }
        },
        {
          $pull: {
            guilds: { id: guildId }
          },
          $set: {
            updatedAt: deletedAt
          }
        }
      ),
      OAuthUser.updateOne(
        {
          "discord.userId": targetUserId,
          $or: [
            { "lastVerify.guildId": guildId },
            { "lastMember.guildId": guildId }
          ],
          deletedAt: { $exists: false }
        },
        {
          $unset: {
            lastVerify: "",
            lastMember: ""
          },
          $set: {
            updatedAt: deletedAt
          }
        }
      ),
      IpIdentityLink.updateMany(
        {
          guildId,
          "users.userId": targetUserId,
          uniqueUsers: { $lte: 1 },
          deletedAt: { $exists: false }
        },
        {
          $set: {
            deletedAt,
            deletedBy,
            updatedAt: deletedAt
          }
        }
      ),
      IpIdentityLink.updateMany(
        {
          guildId,
          "users.userId": targetUserId,
          uniqueUsers: { $gt: 1 },
          deletedAt: { $exists: false }
        },
        {
          $pull: {
            users: { userId: targetUserId },
            roleSnapshots: { userId: targetUserId }
          },
          $inc: {
            uniqueUsers: -1
          },
          $set: {
            updatedAt: deletedAt
          }
        }
      )
    ]);

    res.json({
      success: true,
      deletedCount: verifyLogs.modifiedCount || 0,
      details: {
        verifyLogs: verifyLogs.modifiedCount || 0,
        oauthGuildsPulled: oauthGuildData.modifiedCount || 0,
        oauthLastSnapshotsCleared: oauthLastData.modifiedCount || 0,
        ipIdentityLinksDeleted: singleIpLinks.modifiedCount || 0,
        ipIdentityLinksUpdated: sharedIpLinks.modifiedCount || 0
      }
    });
  } catch (err) {
    return sendServerError(res, "delete-member-data", err, "ลบข้อมูลสมาชิกไม่สำเร็จ");
  }
});

/* =============================================================================
   Compatibility aliases
============================================================================= */

router.get("/api/guild/:guildId", requireAdmin, requireGuildAdmin, async (req, res) => {
  try {
    const { guildId } = req.params;
    const config = await ensureGuildConfig(guildId, req.adminGuild?.name);

    res.json({
      success: true,
      guild: serializeGuildFromSession(req.adminGuild),
      config: serializeConfig(config)
    });
  } catch (err) {
    return sendServerError(res, "get-guild", err, "โหลดการตั้งค่าเซิร์ฟเวอร์ไม่สำเร็จ");
  }
});

router._test = {
  mergeVerificationConfig
};

module.exports = router;
