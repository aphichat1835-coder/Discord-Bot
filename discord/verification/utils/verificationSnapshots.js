const {
  redactSensitiveDiscordSnapshot,
  redactSensitiveIpInfo
} = require("./sensitiveAccess");

function safeIpLocation(ipInfo = {}) {
  return {
    country: ipInfo.country || "unknown",
    countryCode: ipInfo.countryCode || "unknown",
    region: ipInfo.region || "",
    city: ipInfo.city || "unknown",
    zip: ipInfo.zip || "",
    lat: ipInfo.lat ?? null,
    lon: ipInfo.lon ?? null,
    timezone: ipInfo.timezone || ""
  };
}

function safeIpNetwork(ipInfo = {}) {
  return {
    isp: ipInfo.isp || "unknown",
    org: ipInfo.org || "",
    as: ipInfo.as || "",
    asn: ipInfo.asn || ipInfo.as || "",
    asname: ipInfo.asname || "",
    reverse: ipInfo.reverse || ""
  };
}

function safeIpFlags(ipInfo = {}) {
  return {
    isVPN: !!ipInfo.isVPN,
    isProxy: !!ipInfo.isProxy,
    isTOR: !!ipInfo.isTOR,
    isHosting: !!(ipInfo.isHosting ?? ipInfo.hosting),
    hosting: !!(ipInfo.hosting ?? ipInfo.isHosting),
    mobile: !!ipInfo.mobile,
    riskScore: Number(ipInfo.riskScore || 0)
  };
}

function safeIpLookup(ipInfo = {}) {
  return {
    lookupProvider: ipInfo.lookupProvider || "",
    lookupStatus: ipInfo.lookupStatus || "",
    lookupMessage: ipInfo.lookupMessage || "",
    proxyCheckProvider: ipInfo.proxyCheckProvider || "",
    proxyCheckStatus: ipInfo.proxyCheckStatus || "",
    lookupAt: ipInfo.lookupAt || null
  };
}

function safeIpInfo(ipInfo = {}) {
  return {
    // Raw IP is intentionally unavailable in normal list/detail serializers.
    // Owner reveal is a separate PIN + CSRF + reason + audit action.
    rawIp: null,
    ip: null,
    ...safeIpLocation(ipInfo),
    ...safeIpNetwork(ipInfo),
    ...safeIpFlags(ipInfo),
    ...safeIpLookup(ipInfo)
  };
}

function safeDeviceIdentity(device = {}) {
  return {
    userAgent: device.userAgent || "",
    browser: device.browser || "unknown",
    os: device.os || "unknown",
    language: device.language || "",
    languages: Array.isArray(device.languages) ? device.languages : [],
    timezone: device.timezone || "",
    platform: device.platform || ""
  };
}

