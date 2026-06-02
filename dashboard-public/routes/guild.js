const router = require('express').Router();

const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const OAuthUser = require('../models/OAuthUser');
const IPRevealRequest = require('../models/IPRevealRequest');

/*
================================================================================
  Guild Admin Dashboard Routes

  Purpose:
  - Existing guild admin APIs
  - Stable compatibility with admin OAuth session
  - Safe dashboard data for guild admins
  - No raw IP exposure
  - No token/secret exposure
  - No public debug exposure

  Important:
  - Raw IP remains owner-only through reveal request / approval flow
  - Guild admins only see data scoped to their own guild
  - Existing reveal/delete behavior is preserved
================================================================================
*/

const SNOWFLAKE_RE = /^\d{17,22}$/;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

function now() {
    return Date.now();
}

function safeConsoleError(scope, err) {
    console.error(`[GUILD-DASHBOARD:${scope}]`, err?.message || err);
}

function sendServerError(res, scope, err, fallback = 'เกิดข้อผิดพลาดภายในระบบ') {
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

function getSessionGuilds(req) {
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
    return getSessionGuilds(req)
        .map(normalizeGuild)
        .find(guild => guild.id === String(guildId));
}

function requireAdmin(req, res, next) {
    if (!getAdminUser(req)) {
        return res.status(401).json({
            success: false,
            error: 'กรุณา Login ก่อน',
            code: 'admin_login_required'
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
            error: 'ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้',
            code: 'guild_admin_required'
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

    if (typeof value === 'string') {
        return value
            .split(',')
            .map(v => v.trim().toUpperCase())
            .filter(Boolean);
    }

    return [];
}

function cleanSnowflake(value) {
    const v = value ? String(value).trim() : '';
    if (!v) return null;
    return SNOWFLAKE_RE.test(v) ? v : null;
}

function cleanOptionalSnowflake(value) {
    const v = value ? String(value).trim() : '';
    if (!v) return null;
    return SNOWFLAKE_RE.test(v) ? v : null;
}

function cleanObjectId(value) {
    const v = value ? String(value).trim() : '';
    if (!v) return null;
    return OBJECT_ID_RE.test(v) ? v : null;
}

function cleanText(value, max = 1000) {
    if (value === null || value === undefined) return undefined;
    return String(value).trim().slice(0, max);
}

function cleanHexColor(value) {
    const v = value ? String(value).trim() : '';
    if (!v) return undefined;

    const normalized = v.startsWith('#') ? v : `#${v}`;
    return /^#[0-9a-fA-F]{6}$/.test(normalized)
        ? normalized.toUpperCase()
        : undefined;
}

function cleanUrl(value) {
    const v = value ? String(value).trim() : '';
    if (!v) return undefined;

    try {
        const url = new URL(v);
        if (!['http:', 'https:'].includes(url.protocol)) return undefined;
        return url.toString();
    } catch {
        return undefined;
    }
}

function parsePage(value) {
    return Math.max(0, parseInt(value, 10) || 0);
}

function parseLimit(value, fallback = 20, max = 50) {
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

function sanitizeVerification(input = {}) {
    const out = {};

    if ('enabled' in input) out.enabled = !!input.enabled;
    if ('blockVPN' in input) out.blockVPN = !!input.blockVPN;
    if ('requireEmail' in input) out.requireEmail = !!input.requireEmail;
    if ('requireEmailVerified' in input) out.requireEmailVerified = !!input.requireEmailVerified;
    if ('requireConnections' in input) out.requireConnections = !!input.requireConnections;

    if ('minAccountAgeDays' in input) {
        out.minAccountAgeDays = Math.max(
            0,
            Math.min(3650, parseInt(input.minAccountAgeDays, 10) || 0)
        );
    }

    if ('minConnections' in input) {
        out.minConnections = Math.max(
            1,
            Math.min(20, parseInt(input.minConnections, 10) || 1)
        );
    }

    if ('roleId' in input) out.roleId = cleanOptionalSnowflake(input.roleId);
    if ('channelId' in input) out.channelId = cleanOptionalSnowflake(input.channelId);
    if ('messageId' in input) out.messageId = cleanOptionalSnowflake(input.messageId);

    if ('allowedCountries' in input) out.allowedCountries = normalizeStringArray(input.allowedCountries);
    if ('blockedCountries' in input) out.blockedCountries = normalizeStringArray(input.blockedCountries);

    if ('panel' in input && input.panel && typeof input.panel === 'object') {
        const rawPanel = input.panel;
        const panel = {};

        if ('content' in rawPanel) {
            panel.content = cleanText(rawPanel.content, 1500) || '';
        }

        if ('title' in rawPanel) {
            panel.title = cleanText(rawPanel.title, 256) || undefined;
        }

        if ('description' in rawPanel) {
            panel.description = cleanText(rawPanel.description, 4000) || undefined;
        }

        if ('footerText' in rawPanel) {
            panel.footerText = cleanText(rawPanel.footerText, 2048) || undefined;
        }

        /*
          New dashboard uses one field: buttonText / buttonLabel
          Existing backend panel field is kept as buttonLabel for compatibility.
        */
        if ('buttonText' in rawPanel) {
            panel.buttonLabel = cleanText(rawPanel.buttonText, 80) || undefined;
        }

        if ('buttonLabel' in rawPanel) {
            panel.buttonLabel = cleanText(rawPanel.buttonLabel, 80) || undefined;
        }

        if ('buttonEmoji' in rawPanel) {
            panel.buttonEmoji = cleanText(rawPanel.buttonEmoji, 80) || undefined;
        }

        if ('verifyType' in rawPanel) {
            panel.verifyType = rawPanel.verifyType === 'direct' ? 'direct' : 'oauth';
        }

        if ('showTimestamp' in rawPanel) {
            panel.showTimestamp = !!rawPanel.showTimestamp;
        }

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

function safeIpInfo(ipInfo = {}) {
    /*
      Intentionally excluded:
      - raw IP
      - encryptedRawIp
      - ipHash
      - lookup raw payload
      - proxycheck raw payload
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
        viewportSize: device.viewportSize || '',
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
      - raw device fingerprint
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

function safeRevealRequest(request) {
    if (!request) return null;

    const obj = typeof request.toObject === 'function' ? request.toObject() : request;

    return {
        id: String(obj._id || ''),
        targetUserId: obj.targetUserId || '',
        status: obj.status || '',
        reason: obj.reason || '',
        createdAt: obj.createdAt || null,
        expiresAt: obj.expiresAt || null
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
            result: obj.result || '',
            reason: obj.reason || '',
            stateMode: obj.stateMode || '',
            riskScore: Number(obj.riskScore || obj.ipInfo?.riskScore || 0),
            riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags : [],
            policy: safePolicySnapshot(obj.policySnapshot || {}),
            discord: safeDiscordSnapshot(obj.discordSnapshot || {}),
            member: safeMemberSnapshot(obj.memberSnapshot || {}),
            tracking: safeTrackingSnapshot(obj.trackingSnapshot || {}),
            roleAssignResult: safeRoleResult(obj.roleAssignResult || {}),
            joinResult: safeRoleResult(obj.joinResult || {})
        },

        verifiedAt: obj.verifiedAt || null
    };
}

async function buildStats(guildId) {
    const filter = getBaseFilter(guildId);

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

/*
================================================================================
  Routes
================================================================================
*/

router.get('/api/guilds', requireAdmin, (req, res) => {
    res.json({
        success: true,
        guilds: getSessionGuilds(req).map(normalizeGuild)
    });
});

router.get('/api/guild/:guildId', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const config = await GuildConfig.findOne({ guildId });

        res.json({
            success: true,
            guild: req.adminGuild,
            config: config || null
        });
    } catch (err) {
        return sendServerError(res, 'get-guild', err, 'โหลดการตั้งค่าเซิร์ฟเวอร์ไม่สำเร็จ');
    }
});

router.post('/api/guild/:guildId/settings', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { verification } = req.body || {};

    try {
        const adminId = getAdminId(req);
        const sanitized = sanitizeVerification(verification || {});

        const set = {
            setupBy: adminId,
            updatedAt: now(),
            guildName: req.adminGuild?.name || undefined,
            'verification.updatedBy': adminId,
            'verification.updatedAt': now()
        };

        for (const [key, value] of Object.entries(sanitized)) {
            if (key === 'panel' && value && typeof value === 'object') {
                for (const [panelKey, panelValue] of Object.entries(value)) {
                    set[`verification.panel.${panelKey}`] = panelValue;
                }
            } else {
                set[`verification.${key}`] = value;
            }
        }

        const config = await GuildConfig.findOneAndUpdate(
            { guildId },
            {
                $set: set,
                $setOnInsert: {
                    guildId,
                    createdAt: now(),
                    'security.storeOAuthTokens': true,
                    'security.storeRawIpEncrypted': true,
                    'security.ipRevealRequiresOwnerApproval': true,
                    'security.retentionMode': 'until_admin_delete'
                }
            },
            {
                upsert: true,
                new: true
            }
        );

        res.json({
            success: true,
            message: 'บันทึกการตั้งค่าแล้ว',
            config
        });

    } catch (err) {
        return sendServerError(res, 'save-settings', err, 'บันทึกการตั้งค่าไม่สำเร็จ');
    }
});

router.get('/api/guild/:guildId/logs', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit, 20, 50);
    const result = req.query.result ? String(req.query.result) : '';

    try {
        const filter = getBaseFilter(guildId);

        if (['success', 'blocked', 'failed'].includes(result)) {
            filter.result = result;
        }

        const [logs, total] = await Promise.all([
            VerifyLog.find(filter)
                .sort({ verifiedAt: -1 })
                .skip(page * limit)
                .limit(limit),

            VerifyLog.countDocuments(filter)
        ]);

        res.json({
            success: true,
            logs: logs.map(safeLog),
            pagination: pagination(page, limit, total),
            total,
            page,
            limit
        });

    } catch (err) {
        return sendServerError(res, 'logs', err, 'โหลด logs ไม่สำเร็จ');
    }
});

router.get('/api/guild/:guildId/stats', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        res.json({
            success: true,
            stats: await buildStats(guildId)
        });

    } catch (err) {
        return sendServerError(res, 'stats', err, 'โหลดสถิติไม่สำเร็จ');
    }
});

router.get('/api/guild/:guildId/members', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit, 20, 50);

    try {
        const filter = {
            guildId,
            result: 'success',
            deletedAt: { $exists: false }
        };

        const [successLogs, total] = await Promise.all([
            VerifyLog.find(filter)
                .sort({ verifiedAt: -1 })
                .skip(page * limit)
                .limit(limit),

            VerifyLog.countDocuments(filter)
        ]);

        const userIds = [...new Set(successLogs.map(log => log.userId).filter(Boolean))];

        const [users, revealRequests] = await Promise.all([
            OAuthUser.find({
                'discord.userId': { $in: userIds }
            }).select('discord connections lastVerify lastMember'),

            IPRevealRequest.find({
                guildId,
                targetUserId: { $in: userIds },
                status: 'pending'
            }).select('targetUserId status createdAt expiresAt reason')
        ]);

        const userMap = Object.fromEntries(
            users.map(user => [user.discord.userId, user])
        );

        const requestMap = Object.fromEntries(
            revealRequests.map(request => [request.targetUserId, request])
        );

        const members = successLogs.map(log => {
            const user = userMap[log.userId];
            const discord = safeDiscordSnapshot(log.discordSnapshot || {});
            const member = safeMemberSnapshot(log.memberSnapshot || user?.lastMember || {});

            return {
                logId: String(log._id),
                userId: log.userId,

                username: user?.discord?.username || discord.username || 'Unknown',
                globalName: user?.discord?.globalName || discord.globalName || null,
                avatarUrl: user?.discord?.avatarUrl || null,
                avatarHash: user?.discord?.avatarHash || null,

                accountAgeDays: user?.discord?.accountAgeDays || discord.accountAgeDays || null,
                accountCreatedAt: user?.discord?.accountCreatedAt || discord.accountCreatedAt || null,
                emailVerified: user?.discord?.emailVerified === true || discord.emailVerified,
                premiumType: user?.discord?.premiumType || discord.premiumType || 0,

                connections: Array.isArray(user?.connections)
                    ? user.connections.length
                    : discord.connectionsCount || 0,

                member,

                country: log.ipInfo?.country || 'unknown',
                countryCode: log.ipInfo?.countryCode || 'unknown',
                city: log.ipInfo?.city || 'unknown',
                isp: log.ipInfo?.isp || 'unknown',
                isVPN: !!(log.ipInfo?.isVPN || log.ipInfo?.isProxy || log.ipInfo?.isTOR),

                riskScore: Number(log.riskScore || log.ipInfo?.riskScore || 0),
                riskFlags: Array.isArray(log.riskFlags) ? log.riskFlags : [],

                device: safeDevice(log.device || {}),
                network: safeTrackingSnapshot(log.trackingSnapshot || {}),
                verifiedAt: log.verifiedAt || null,

                revealRequest: safeRevealRequest(requestMap[log.userId]),

                debug: {
                    reason: log.reason || '',
                    stateMode: log.stateMode || '',
                    roleAssignResult: safeRoleResult(log.roleAssignResult || {}),
                    joinResult: safeRoleResult(log.joinResult || {})
                }
            };
        });

        res.json({
            success: true,
            members,
            pagination: pagination(page, limit, total),
            total,
            page,
            limit
        });

    } catch (err) {
        return sendServerError(res, 'members', err, 'โหลดข้อมูลสมาชิกไม่สำเร็จ');
    }
});

