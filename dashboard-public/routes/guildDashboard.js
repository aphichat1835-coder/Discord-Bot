/* eslint-disable complexity -- Legacy dashboard serializers keep stable response shapes; refactor separately. */
/*
================================================================================
  Guild Dashboard Extension Routes — Dashboard Public v2

  Routes:
  - GET /api/guild/:guildId/overview
  - GET /api/guild/:guildId/risk

  Notes:
  - ใช้กับหน้า guild.html / guild-dashboard.js
  - แสดงข้อมูลละเอียดเท่าที่ระบบเก็บได้
  - ถ้ามี encryptedRawIp และถอดรหัสได้ จะส่ง rawIp ออกให้หน้าแอดมินเซิร์ฟ
  - ยังไม่ใช่ Log Center เต็ม อันนั้นพักไว้ทำทีหลัง
================================================================================
*/

const router = require("express").Router();

const GuildConfig = require("../models/GuildConfig");
const VerifyLog = require("../models/VerifyLog");
const OAuthUser = require("../models/OAuthUser");
const IPRevealRequest = require("../models/IPRevealRequest");

const { decryptIP } = require("../utils/crypto");
const { normalizeVerificationConfig } = require("../utils/verifyMode");
const {
    normalizeSensitiveAccess,
    canViewSensitiveData,
    buildSensitiveAccessAuditUpdate,
    redactSensitiveDiscordSnapshot,
    redactSensitiveIpInfo
} = require("../utils/sensitiveAccess");

function requireAdmin(req, res, next) {
    if (!req.session?.adminUser) {
        return res.status(401).json({
            success: false,
            error: "กรุณา Login ก่อน",
            code: "admin_login_required"
        });
    }

    next();
}

function getAdminGuilds(req) {
    if (Array.isArray(req.session?.adminGuilds)) return req.session.adminGuilds;
    if (Array.isArray(req.session?.adminUser?.adminGuilds)) return req.session.adminUser.adminGuilds;
    return [];
}

function getAdminId(req) {
    const user = req.session?.adminUser || {};
    return user.id || user.userId || user.discordId || "guild-admin";
}

async function recordSensitiveAccess(guildId, req, route) {
    try {
        await GuildConfig.updateOne(
            { guildId },
            buildSensitiveAccessAuditUpdate({
                actor: getAdminId(req),
                route
            })
        );
    } catch (err) {
        console.warn("[GUILD-DASHBOARD] sensitive access audit failed:", err?.message || err);
    }
}