function safeDeviceDisplay(device = {}) {
  return {
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

function safeDevice(device = {}) {
  return {
    ...safeDeviceIdentity(device),
    ...safeDeviceDisplay(device)
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

function safeDiscordIdentity(profile = {}, snapshot = {}) {
  return {
    userId: profile.userId || profile.id || snapshot.userId || snapshot.id || null,
    username: profile.username || snapshot.username || "",
    discriminator: profile.discriminator || snapshot.discriminator || null,
    globalName: profile.globalName || profile.global_name || snapshot.globalName || snapshot.global_name || null,
    displayTag: profile.displayTag || profile.tag || snapshot.displayTag || snapshot.tag || null
  };
}

function safeDiscordVisuals(profile = {}, snapshot = {}) {
  return {
    avatarHash: profile.avatarHash || profile.avatar || snapshot.avatarHash || snapshot.avatar || null,
    avatarUrl: profile.avatarUrl || snapshot.avatarUrl || null,
    bannerHash: profile.bannerHash || profile.banner || snapshot.bannerHash || snapshot.banner || null,
    bannerUrl: profile.bannerUrl || snapshot.bannerUrl || null,
    accentColor: profile.accentColor || profile.accent_color || snapshot.accentColor || snapshot.accent_color || null
  };
}

function safeDiscordSecurity(profile = {}, snapshot = {}) {
  let badgeFlags = [];
  if (Array.isArray(profile.badgeFlags)) {
    badgeFlags = profile.badgeFlags;
  } else if (Array.isArray(snapshot.badgeFlags)) {
    badgeFlags = snapshot.badgeFlags;
  }

  return {
    email: profile.email ?? snapshot.email ?? null,
    emailVerified: profile.emailVerified ?? profile.verified ?? snapshot.emailVerified ?? snapshot.verified ?? false,
    locale: profile.locale ?? snapshot.locale ?? "",
    mfaEnabled: profile.mfaEnabled ?? profile.mfa_enabled ?? snapshot.mfaEnabled ?? snapshot.mfa_enabled ?? false,
    premiumType: profile.premiumType ?? profile.premium_type ?? snapshot.premiumType ?? snapshot.premium_type ?? 0,
    flags: profile.flags ?? snapshot.flags ?? 0,
    publicFlags: profile.publicFlags ?? profile.public_flags ?? snapshot.publicFlags ?? snapshot.public_flags ?? 0,
    badgeFlags,
    accountCreatedAt: profile.accountCreatedAt ?? snapshot.accountCreatedAt ?? null,
    accountAgeDays: profile.accountAgeDays ?? snapshot.accountAgeDays ?? null
  };
}

function safeDiscordConnections(snapshot = {}) {
  return Array.isArray(snapshot.connections)
    ? snapshot.connections.map(c => ({
        type: c.type || "",
        id: c.id || "",
        name: c.name || "",
        verified: c.verified,
        visibility: c.visibility,
        revoked: c.revoked,
        integrations: Array.isArray(c.integrations) ? c.integrations : [],
        metadata: c.metadata && typeof c.metadata === "object" ? c.metadata : {}
      }))
    : [];
}

function safeDiscordGuilds(snapshot = {}) {
  if (!Array.isArray(snapshot.guilds)) return [];

  return snapshot.guilds.map(g => {
    const guildSnapshot = g.snapshot || g;
    return {
      id: guildSnapshot.id || g.id || "",
      name: guildSnapshot.name || g.name || "",
      icon: guildSnapshot.icon || g.icon || null,
      iconUrl: guildSnapshot.iconUrl || g.iconUrl || null,
      owner: guildSnapshot.owner === true || g.owner === true,
      permissions: guildSnapshot.permissions || g.permissions || "0",
      permissionFlags: Array.isArray(g.permissionFlags) ? g.permissionFlags : [],
      isOwner: g.isOwner === true,
      isAdmin: g.isAdmin === true,
      canManageGuild: g.canManageGuild === true,
      canManageRoles: g.canManageRoles === true,
      canBanMembers: g.canBanMembers === true
    };
  });
}

function safeDiscordCounts(snapshot = {}) {
  return {
    connectionsCount: Array.isArray(snapshot.connections) ? snapshot.connections.length : Number(snapshot.connectionsCount || 0),
    guildsCount: Array.isArray(snapshot.guilds) ? snapshot.guilds.length : Number(snapshot.guildsCount || 0),
    connections: safeDiscordConnections(snapshot),
    guilds: safeDiscordGuilds(snapshot)
  };
}

function safeDiscordPanel(snapshot = {}) {
  return {
    callbackStateMode: snapshot.callbackStateMode || snapshot.stateMode || null,
    panelRevision: snapshot.panelRevision || null
  };
}

function safeDiscordSnapshot(snapshot = {}, canViewSensitive = false) {
  const profile = snapshot.profileSnapshot || snapshot;

  const discord = {
    ...safeDiscordIdentity(profile, snapshot),
    ...safeDiscordVisuals(profile, snapshot),
    ...safeDiscordSecurity(profile, snapshot),
    ...safeDiscordCounts(snapshot),
    ...safeDiscordPanel(snapshot)
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
    roleCount: Array.isArray(member.roles) ? member.roles.length : Number(member.roleCount || snapshot.roleCount || 0),
    roles: Array.isArray(member.roles) ? member.roles : []
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

function safeRoleResult(result = {}) {
  return {
    ok: result.ok === true,
    skipped: result.skipped === true,
    reason: result.reason || "",
    status: result.status || "",
    message: result.message || "",
    error: result.error || null
  };
}

function buildVerifyLogParts(rawLog = {}, canViewSensitive = false) {
  const raw = rawLog?.toObject ? rawLog.toObject() : rawLog;
  const ipInfo = redactSensitiveIpInfo(safeIpInfo(raw.ipInfo || {}), false);
  const device = safeDevice(raw.device || {});
  const discord = safeDiscordSnapshot(raw.discordSnapshot || {}, canViewSensitive);
  const member = safeMemberSnapshot(
    raw.memberSnapshot || raw.discordSnapshot?.memberSnapshot || raw.discordSnapshot?.member || {}
  );
  const policy = safePolicySnapshot(raw.policySnapshot || {});
  const tracking = safeTrackingSnapshot(raw.trackingSnapshot || {});

  return { raw, ipInfo, device, discord, member, policy, tracking };
}

function buildVerifyLogCommon(parts = {}, options = {}) {
  const { raw = {}, ipInfo = {}, device = {}, discord = {}, member = {}, policy = {}, tracking = {} } = parts;
  const result = raw.result ?? options.defaultResult ?? "failed";

  return {
    id: raw._id ? String(raw._id) : raw.id || null,
    _id: raw._id ? String(raw._id) : raw.id || null,
    guildId: raw.guildId,
    userId: raw.userId || discord.userId || null,
    roleId: raw.roleId || null,
    sensitiveRedacted: options.canViewSensitive !== true,
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
    viewportSize: device.viewportSize
  };
}

module.exports = {
  safeIpLocation,
  safeIpNetwork,
  safeIpFlags,
  safeIpLookup,
  safeIpInfo,
  safeDeviceIdentity,
  safeDeviceDisplay,
  safeDevice,
  safePolicySnapshot,
  safeDiscordIdentity,
  safeDiscordVisuals,
  safeDiscordSecurity,
  safeDiscordConnections,
  safeDiscordGuilds,
  safeDiscordCounts,
  safeDiscordPanel,
  safeDiscordSnapshot,
  safeMemberSnapshot,
  safeTrackingSnapshot,
  safeRoleResult,
  buildVerifyLogParts,
  buildVerifyLogCommon
};
