const router = require('express').Router();

const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const OAuthUser = require('../models/OAuthUser');
const IPRevealRequest = require('../models/IPRevealRequest');

/*
================================================================================
  Guild Dashboard Extension Routes

  Adds:
  - GET /api/guild/:guildId/overview
  - GET /api/guild/:guildId/risk

  Goals:
  - Give guild admins useful dashboard/debug information
  - Keep public callback debug disabled
  - Never expose raw IP, encryptedRawIp, ipHash, OAuth tokens, secrets, env vars
  - Keep owner-only reveal flow intact
================================================================================
*/

function requireAdmin(req, res, next) {
    if (!req.session?.adminUser) {
        return res.status(401).json({
            success: false,
            error: 'กรุณา Login ก่อน',
            code: 'admin_login_required'
        });
    }

    next();
}

function getAdminGuilds(req) {
    if (Array.isArray(req.session?.adminGuilds)) {
        return req.session.adminGuilds;
    }

    if (Array.isArray(req.session?.adminUser?.adminGuilds)) {
        return req.session.adminUser.adminGuilds;
    }

    return [];
}

function normalizeGuild(guild = {}) {
    return {
        id: String(guild.id || ''),
        name: String(guild.name || 'Unknown Server'),
        icon: guild.icon || null,
        owner: !!guild.owner,
        permissions: String(guild.permissions || '0'),
        isAdmin: guild.isAdmin !== undefined ? !!guild.isAdmin : true,
        isOwner: guild.isOwner !== undefined ? !!guild.isOwner : !!guild.owner,
        canManage: guild.canManage !== undefined ? !!guild.canManage : true
    };
}

function getGuildFromSession(req, guildId) {
    return getAdminGuilds(req)
        .map(normalizeGuild)
        .find(guild => guild.id === String(guildId));
}

function requireGuildAdmin(req, res, next) {
    const guildId = req.params.guildId || req.body?.guildId;
    const guild = getGuildFromSession(req, guildId);

    if (!guild) {
        return res.status(403).json({
            success: false,
            error: 'ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้',
            code: 'guild_admin_required'
        });
    }

    req.adminGuild = guild;
    next();
}

function safeServerError(res, err, message) {
    console.error('[GUILD-DASHBOARD]', err?.message || err);

    return res.status(500).json({
        success: false,
        error: message || 'เกิดข้อผิดพลาดภายในระบบ'
    });
}

function baseFilter(guildId) {
    return {
        guildId,
        deletedAt: { $exists: false }
    };
}

function safeIpInfo(ipInfo = {}) {
    /*
      Intentionally excluded:
      - raw IP
      - encryptedRawIp
      - ipHash
      - lookupRaw
      - proxyCheckRaw
    */
    return {
        country: ipInfo.country || 'unknown',
        countryCode: ipInfo.countryCode || 'unknown',
        region: ipInfo.region || '',
        city: ipInfo.city || 'unknown',
        timezone: ipInfo.timezone || '',
        isp: ipInfo.isp || 'unknown',
        org: ipInfo.org || '',
        as: ipInfo.as || '',
        asname: ipInfo.asname || '',
        isVPN: !!ipInfo.isVPN,
        isProxy: !!ipInfo.isProxy,
        isTOR: !!ipInfo.isTOR,
        hosting: !!ipInfo.hosting,
        mobile: !!ipInfo.mobile,
        riskScore: Number(ipInfo.riskScore || 0),
        lookupProvider: ipInfo.lookupProvider || '',
        lookupStatus: ipInfo.lookupStatus || '',
        proxyCheckProvider: ipInfo.proxyCheckProvider || '',
        proxyCheckStatus: ipInfo.proxyCheckStatus || ''
    };
}

function safeDevice(device = {}) {
    return {
        browser: device.browser || 'unknown',
        os: device.os || 'unknown',
        language: device.language || '',
        timezone: device.timezone || '',
        platform: device.platform || '',
        deviceType: device.deviceType || 'unknown',
        screenSize: device.screenSize || '',
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
            ? snapshot.allowedCountries.slice(0, 50)
            : [],
        blockedCountries: Array.isArray(snapshot.blockedCountries)
            ? snapshot.blockedCountries.slice(0, 50)
            : []
    };
}

