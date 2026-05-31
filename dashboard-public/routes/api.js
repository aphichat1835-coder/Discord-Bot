const router = require('express').Router();
const crypto = require('crypto');

const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const OAuthUser = require('../models/OAuthUser');
const IPRevealRequest = require('../models/IPRevealRequest');

const { decryptIP } = require('../utils/crypto');

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || process.env.API_SECRET || '';

function checkAuth(req, res) {
    const auth = String(req.headers['x-internal-secret'] || '');

    if (!INTERNAL_SECRET) {
        res.status(503).json({
            success: false,
            error: 'Internal API secret is not configured'
        });
        return false;
    }

    try {
        const a = Buffer.from(auth, 'utf8');
        const b = Buffer.from(INTERNAL_SECRET, 'utf8');

        if (a.length !== b.length) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return false;
        }

        if (!crypto.timingSafeEqual(a, b)) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return false;
        }

        return true;
    } catch {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return false;
    }
}

router.get('/internal/overview', async (req, res) => {
    if (!checkAuth(req, res)) return;

    try {
        const configs = await GuildConfig.find({ 'verification.enabled': true })
            .select('guildId guildName updatedAt verification security');

        const guildIds = configs.map(c => c.guildId);

        const stats = await VerifyLog.aggregate([
            {
                $match: {
                    guildId: { $in: guildIds },
                    deletedAt: { $exists: false }
                }
            },
            {
                $group: {
                    _id: '$guildId',
                    total: { $sum: 1 },
                    success: { $sum: { $cond: [{ $eq: ['$result', 'success'] }, 1, 0] } },
                    blocked: { $sum: { $cond: [{ $eq: ['$result', 'blocked'] }, 1, 0] } },
                    failed: { $sum: { $cond: [{ $eq: ['$result', 'failed'] }, 1, 0] } },
                    vpn: { $sum: { $cond: [{ $eq: ['$ipInfo.isVPN', true] }, 1, 0] } },
                    proxy: { $sum: { $cond: [{ $eq: ['$ipInfo.isProxy', true] }, 1, 0] } },
                    tor: { $sum: { $cond: [{ $eq: ['$ipInfo.isTOR', true] }, 1, 0] } },
                    lastAt: { $max: '$verifiedAt' }
                }
            }
        ]);

        const statsMap = Object.fromEntries(stats.map(s => [s._id, s]));

        const result = configs.map(c => ({
            guildId: c.guildId,
            guildName: c.guildName || 'Unknown',
            verification: c.verification || {},
            security: c.security || {},
            stats: statsMap[c.guildId] || {
                total: 0,
                success: 0,
                blocked: 0,
                failed: 0,
                vpn: 0,
                proxy: 0,
                tor: 0
            }
        }));

        res.json({
            success: true,
            guilds: result,
            total: result.length
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.get('/internal/guild/:guildId/stats', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const { guildId } = req.params;

    try {
        const filter = {
            guildId,
            deletedAt: { $exists: false }
        };

        const [config, counts, recentLogs] = await Promise.all([
            GuildConfig.findOne({ guildId }),

            VerifyLog.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        success: { $sum: { $cond: [{ $eq: ['$result', 'success'] }, 1, 0] } },
                        blocked: { $sum: { $cond: [{ $eq: ['$result', 'blocked'] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ['$result', 'failed'] }, 1, 0] } },
                        vpn: { $sum: { $cond: [{ $eq: ['$ipInfo.isVPN', true] }, 1, 0] } },
                        proxy: { $sum: { $cond: [{ $eq: ['$ipInfo.isProxy', true] }, 1, 0] } },
                        tor: { $sum: { $cond: [{ $eq: ['$ipInfo.isTOR', true] }, 1, 0] } }
                    }
                }
            ]),

            VerifyLog.find(filter)
                .sort({ verifiedAt: -1 })
                .limit(10)
                .select('userId result reason ipInfo.country ipInfo.countryCode ipInfo.isVPN ipInfo.isProxy ipInfo.isTOR riskScore verifiedAt')
        ]);

        res.json({
            success: true,
            config: config || null,
            stats: counts[0] || {
                total: 0,
                success: 0,
                blocked: 0,
                failed: 0,
                vpn: 0,
                proxy: 0,
                tor: 0
            },
            recent: recentLogs
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.get('/internal/guild/:guildId/members', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const { guildId } = req.params;
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    try {
        const logs = await VerifyLog.find({
            guildId,
            result: 'success',
            deletedAt: { $exists: false }
        })
            .sort({ verifiedAt: -1 })
            .skip(page * limit)
            .limit(limit);

        const userIds = [...new Set(logs.map(l => l.userId))];

        const users = await OAuthUser.find({
            'discord.userId': { $in: userIds }
        }).select('discord connections lastVerify');

        const userMap = Object.fromEntries(users.map(u => [u.discord.userId, u]));

        const members = logs.map(log => {
            const user = userMap[log.userId];

            return {
                logId: log._id,
                userId: log.userId,
                username: user?.discord?.username || 'Unknown',
                globalName: user?.discord?.globalName || null,
                avatarUrl: user?.discord?.avatarUrl || null,
                connections: user?.connections?.length || 0,
                country: log.ipInfo?.country,
                countryCode: log.ipInfo?.countryCode,
                city: log.ipInfo?.city,
                isp: log.ipInfo?.isp,
                isVPN: !!(log.ipInfo?.isVPN || log.ipInfo?.isProxy || log.ipInfo?.isTOR),
                riskScore: log.riskScore || log.ipInfo?.riskScore || 0,
                verifiedAt: log.verifiedAt
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

router.get('/internal/ip-reveal/requests', async (req, res) => {
    if (!checkAuth(req, res)) return;

    try {
        const requests = await IPRevealRequest.find({
            status: 'pending',
            expiresAt: { $gt: Date.now() }
        })
            .sort({ createdAt: -1 })
            .limit(100);

        res.json({
            success: true,
            requests
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.post('/internal/ip-reveal/:requestId/approve', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const { requestId } = req.params;
    const { approvedBy, ownerNote } = req.body || {};

    try {
        const request = await IPRevealRequest.findById(requestId);

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'ไม่พบคำขอ'
            });
        }

        const log = await VerifyLog.findOne({
            guildId: request.guildId,
            userId: request.targetUserId,
            ...(request.verifyLogId ? { _id: request.verifyLogId } : {}),
            deletedAt: { $exists: false }
        }).sort({ verifiedAt: -1 });

        if (!log?.ipInfo?.encryptedRawIp) {
            return res.status(404).json({
                success: false,
                error: 'ไม่พบ IP ที่เข้ารหัสไว้'
            });
        }

        const rawIp = decryptIP(log.ipInfo.encryptedRawIp);

        request.status = 'approved';
        request.approvedBy = approvedBy || 'owner';
        request.approvedAt = Date.now();
        request.ownerNote = ownerNote || '';
        request.updatedAt = Date.now();
        await request.save();

        res.json({
            success: true,
            requestId: request._id,
            guildId: request.guildId,
            targetUserId: request.targetUserId,
            rawIp,
            ipInfo: {
                country: log.ipInfo.country,
                countryCode: log.ipInfo.countryCode,
                city: log.ipInfo.city,
                isp: log.ipInfo.isp,
                isVPN: log.ipInfo.isVPN,
                isProxy: log.ipInfo.isProxy,
                isTOR: log.ipInfo.isTOR
            }
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.post('/internal/ip-reveal/:requestId/reject', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const { requestId } = req.params;
    const { rejectedBy, ownerNote } = req.body || {};

    try {
        const request = await IPRevealRequest.findByIdAndUpdate(
            requestId,
            {
                $set: {
                    status: 'rejected',
                    rejectedBy: rejectedBy || 'owner',
                    rejectedAt: Date.now(),
                    ownerNote: ownerNote || '',
                    updatedAt: Date.now()
                }
            },
            { new: true }
        );

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'ไม่พบคำขอ'
            });
        }

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

module.exports = router;
