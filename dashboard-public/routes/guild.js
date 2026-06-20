/* eslint-disable complexity -- Legacy dashboard routes keep stable response shapes; refactor separately. */
/*
================================================================================
  Guild Admin Dashboard Routes — Dashboard Public v2

  Scope:
  - Guild admin session guard
  - Guild settings
  - Verification panel resources / validation / send / update / disable
  - Members / logs APIs with detailed verification data
  - Raw IP exposure for guild admin dashboard when encrypted IP is available
  - Existing reveal/delete behavior preserved
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

const { decryptIP } = require("../utils/crypto");
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
  buildSensitiveAccessAuditUpdate,
  redactSensitiveDiscordSnapshot,
  redactSensitiveIpInfo
} = require("../utils/sensitiveAccess");

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
  const owner = !!guild.owner || !!guild.isOwner;
  const isAdmin = owner || guild.isAdmin === true;
  const canManageGuild = owner || isAdmin;
  const canManageRoles = owner || isAdmin;
  const canManage = owner || isAdmin;
  return {
    id: String(guild.id || ""),
    name: String(guild.name || "Unknown Server"),
    icon: guild.icon || null,
    owner,
    permissions: String(guild.permissions || "0"),
    isAdmin,
    isOwner: owner,
    canManage,
    canManageGuild,
    canManageRoles
  };
}

function getGuildFromSession(req, guildId) {
  return getSessionGuilds(req)
    .map(normalizeGuild)
    .find(guild => guild.id === String(guildId) && (guild.isOwner || guild.isAdmin));
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
  return Math.max(0, parseInt(value, 10) || 0);
}

function parseLimit(value, fallback = 25, max = 100) {
  return Math.min(max, Math.max(1, parseInt(value, 10) || fallback));
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

  if (envUrl) return String(envUrl).replace(/\/+$/, "");

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function makeRequestId(prefix = "req") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
    out.minAccountAgeDays = Math.max(0, Math.min(3650, parseInt(input.minAccountAgeDays, 10) || 0));
  }

  if ("minConnections" in input) {
    out.minConnections = Math.max(1, Math.min(20, parseInt(input.minConnections, 10) || 1));
  }

  if ("roleId" in input) out.roleId = cleanOptionalSnowflake(input.roleId);
  if ("channelId" in input) out.channelId = cleanOptionalSnowflake(input.channelId);
  if ("messageId" in input) out.messageId = cleanOptionalSnowflake(input.messageId);

  if ("allowedCountries" in input) out.allowedCountries = normalizeStringArray(input.allowedCountries);
  if ("blockedCountries" in input) out.blockedCountries = normalizeStringArray(input.blockedCountries);

  if ("antiAlt" in input && input.antiAlt && typeof input.antiAlt === "object" && !Array.isArray(input.antiAlt)) {
    const rawAntiAlt = input.antiAlt;
    out.antiAlt = normalizeAntiAltConfig({
      enabled: rawAntiAlt.enabled === true || rawAntiAlt.enabled === "true" || rawAntiAlt.enabled === "on",
      ipDuplicateAction: normalizeAction(rawAntiAlt.ipDuplicateAction, "log_only"),
      maxUsersPerIp: clampNumber(rawAntiAlt.maxUsersPerIp, 1, 20, 3),
      deviceDuplicateAction: normalizeAction(rawAntiAlt.deviceDuplicateAction, "log_only"),
      maxUsersPerDevice: clampNumber(rawAntiAlt.maxUsersPerDevice, 1, 20, 2),
      previouslyBlockedIpAction: normalizeAction(rawAntiAlt.previouslyBlockedIpAction, "delay"),
      spoofedHeaderAction: normalizeAction(rawAntiAlt.spoofedHeaderAction, "delay"),
      unknownLookupAction: normalizeAction(rawAntiAlt.unknownLookupAction, "delay"),
      delayMs: clampNumber(rawAntiAlt.delayMs, 0, 10000, 5000)
    });
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

    out.panel = normalizePanel(panel);
  }

  out.updatedAt = now();

  return normalizeVerificationConfig(out);
}

function mergeVerificationConfig(existing = {}, incoming = {}) {
  const current = normalizeVerificationConfig(existing || {});
  const clean = sanitizeVerification(incoming || {});
  const hasIncomingAntiAlt = Object.prototype.hasOwnProperty.call(incoming || {}, "antiAlt");
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
          ...(current.antiAlt || {}),
          ...(clean.antiAlt || {})
        })
      : current.antiAlt,
    panel: normalizePanel({
      ...(current.panel || {}),
      ...(clean.panel || {})
    }),
    updatedAt: now()
  };
  merged.oauthMode = normalizeVerifyMode(merged.verifyType || merged.panel?.verifyType);
  merged.verifyType = merged.oauthMode;
  merged.panel.verifyType = merged.oauthMode;
  return merged;
}

function decryptRawIp(ipInfo = {}) {
  if (ipInfo.rawIp) return ipInfo.rawIp;
  if (ipInfo.ip) return ipInfo.ip;

  if (!ipInfo.encryptedRawIp) return null;

  try {
    return decryptIP(ipInfo.encryptedRawIp);
  } catch {
    return null;
  }
}

function safeIpInfo(ipInfo = {}, canViewSensitive = false) {
  const rawIp = canViewSensitive ? decryptRawIp(ipInfo) : null;

  return {
    rawIp: rawIp || null,
    ip: rawIp || null,

    country: ipInfo.country || "unknown",
    countryCode: ipInfo.countryCode || "unknown",
    region: ipInfo.region || "",
    city: ipInfo.city || "unknown",
    zip: ipInfo.zip || "",
    lat: ipInfo.lat ?? null,
    lon: ipInfo.lon ?? null,
    timezone: ipInfo.timezone || "",

    isp: ipInfo.isp || "unknown",
    org: ipInfo.org || "",
    as: ipInfo.as || "",
    asn: ipInfo.as || "",
    asname: ipInfo.asname || "",
    reverse: ipInfo.reverse || "",

    isVPN: !!ipInfo.isVPN,
    isProxy: !!ipInfo.isProxy,
    isTOR: !!ipInfo.isTOR,
    isHosting: !!ipInfo.hosting,
    hosting: !!ipInfo.hosting,
    mobile: !!ipInfo.mobile,

    riskScore: Number(ipInfo.riskScore || 0),

    lookupProvider: ipInfo.lookupProvider || "",
    lookupStatus: ipInfo.lookupStatus || "",
    lookupMessage: ipInfo.lookupMessage || "",

    proxyCheckProvider: ipInfo.proxyCheckProvider || "",
    proxyCheckStatus: ipInfo.proxyCheckStatus || "",

    lookupAt: ipInfo.lookupAt || null
  };
}
function safeDevice(device = {}) {
  return {
    userAgent: device.userAgent || "",
    browser: device.browser || "unknown",
    os: device.os || "unknown",
    language: device.language || "",
    languages: Array.isArray(device.languages) ? device.languages.slice(0, 12) : [],
    timezone: device.timezone || "",
    platform: device.platform || "",
    deviceType: device.deviceType || "unknown",
    screenSize: device.screenSize || "",
    viewportSize: device.viewportSize || "",
    colorDepth: device.colorDepth ?? null,
    devicePixelRatio: device.devicePixelRatio ?? null,
    touchPoints: device.touchPoints ?? null,
    referrer: device.referrer || "",
    fingerprintVersion: Number(device.fingerprintVersion || 0) || null,
    hasFingerprint: !!device.fingerprintHash
  };
}

function safePolicySnapshot(snapshot = {}) {
  return {
    enabled: snapshot.enabled,
    blockVPN: snapshot.blockVPN,
    minAccountAgeDays: snapshot.minAccountAgeDays,
    requireEmail: snapshot.requireEmail,
    requireEmailVerified: snapshot.requireEmailVerified,
    requireConnections: snapshot.requireConnections,
    minConnections: snapshot.minConnections,
    allowedCountries: Array.isArray(snapshot.allowedCountries) ? snapshot.allowedCountries.slice(0, 80) : [],
    blockedCountries: Array.isArray(snapshot.blockedCountries) ? snapshot.blockedCountries.slice(0, 80) : []
  };
}

function safeDiscordSnapshot(snapshot = {}, canViewSensitive = false) {
  const profile = snapshot.profileSnapshot || snapshot;

  const discord = {
    userId: profile.userId || profile.id || snapshot.userId || snapshot.id || null,
    username: profile.username || snapshot.username || "",
    discriminator: profile.discriminator || snapshot.discriminator || null,
    globalName: profile.globalName || profile.global_name || snapshot.globalName || snapshot.global_name || null,
    displayTag: profile.displayTag || profile.tag || snapshot.displayTag || snapshot.tag || null,

    avatarHash: profile.avatarHash || profile.avatar || snapshot.avatarHash || snapshot.avatar || null,
    avatarUrl: profile.avatarUrl || snapshot.avatarUrl || null,
    bannerHash: profile.bannerHash || profile.banner || snapshot.bannerHash || snapshot.banner || null,
    bannerUrl: profile.bannerUrl || snapshot.bannerUrl || null,
    accentColor: profile.accentColor || profile.accent_color || snapshot.accentColor || snapshot.accent_color || null,

    email: profile.email || snapshot.email || null,
    emailVerified: profile.emailVerified === true || profile.verified === true || snapshot.emailVerified === true || snapshot.verified === true,
    locale: profile.locale || snapshot.locale || "",
    mfaEnabled: !!profile.mfaEnabled || !!profile.mfa_enabled || !!snapshot.mfaEnabled || !!snapshot.mfa_enabled,
    premiumType: profile.premiumType || profile.premium_type || snapshot.premiumType || snapshot.premium_type || 0,
    flags: profile.flags || snapshot.flags || 0,
    publicFlags: profile.publicFlags || profile.public_flags || snapshot.publicFlags || snapshot.public_flags || 0,

    accountCreatedAt: profile.accountCreatedAt ?? snapshot.accountCreatedAt ?? null,
    accountAgeDays: profile.accountAgeDays ?? snapshot.accountAgeDays ?? null,

    connectionsCount: Array.isArray(snapshot.connections)
      ? snapshot.connections.length
      : Number(snapshot.connectionsCount || 0),

    guildsCount: Array.isArray(snapshot.guilds)
      ? snapshot.guilds.length
      : Number(snapshot.guildsCount || 0),

    connections: Array.isArray(snapshot.connections)
      ? snapshot.connections.slice(0, 50).map(c => ({
          type: c.type || "",
          id: c.id || "",
          name: c.name || "",
          verified: c.verified,
          visibility: c.visibility,
          revoked: c.revoked
        }))
      : [],

    guilds: Array.isArray(snapshot.guilds)
      ? snapshot.guilds.slice(0, 50).map(g => {
          const guildSnapshot = g.snapshot || g;
          return {
            id: guildSnapshot.id || g.id || "",
            name: guildSnapshot.name || g.name || "",
            owner: guildSnapshot.owner === true || g.owner === true,
            permissions: guildSnapshot.permissions || g.permissions || "0"
          };
        })
      : [],

    callbackStateMode: snapshot.callbackStateMode || snapshot.stateMode || null,
    panelRevision: snapshot.panelRevision || null
  };

  return redactSensitiveDiscordSnapshot(discord, canViewSensitive);
}

function safeMemberSnapshot(snapshot = {}) {
  const member = snapshot.member?.snapshot || snapshot.member || snapshot;

  return {
    nick: member.nick || snapshot.nick || null,
    nickname: member.nick || snapshot.nickname || null,
    joinedAt: member.joinedAt || member.joined_at || snapshot.joinedAt || null,
    pending: member.pending === true || snapshot.pending === true,
    timedOut: !!member.communicationDisabledUntil || !!member.communication_disabled_until,
    communicationDisabledUntil: member.communicationDisabledUntil || member.communication_disabled_until || null,
    avatar: member.avatar || null,
    avatarUrl: member.avatarUrl || null,
    flags: member.flags || 0,

    roleCount: Array.isArray(member.roles)
      ? member.roles.length
      : Number(member.roleCount || snapshot.roleCount || 0),

    roles: Array.isArray(member.roles)
      ? member.roles.slice(0, 80)
      : []
  };
}

function safeTrackingSnapshot(snapshot = {}) {
  return {
    ipHash: snapshot.ipHash || null,
    firstSeenAt: snapshot.firstSeenAt || null,
    lastSeenAt: snapshot.lastSeenAt || null,
    totalVerifications: snapshot.totalVerifications || 0,
    uniqueUsers: snapshot.uniqueUsers || 0,
    maxRiskScore: snapshot.maxRiskScore || 0,
    lastRiskScore: snapshot.lastRiskScore || 0
  };
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
  const raw = log?.toObject ? log.toObject() : log;
  const canViewSensitive = options.canViewSensitive === true;

  const ipInfo = redactSensitiveIpInfo(safeIpInfo(raw.ipInfo || {}, canViewSensitive), canViewSensitive);
  const device = safeDevice(raw.device || {});
  const discord = safeDiscordSnapshot(raw.discordSnapshot || {}, canViewSensitive);
  const member = safeMemberSnapshot(raw.memberSnapshot || discord.member || {});
  const policy = safePolicySnapshot(raw.policySnapshot || {});
  const tracking = safeTrackingSnapshot(raw.trackingSnapshot || {});

  const userId = raw.userId || discord.userId || null;
  const result = raw.result || "failed";

  return {
    id: raw._id ? String(raw._id) : raw.id || null,
    _id: raw._id ? String(raw._id) : raw.id || null,

    guildId: raw.guildId,
    userId,
    roleId: raw.roleId || null,
    sensitiveRedacted: !canViewSensitive,

    result,
    reason: raw.reason || "",
    riskScore: Number(raw.riskScore || ipInfo.riskScore || 0),
    riskFlags: Array.isArray(raw.riskFlags) ? raw.riskFlags : [],

    oauthScope: raw.oauthScope || "",
    stateMode: raw.stateMode || "",

    user: discord,
    discordSnapshot: discord,
    memberSnapshot: member,
    policySnapshot: policy,
    trackingSnapshot: tracking,

    username: discord.username,
    globalName: discord.globalName,
    tag: discord.displayTag,
    email: discord.email,
    emailVerified: discord.emailVerified,
    locale: discord.locale,
    flags: discord.flags,
    publicFlags: discord.publicFlags,
    accountAgeDays: discord.accountAgeDays,
    accountCreatedAt: discord.accountCreatedAt,

    connectionsCount: discord.connectionsCount,
    guildsCount: discord.guildsCount,
    connections: discord.connections,
    guilds: discord.guilds,

    memberNick: member.nick,
    nickname: member.nickname,
    joinedAt: member.joinedAt,
    memberRoles: member.roles,

    ipInfo,
    rawIp: ipInfo.rawIp,
    ip: ipInfo.rawIp,
    countryCode: ipInfo.countryCode,
    country: ipInfo.country,
    city: ipInfo.city,
    isp: ipInfo.isp,
    asn: ipInfo.asn,
    isVPN: ipInfo.isVPN,
    isProxy: ipInfo.isProxy,
    isTOR: ipInfo.isTOR,
    isHosting: ipInfo.isHosting,

    device,
    browser: device.browser,
    os: device.os,
    platform: device.platform,
    timezone: device.timezone,
    language: device.language,
    screenSize: device.screenSize,
    viewportSize: device.viewportSize,

    joinResult: raw.joinResult || null,
    roleAssignResult: raw.roleAssignResult || null,
    roleAssignmentResult: raw.roleAssignResult?.ok === true
      ? "success"
      : raw.roleAssignResult?.error
        ? "failed"
        : raw.roleAssignResult || null,
    roleResult: raw.roleAssignResult?.ok === true ? "success" : raw.roleAssignResult?.status || "",

    policyResult: result,
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
    const rx = new RegExp(escaped, "i");

    filter.$or = [
      { userId: q },
      { roleId: q },
      { reason: rx },
      { requestId: q },
      { "discordSnapshot.username": rx },
      { "discordSnapshot.globalName": rx },
      { "discordSnapshot.email": rx },
      { "ipInfo.countryCode": rx },
      { "ipInfo.city": rx },
      { "ipInfo.isp": rx }
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

function getStateSecret() {
  return String(
    process.env.VERIFY_STATE_SECRET ||
    process.env.API_SECRET ||
    process.env.INTERNAL_API_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.ENCRYPTION_KEY ||
    ""
  );
}

function requireStateSecret() {
  const secret = getStateSecret();

  if (!secret) {
    throw new Error("Missing VERIFY_STATE_SECRET/API_SECRET/INTERNAL_API_SECRET/SESSION_SECRET/ENCRYPTION_KEY");
  }

  return secret;
}

function signStateData(data) {
  return crypto
    .createHmac("sha256", requireStateSecret())
    .update(data)
    .digest("base64url")
    .slice(0, 22);
}
function createCompactCallbackState({
  guildId,
  roleId,
  expectedUserId = null,
  panelRevision = null
}) {
  const user = expectedUserId || "0";

  const revision = String(panelRevision || "legacy")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80) || "legacy";

  const ts = (Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toString(36);
  const nonce = crypto.randomBytes(6).toString("base64url");

  const data = `4|${guildId}|${roleId}|${user}|${revision}|${ts}|${nonce}`;
  const sig = signStateData(data);

  return `4.${guildId}.${roleId}.${user}.${revision}.${ts}.${nonce}.${sig}`;
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

module.exports = router;