function safeDiscordSnapshot(snapshot = {}) {
    return {
        username: snapshot.username || '',
        globalName: snapshot.globalName || null,
        discriminator: snapshot.discriminator || null,
        locale: snapshot.locale || '',
        emailVerified: snapshot.emailVerified === true,
        premiumType: snapshot.premiumType || 0,
        flags: snapshot.flags || 0,
        accountCreatedAt: snapshot.accountCreatedAt || null,
        accountAgeDays: snapshot.accountAgeDays || null,
        connectionsCount: Array.isArray(snapshot.connections)
            ? snapshot.connections.length
            : Number(snapshot.connectionsCount || 0),
        guildsCount: Array.isArray(snapshot.guilds)
            ? snapshot.guilds.length
            : Number(snapshot.guildsCount || 0)
    };
}

function safeMemberSnapshot(snapshot = {}) {
    return {
        nick: snapshot.nick || null,
        joinedAt: snapshot.joinedAt || null,
        pending: snapshot.pending === true,
        timedOut: !!snapshot.communicationDisabledUntil,
        roleCount: Array.isArray(snapshot.roles)
            ? snapshot.roles.length
            : Number(snapshot.roleCount || 0),
        roles: Array.isArray(snapshot.roles)
            ? snapshot.roles.slice(0, 25)
            : []
    };
}

function safeTrackingSnapshot(snapshot = {}) {
    /*
      Intentionally excluded:
      - ipHash
    */
    return {
        firstSeenAt: snapshot.firstSeenAt || null,
        lastSeenAt: snapshot.lastSeenAt || null,
        totalVerifications: Number(snapshot.totalVerifications || 0),
        uniqueUsers: Number(snapshot.uniqueUsers || 0),
        maxRiskScore: Number(snapshot.maxRiskScore || 0),
        lastRiskScore: Number(snapshot.lastRiskScore || 0)
    };
}

function safeRoleResult(result = {}) {
    return {
        ok: result.ok === true,
        skipped: result.skipped === true,
        reason: result.reason || '',
        status: result.status || '',
        message: result.message || ''
    };
}