function normalizeGuild(guild = {}) {
    const owner = !!guild.owner || !!guild.isOwner;
    const isAdmin = owner || guild.isAdmin === true;
    const canManageGuild = owner || guild.canManageGuild === true;
    const canManageRoles = owner || guild.canManageRoles === true;
    const canManage = owner || guild.canManage === true;
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
    return getAdminGuilds(req)
        .map(normalizeGuild)
        .find(guild => guild.id === String(guildId) && (guild.canManage || guild.isAdmin || guild.isOwner || guild.owner));
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

function safeServerError(res, err, message) {
    console.error("[GUILD-DASHBOARD]", err?.message || err);

    return res.status(500).json({
        success: false,
        error: message || "เกิดข้อผิดพลาดภายในระบบ"
    });
}

function baseFilter(guildId) {
    return {
        guildId,
        deletedAt: { $exists: false }
    };
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
        allowedCountries: Array.isArray(snapshot.allowedCountries)
            ? snapshot.allowedCountries.slice(0, 80)
            : [],
        blockedCountries: Array.isArray(snapshot.blockedCountries)
            ? snapshot.blockedCountries.slice(0, 80)
            : []
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

        callbackStateMode: snapshot.callbackStateMode || snapshot.stateMode || null
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

function safeLog(log, options = {}) {
    const obj = typeof log.toObject === "function" ? log.toObject() : log;
    const canViewSensitive = options.canViewSensitive === true;

    const ipInfo = redactSensitiveIpInfo(safeIpInfo(obj.ipInfo || {}, canViewSensitive), canViewSensitive);
    const device = safeDevice(obj.device || {});
    const discord = safeDiscordSnapshot(obj.discordSnapshot || {}, canViewSensitive);
    const member = safeMemberSnapshot(obj.memberSnapshot || discord.member || {});
    const tracking = safeTrackingSnapshot(obj.trackingSnapshot || {});

    return {
        id: String(obj._id || obj.id || ""),
        _id: String(obj._id || obj.id || ""),
        guildId: obj.guildId,
        userId: obj.userId || discord.userId || null,
        roleId: obj.roleId || null,
        sensitiveRedacted: !canViewSensitive,
        requestId: obj.requestId || "",

        result: obj.result,
        reason: obj.reason || "",
        riskScore: Number(obj.riskScore || ipInfo.riskScore || 0),
        riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags : [],

        oauthScope: obj.oauthScope || "",
        stateMode: obj.stateMode || "",

        user: discord,
        discordSnapshot: discord,
        memberSnapshot: member,
        policySnapshot: safePolicySnapshot(obj.policySnapshot || {}),
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

        joinResult: safeRoleResult(obj.joinResult || {}),
        roleAssignResult: safeRoleResult(obj.roleAssignResult || {}),
        roleAssignmentResult: obj.roleAssignResult?.ok === true
            ? "success"
            : obj.roleAssignResult?.error
                ? "failed"
                : obj.roleAssignResult || null,
        roleResult: obj.roleAssignResult?.ok === true
            ? "success"
            : obj.roleAssignResult?.status || "",

        policyResult: obj.result || "",
        verifiedAt: obj.verifiedAt || null,
        createdAt: obj.createdAt || obj.verifiedAt || null,

        debug: {
            reason: obj.reason || "",
            result: obj.result || "",
            stateMode: obj.stateMode || "",
            riskScore: Number(obj.riskScore || ipInfo.riskScore || 0),
            riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags : [],
            policy: safePolicySnapshot(obj.policySnapshot || {}),
            discord,
            member,
            tracking,
            roleAssignResult: safeRoleResult(obj.roleAssignResult || {}),
            joinResult: safeRoleResult(obj.joinResult || {})
        }
    };
}

function serializeConfig(doc) {
    const raw = doc?.toObject ? doc.toObject() : doc || {};
    const security = raw.security || {};

    return {
        guildId: raw.guildId || "",
        guildName: raw.guildName || "",
        verification: normalizeVerificationConfig(raw.verification || {}),
        security: {
            ...security,
            sensitiveDataAccess: normalizeSensitiveAccess(security)
        },
        setupBy: raw.setupBy || null,
        createdAt: raw.createdAt || null,
        updatedAt: raw.updatedAt || null
    };
}

async function buildStats(guildId) {
    const filter = baseFilter(guildId);

    const [
        total,
        success,
        blocked,
        failed,
        vpn,
        proxy,
        tor,
        hosting,
        mobile,
        highRisk,
        pendingReveal
    ] = await Promise.all([
        VerifyLog.countDocuments(filter),
        VerifyLog.countDocuments({ ...filter, result: "success" }),
        VerifyLog.countDocuments({ ...filter, result: "blocked" }),
        VerifyLog.countDocuments({ ...filter, result: "failed" }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isVPN": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isProxy": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isTOR": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.hosting": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.mobile": true }),
        VerifyLog.countDocuments({ ...filter, riskScore: { $gte: 70 } }),
        IPRevealRequest.countDocuments({ guildId, status: "pending" })
    ]);

    return {
        total,
        success,
        blocked,
        failed,
        vpn,
        proxy,
        tor,
        hosting,
        mobile,
        highRisk,
        pendingReveal,
        successRate: total ? Math.round((success / total) * 100) : 0
    };
}

function countBy(items, getter, limit = 12) {
    const map = new Map();

    for (const item of items) {
        const key = getter(item) || "unknown";
        map.set(key, (map.get(key) || 0) + 1);
    }

    return Array.from(map.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

async function buildRiskSummary(guildId) {
    const logs = await VerifyLog.find(baseFilter(guildId))
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .limit(300)
        .lean();

    const safeLogs = logs.map(safeLog);

    return {
        countries: countBy(safeLogs, log => log.countryCode || log.country || "unknown", 12),
        isps: countBy(safeLogs, log => log.isp || "unknown", 12),
        devices: countBy(safeLogs, log => {
            const browser = log.device?.browser || log.browser || "unknown";
            const os = log.device?.os || log.os || "unknown";
            return `${browser} / ${os}`;
        }, 12),
        reasons: countBy(safeLogs, log => log.reason || log.result || "unknown", 12),
        recentRiskLogs: safeLogs
            .filter(log => Number(log.riskScore || 0) >= 35 || log.result !== "success")
            .slice(0, 20)
    };
}

async function buildRecentMembers(guildId, limit = 8, options = {}) {
    const canViewSensitive = options.canViewSensitive === true;
    const logs = await VerifyLog.find({
        ...baseFilter(guildId),
        result: "success"
    })
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .limit(limit)
        .lean();

    const userIds = [...new Set(logs.map(log => log.userId).filter(Boolean))];

    const users = await OAuthUser.find({
        "discord.userId": { $in: userIds },
        deletedAt: { $exists: false }
    })
        .select("discord connections guilds lastMember lastVerify")
        .lean();

    const userMap = Object.fromEntries(
        users.map(user => [user.discord?.userId, user])
    );

    return logs.map(log => {
        const safe = safeLog(log, { canViewSensitive });
        const user = userMap[log.userId];
        const connectionsCount = Array.isArray(user?.connections)
            ? user.connections.length
            : safe.connectionsCount || 0;
        const guildsCount = Array.isArray(user?.guilds)
            ? user.guilds.length
            : safe.guildsCount || 0;

        return {
            ...safe,

            logId: String(log._id || ""),
            userId: log.userId,

            username: user?.discord?.username || safe.username || "Unknown",
            globalName: user?.discord?.globalName || safe.globalName || null,
            avatarUrl: user?.discord?.avatarUrl || safe.user?.avatarUrl || null,
            avatarHash: user?.discord?.avatarHash || safe.user?.avatarHash || null,

            accountAgeDays: user?.discord?.accountAgeDays ?? safe.accountAgeDays ?? null,
            accountCreatedAt: user?.discord?.accountCreatedAt || safe.accountCreatedAt || null,
            email: canViewSensitive ? (user?.discord?.email || safe.email || null) : null,
            emailVerified: user?.discord?.emailVerified === true || safe.emailVerified === true,
            premiumType: user?.discord?.premiumType || safe.user?.premiumType || 0,

            connections: canViewSensitive ? connectionsCount : 0,
            connectionsCount,

            guilds: canViewSensitive ? guildsCount : 0,
            guildsCount,

            member: safe.memberSnapshot,

            country: safe.country,
            countryCode: safe.countryCode,
            city: safe.city,
            isp: safe.isp,

            isVPN: !!(safe.isVPN || safe.isProxy || safe.isTOR),
            riskScore: Number(safe.riskScore || 0),
            riskFlags: Array.isArray(safe.riskFlags) ? safe.riskFlags : [],
            device: safe.device,
            network: safe.trackingSnapshot,
            verifiedAt: safe.verifiedAt || null
        };
    });
}

router.get("/api/guild/:guildId/overview", requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const [config, stats, riskSummary, recentLogs] = await Promise.all([
            GuildConfig.findOne({ guildId }).lean(),
            buildStats(guildId),
            buildRiskSummary(guildId),
            VerifyLog.find(baseFilter(guildId))
                .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
                .limit(8)
                .lean()
        ]);
        const canViewSensitive = canViewSensitiveData(config);
        if (canViewSensitive) {
            await recordSensitiveAccess(guildId, req, "/api/guild/:guildId/overview");
        }
        const recentMembers = await buildRecentMembers(guildId, 8, { canViewSensitive });

        res.json({
            success: true,
            guild: req.adminGuild,
            config: config ? serializeConfig(config) : null,
            sensitiveDataAccess: normalizeSensitiveAccess(config?.security || {}),
            stats,
            riskSummary,
            recentLogs: recentLogs.map(log => safeLog(log, { canViewSensitive })),
            recentMembers
        });
    } catch (err) {
        return safeServerError(res, err, "โหลดภาพรวมเซิร์ฟเวอร์ไม่สำเร็จ");
    }
});

router.get("/api/guild/:guildId/risk", requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        res.json({
            success: true,
            guild: req.adminGuild,
            risk: await buildRiskSummary(guildId)
        });
    } catch (err) {
        return safeServerError(res, err, "โหลดข้อมูลความเสี่ยงไม่สำเร็จ");
    }
});

module.exports = router;
