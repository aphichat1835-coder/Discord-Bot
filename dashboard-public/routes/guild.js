const router = require('express').Router();

const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const OAuthUser = require('../models/OAuthUser');
const IPRevealRequest = require('../models/IPRevealRequest');

function requireAdmin(req, res, next) {
    if (!req.session?.adminUser) {
        return res.status(401).json({
            success: false,
            error: 'กรุณา Login ก่อน'
        });
    }

    next();
}

function requireGuildAdmin(req, res, next) {
    const guildId = req.params.guildId || req.body?.guildId;
    const user = req.session.adminUser;

    if (!user?.adminGuilds?.some(g => g.id === guildId)) {
        return res.status(403).json({
            success: false,
            error: 'ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้'
        });
    }

    next();
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map(v => String(v).trim().toUpperCase()).filter(Boolean);
    }

    if (typeof value === 'string') {
        return value.split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
    }

    return [];
}

function sanitizeVerification(input = {}) {
    const out = {};

    if ('enabled' in input) out.enabled = !!input.enabled;
    if ('blockVPN' in input) out.blockVPN = !!input.blockVPN;
    if ('requireEmail' in input) out.requireEmail = !!input.requireEmail;
    if ('requireEmailVerified' in input) out.requireEmailVerified = !!input.requireEmailVerified;
    if ('requireConnections' in input) out.requireConnections = !!input.requireConnections;

    if ('minAccountAgeDays' in input) {
        out.minAccountAgeDays = Math.max(0, Math.min(3650, parseInt(input.minAccountAgeDays) || 0));
    }

    if ('minConnections' in input) {
        out.minConnections = Math.max(1, Math.min(20, parseInt(input.minConnections) || 1));
    }

    if ('roleId' in input) {
        out.roleId = input.roleId ? String(input.roleId).trim() : null;
    }

    if ('channelId' in input) {
        out.channelId = input.channelId ? String(input.channelId).trim() : null;
    }

    if ('messageId' in input) {
        out.messageId = input.messageId ? String(input.messageId).trim() : null;
    }

    if ('allowedCountries' in input) {
        out.allowedCountries = normalizeStringArray(input.allowedCountries);
    }

    if ('blockedCountries' in input) {
        out.blockedCountries = normalizeStringArray(input.blockedCountries);
    }

    out.updatedAt = Date.now();

    return out;
}

router.get('/api/guilds', requireAdmin, (req, res) => {
    res.json({
        success: true,
        guilds: req.session.adminUser.adminGuilds
    });
});

router.get('/api/guild/:guildId', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const config = await GuildConfig.findOne({ guildId });

        res.json({
            success: true,
            config: config || null
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.post('/api/guild/:guildId/settings', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { verification } = req.body || {};

    try {
        const set = {
            setupBy: req.session.adminUser.userId,
            updatedAt: Date.now()
        };

        const sanitized = sanitizeVerification(verification || {});

        for (const [key, value] of Object.entries(sanitized)) {
            set[`verification.${key}`] = value;
        }

        await GuildConfig.findOneAndUpdate(
            { guildId },
            {
                $set: set,
                $setOnInsert: {
                    guildId,
                    createdAt: Date.now(),
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
            success: true
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.get('/api/guild/:guildId/logs', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    try {
        const filter = {
            guildId,
            deletedAt: { $exists: false }
        };

        const [logs, total] = await Promise.all([
            VerifyLog.find(filter)
                .sort({ verifiedAt: -1 })
                .skip(page * limit)
                .limit(limit),

            VerifyLog.countDocuments(filter)
        ]);

        res.json({
            success: true,
            logs,
            total,
            page,
            limit
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.get('/api/guild/:guildId/stats', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const base = {
            guildId,
            deletedAt: { $exists: false }
        };

        const [total, success, blocked, failed, vpn, proxy, tor] = await Promise.all([
            VerifyLog.countDocuments(base),
            VerifyLog.countDocuments({ ...base, result: 'success' }),
            VerifyLog.countDocuments({ ...base, result: 'blocked' }),
            VerifyLog.countDocuments({ ...base, result: 'failed' }),
            VerifyLog.countDocuments({ ...base, 'ipInfo.isVPN': true }),
            VerifyLog.countDocuments({ ...base, 'ipInfo.isProxy': true }),
            VerifyLog.countDocuments({ ...base, 'ipInfo.isTOR': true })
        ]);

        res.json({
            success: true,
            stats: {
                total,
                success,
                blocked,
                failed,
                vpn,
                proxy,
                tor
            }
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.get('/api/guild/:guildId/members', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    try {
        const successLogs = await VerifyLog.find({
            guildId,
            result: 'success',
            deletedAt: { $exists: false }
        })
            .sort({ verifiedAt: -1 })
            .skip(page * limit)
            .limit(limit);

        const userIds = [...new Set(successLogs.map(l => l.userId))];

        const users = await OAuthUser.find({
            'discord.userId': { $in: userIds }
        }).select('discord connections lastVerify');

        const revealRequests = await IPRevealRequest.find({
            guildId,
            targetUserId: { $in: userIds },
            status: 'pending'
        }).select('targetUserId status createdAt');

        const userMap = Object.fromEntries(users.map(u => [u.discord.userId, u]));
        const requestMap = Object.fromEntries(revealRequests.map(r => [r.targetUserId, r]));

        const members = successLogs.map(log => {
            const user = userMap[log.userId];

            return {
                logId: log._id,
                userId: log.userId,
                username: user?.discord?.username || 'Unknown',
                globalName: user?.discord?.globalName || null,
                avatarUrl: user?.discord?.avatarUrl || null,
                avatarHash: user?.discord?.avatarHash || null,
                connections: user?.connections?.length || 0,
                country: log.ipInfo?.country || 'unknown',
                countryCode: log.ipInfo?.countryCode || 'unknown',
                city: log.ipInfo?.city || 'unknown',
                isp: log.ipInfo?.isp || 'unknown',
                isVPN: !!(log.ipInfo?.isVPN || log.ipInfo?.isProxy || log.ipInfo?.isTOR),
                riskScore: log.riskScore || log.ipInfo?.riskScore || 0,
                deviceType: log.device?.deviceType || 'unknown',
                browser: log.device?.browser || 'unknown',
                os: log.device?.os || 'unknown',
                verifiedAt: log.verifiedAt,
                revealRequest: requestMap[log.userId] || null
            };
        });

        res.json({
            success: true,
            members,
            page,
            limit
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.post('/api/guild/:guildId/reveal-ip/request', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { userId, verifyLogId, reason } = req.body || {};

    if (!userId) {
        return res.status(400).json({
            success: false,
            error: 'ต้องระบุ userId'
        });
    }

    try {
        const existing = await IPRevealRequest.findOne({
            guildId,
            targetUserId: userId,
            status: 'pending'
        });

        if (existing) {
            return res.json({
                success: true,
                request: existing,
                message: 'มีคำขอที่รออนุมัติอยู่แล้ว'
            });
        }

        const request = await IPRevealRequest.create({
            guildId,
            targetUserId: userId,
            verifyLogId: verifyLogId || null,
            requestedBy: req.session.adminUser.userId,
            reason: String(reason || '').slice(0, 500)
        });

        res.json({
            success: true,
            request
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.delete('/api/guild/:guildId/member/:userId/data', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId, userId } = req.params;

    try {
        await VerifyLog.updateMany(
            { guildId, userId, deletedAt: { $exists: false } },
            {
                $set: {
                    deletedAt: Date.now(),
                    deletedBy: req.session.adminUser.userId
                }
            }
        );

        res.json({
            success: true
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

module.exports = router;