function safeLog(log) {
    const obj = typeof log.toObject === 'function' ? log.toObject() : log;

    return {
        id: String(obj._id || ''),
        guildId: obj.guildId,
        userId: obj.userId,
        roleId: obj.roleId || null,

        result: obj.result,
        reason: obj.reason || '',
        riskScore: Number(obj.riskScore || obj.ipInfo?.riskScore || 0),
        riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags : [],

        oauthScope: obj.oauthScope || '',
        stateMode: obj.stateMode || '',

        ipInfo: safeIpInfo(obj.ipInfo || {}),
        device: safeDevice(obj.device || {}),
        discord: safeDiscordSnapshot(obj.discordSnapshot || {}),
        member: safeMemberSnapshot(obj.memberSnapshot || {}),
        tracking: safeTrackingSnapshot(obj.trackingSnapshot || {}),

        debug: {
            reason: obj.reason || '',
            result: obj.result || '',
            stateMode: obj.stateMode || '',
            riskScore: Number(obj.riskScore || obj.ipInfo?.riskScore || 0),
            riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags : [],
            policy: safePolicySnapshot(obj.policySnapshot || {}),
            roleAssignResult: safeRoleResult(obj.roleAssignResult || {}),
            joinResult: safeRoleResult(obj.joinResult || {})
        },

        verifiedAt: obj.verifiedAt || null
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
        VerifyLog.countDocuments({ ...filter, result: 'success' }),
        VerifyLog.countDocuments({ ...filter, result: 'blocked' }),
        VerifyLog.countDocuments({ ...filter, result: 'failed' }),
        VerifyLog.countDocuments({ ...filter, 'ipInfo.isVPN': true }),
        VerifyLog.countDocuments({ ...filter, 'ipInfo.isProxy': true }),
        VerifyLog.countDocuments({ ...filter, 'ipInfo.isTOR': true }),
        VerifyLog.countDocuments({ ...filter, 'ipInfo.hosting': true }),
        VerifyLog.countDocuments({ ...filter, 'ipInfo.mobile': true }),
        VerifyLog.countDocuments({ ...filter, riskScore: { $gte: 70 } }),
        IPRevealRequest.countDocuments({ guildId, status: 'pending' })
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

async function buildRiskSummary(guildId) {
    const filter = baseFilter(guildId);

    const [countries, isps, devices, reasons, recentRiskLogs] = await Promise.all([
        VerifyLog.aggregate([
            { $match: filter },
            { $group: { _id: { $ifNull: ['$ipInfo.countryCode', 'unknown'] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),

        VerifyLog.aggregate([
            { $match: filter },
            { $group: { _id: { $ifNull: ['$ipInfo.isp', 'unknown'] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),

        VerifyLog.aggregate([
            { $match: filter },
            { $group: { _id: { $ifNull: ['$device.deviceType', 'unknown'] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 8 }
        ]),

        VerifyLog.aggregate([
            { $match: { ...filter, result: { $in: ['blocked', 'failed'] } } },
            { $group: { _id: { $ifNull: ['$reason', 'unknown'] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]),

        VerifyLog.find({
            ...filter,
            $or: [
                { riskScore: { $gte: 70 } },
                { 'ipInfo.isVPN': true },
                { 'ipInfo.isProxy': true },
                { 'ipInfo.isTOR': true }
            ]
        })
            .sort({ verifiedAt: -1 })
            .limit(10)
    ]);

    return {
        countries: countries.map(item => ({
            label: item._id,
            count: item.count
        })),

        isps: isps.map(item => ({
            label: item._id,
            count: item.count
        })),

        devices: devices.map(item => ({
            label: item._id,
            count: item.count
        })),

        reasons: reasons.map(item => ({
            label: item._id,
            count: item.count
        })),

        recentRiskLogs: recentRiskLogs.map(safeLog)
    };
}

async function buildRecentMembers(guildId, limit = 8) {
    const logs = await VerifyLog.find({
        ...baseFilter(guildId),
        result: 'success'
    })
        .sort({ verifiedAt: -1 })
        .limit(limit);

    const userIds = [...new Set(logs.map(log => log.userId))];

    const users = await OAuthUser.find({
        'discord.userId': { $in: userIds }
    }).select('discord connections lastMember lastVerify');

    const userMap = Object.fromEntries(
        users.map(user => [user.discord.userId, user])
    );

    return logs.map(log => {
        const user = userMap[log.userId];

        return {
            logId: String(log._id),
            userId: log.userId,
            username: user?.discord?.username || log.discordSnapshot?.username || 'Unknown',
            globalName: user?.discord?.globalName || log.discordSnapshot?.globalName || null,
            avatarUrl: user?.discord?.avatarUrl || null,
            accountAgeDays: user?.discord?.accountAgeDays || log.discordSnapshot?.accountAgeDays || null,
            emailVerified: user?.discord?.emailVerified === true || log.discordSnapshot?.emailVerified === true,
            connections: user?.connections?.length || 0,
            member: safeMemberSnapshot(log.memberSnapshot || user?.lastMember || {}),
            country: log.ipInfo?.country || 'unknown',
            countryCode: log.ipInfo?.countryCode || 'unknown',
            city: log.ipInfo?.city || 'unknown',
            isp: log.ipInfo?.isp || 'unknown',
            isVPN: !!(log.ipInfo?.isVPN || log.ipInfo?.isProxy || log.ipInfo?.isTOR),
            riskScore: Number(log.riskScore || log.ipInfo?.riskScore || 0),
            riskFlags: Array.isArray(log.riskFlags) ? log.riskFlags : [],
            device: safeDevice(log.device || {}),
            verifiedAt: log.verifiedAt || null
        };
    });
}

router.get('/api/guild/:guildId/overview', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const [config, stats, riskSummary, recentLogs, recentMembers] = await Promise.all([
            GuildConfig.findOne({ guildId }),
            buildStats(guildId),
            buildRiskSummary(guildId),
            VerifyLog.find(baseFilter(guildId)).sort({ verifiedAt: -1 }).limit(8),
            buildRecentMembers(guildId, 8)
        ]);

        res.json({
            success: true,
            guild: req.adminGuild,
            config: config || null,
            stats,
            riskSummary,
            recentLogs: recentLogs.map(safeLog),
            recentMembers
        });
    } catch (err) {
        return safeServerError(res, err, 'โหลดภาพรวมเซิร์ฟเวอร์ไม่สำเร็จ');
    }
});

router.get('/api/guild/:guildId/risk', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        res.json({
            success: true,
            guild: req.adminGuild,
            risk: await buildRiskSummary(guildId)
        });
    } catch (err) {
        return safeServerError(res, err, 'โหลดข้อมูลความเสี่ยงไม่สำเร็จ');
    }
});

module.exports = router;