router.post('/api/guild/:guildId/reveal-ip/request', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { userId, verifyLogId, reason } = req.body || {};

    const cleanUserId = cleanSnowflake(userId);
    const cleanVerifyLogId = cleanObjectId(verifyLogId);

    if (!cleanUserId) {
        return res.status(400).json({
            success: false,
            error: 'ต้องระบุ userId ให้ถูกต้อง'
        });
    }

    try {
        const existing = await IPRevealRequest.findOne({
            guildId,
            targetUserId: cleanUserId,
            status: 'pending'
        });

        if (existing) {
            return res.json({
                success: true,
                request: safeRevealRequest(existing),
                message: 'มีคำขอที่รออนุมัติอยู่แล้ว'
            });
        }

        const request = await IPRevealRequest.create({
            guildId,
            targetUserId: cleanUserId,
            verifyLogId: cleanVerifyLogId,
            requestedBy: getAdminId(req),
            reason: String(reason || '').slice(0, 500)
        });

        res.json({
            success: true,
            request: safeRevealRequest(request),
            message: 'ส่งคำขอแล้ว รอเจ้าของบอทอนุมัติ'
        });

    } catch (err) {
        return sendServerError(res, 'reveal-request', err, 'ส่งคำขอดู IP ไม่สำเร็จ');
    }
});

router.delete('/api/guild/:guildId/member/:userId/data', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId, userId } = req.params;
    const cleanUserId = cleanSnowflake(userId);

    if (!cleanUserId) {
        return res.status(400).json({
            success: false,
            error: 'userId ไม่ถูกต้อง'
        });
    }

    try {
        const result = await VerifyLog.updateMany(
            {
                guildId,
                userId: cleanUserId,
                deletedAt: { $exists: false }
            },
            {
                $set: {
                    deletedAt: now(),
                    deletedBy: getAdminId(req)
                }
            }
        );

        res.json({
            success: true,
            deletedLogs: result.modifiedCount || 0,
            message: 'ลบข้อมูล log ของสมาชิกในเซิร์ฟเวอร์นี้แล้ว'
        });

    } catch (err) {
        return sendServerError(res, 'delete-member-data', err, 'ลบข้อมูลไม่สำเร็จ');
    }
});

module.exports = router;
