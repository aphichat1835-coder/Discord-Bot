/* eslint-disable complexity -- Internal owner API serializers keep stable response shapes; refactor separately. */
const router = require('express').Router();
const crypto = require('crypto');

const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const IPRevealRequest = require('../models/IPRevealRequest');

const { decryptIP } = require('../utils/crypto');
const {
    normalizeSensitiveAccess,
    buildSensitiveAccessPatch
} = require('../utils/sensitiveAccess');
const { makeOAuthUserSummaryMap } = require('../utils/oauthUserSummary');

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || process.env.API_SECRET || '';
const INTERNAL_OVERVIEW_GUILDS_MAX = Math.max(
    50,
    Number(process.env.INTERNAL_OVERVIEW_GUILDS_MAX || 500) || 500
);

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
            res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
            return false;
        }

        if (!crypto.timingSafeEqual(a, b)) {
            res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
            return false;
        }

        return true;
    } catch {
        res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
        return false;
    }
}

function baseFilter(guildId) {
    return {
        guildId,
        deletedAt: { $exists: false }
    };
}

function parsePage(value) {
    return Math.max(0, parseInt(value, 10) || 0);
}

function parseLimit(value, fallback = 20, max = 100) {
    return Math.min(max, Math.max(1, parseInt(value, 10) || fallback));
}

function parseObjectIdHex(value) {
    const raw = String(value || '').trim();
    return /^[a-fA-F0-9]{24}$/.test(raw) ? raw.toLowerCase() : null;
}

function safeConfig(config) {
    if (!config) return null;

    const raw = typeof config.toObject === 'function'
        ? config.toObject()
        : config;

    return {
        guildId: raw.guildId,
        guildName: raw.guildName,
        verification: raw.verification || {},
        security: {
            ...raw.security,
            sensitiveDataAccess: normalizeSensitiveAccess(raw.security || {})
        },
        setupBy: raw.setupBy || null,
        createdAt: raw.createdAt || null,
        updatedAt: raw.updatedAt || null
    };
}

function safeRecentLog(log) {
    const raw = typeof log.toObject === 'function'
        ? log.toObject()
        : log;

    return {
        id: String(raw._id || ''),
        requestId: raw.requestId || '',

        userId: raw.userId,
        roleId: raw.roleId || null,

        result: raw.result,
        reason: raw.reason || '',
        riskScore: Number(raw.riskScore || raw.ipInfo?.riskScore || 0),

        country: raw.ipInfo?.country || null,
        countryCode: raw.ipInfo?.countryCode || null,
        city: raw.ipInfo?.city || null,
        isp: raw.ipInfo?.isp || null,

        isVPN: !!raw.ipInfo?.isVPN,
        isProxy: !!raw.ipInfo?.isProxy,
        isTOR: !!raw.ipInfo?.isTOR,
        hosting: !!raw.ipInfo?.hosting,

        browser: raw.device?.browser || null,
        os: raw.device?.os || null,
        platform: raw.device?.platform || null,

        statePanelRevision:
            raw.guildSnapshot?.statePanelRevision ||
            raw.discordSnapshot?.statePanelRevision ||
            null,

        latestPanelRevision:
            raw.guildSnapshot?.latestPanelRevision ||
            raw.discordSnapshot?.latestPanelRevision ||
            null,

        verifiedAt: raw.verifiedAt || null,
        createdAt: raw.createdAt || raw.verifiedAt || null
    };
}

function safeRevealRequest(request) {
    const raw = typeof request.toObject === 'function'
        ? request.toObject()
        : request;

    return {
        id: String(raw._id || ''),
        guildId: raw.guildId,
        guildName: raw.guildName || '',
        requestedBy: raw.requestedBy || '',
        targetUserId: raw.targetUserId || '',
        verifyLogId: raw.verifyLogId || null,
        reason: raw.reason || '',
        status: raw.status || 'pending',
        ownerNote: raw.ownerNote || '',
        createdAt: raw.createdAt || null,
        expiresAt: raw.expiresAt || null,
        approvedBy: raw.approvedBy || null,
        approvedAt: raw.approvedAt || null,
        rejectedBy: raw.rejectedBy || null,
        rejectedAt: raw.rejectedAt || null,
        viewedBy: raw.viewedBy || null,
        viewedAt: raw.viewedAt || null,
        viewCount: Number(raw.viewCount || 0),
        accessLog: Array.isArray(raw.accessLog)
            ? raw.accessLog.slice(-25).map(item => ({
                action: item?.action || '',
                actor: item?.actor || null,
                viewedBy: item?.viewedBy || null,
                viewedAt: item?.viewedAt || null,
                guildId: item?.guildId || raw.guildId,
                targetUserId: item?.targetUserId || raw.targetUserId,
                verifyLogId: item?.verifyLogId || null,
                reason: item?.reason || raw.reason || '',
                ownerNote: item?.ownerNote || raw.ownerNote || ''
            }))
            : [],
        updatedAt: raw.updatedAt || null
    };
}

async function expireRevealRequests(now = Date.now()) {
    await IPRevealRequest.updateMany(
        {
            status: 'pending',
            expiresAt: { $lte: now }
        },
        {
            $set: {
                status: 'expired',
                updatedAt: now,
                ownerNote: 'expired automatically'
            }
        }
    );
}

function emptyStats() {
    return {
        total: 0,
        success: 0,
        blocked: 0,
        failed: 0,
        vpn: 0,
        proxy: 0,
        tor: 0,
        hosting: 0,
        highRisk: 0,
        panelRevisionMismatch: 0,
        lastAt: null
    };
}

router.get('/internal/overview', async (req, res) => {
    if (!checkAuth(req, res)) return;

    try {
        const showAll = String(req.query.enabled || '').toLowerCase() === 'all';

        const configFilter = showAll
            ? {}
            : { 'verification.enabled': true };

        const configs = await GuildConfig.find(configFilter)
            .select('guildId guildName updatedAt verification security')
            .sort({ updatedAt: -1, _id: -1 })
            .limit(INTERNAL_OVERVIEW_GUILDS_MAX)
            .lean();

        const guildIds = configs.map(c => c.guildId);

        const stats = guildIds.length
            ? await VerifyLog.aggregate([
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
                        hosting: { $sum: { $cond: [{ $eq: ['$ipInfo.hosting', true] }, 1, 0] } },
                        highRisk: { $sum: { $cond: [{ $gte: ['$riskScore', 70] }, 1, 0] } },
                        panelRevisionMismatch: {
                            $sum: {
                                $cond: [
                                    { $eq: ['$reason', 'panel_revision_mismatch'] },
                                    1,
                                    0
                                ]
                            }
                        },
                        lastAt: { $max: '$verifiedAt' }
                    }
                }
            ])
            : [];

        const statsMap = Object.fromEntries(stats.map(s => [s._id, s]));

            const result = configs.map(c => ({
                guildId: c.guildId,
                guildName: c.guildName || 'Unknown',
                verification: c.verification || {},
                security: {
                    ...c.security,
                    sensitiveDataAccess: normalizeSensitiveAccess(c.security || {})
                },
                stats: statsMap[c.guildId] || emptyStats()
            }));

        res.json({
            success: true,
            guilds: result,
            total: result.length,
            truncated: result.length >= INTERNAL_OVERVIEW_GUILDS_MAX,
            maxGuilds: INTERNAL_OVERVIEW_GUILDS_MAX,
            showAll
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
        const filter = baseFilter(guildId);

        const [config, counts, recentLogs] = await Promise.all([
            GuildConfig.findOne({ guildId }).lean(),

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
                        tor: { $sum: { $cond: [{ $eq: ['$ipInfo.isTOR', true] }, 1, 0] } },
                        hosting: { $sum: { $cond: [{ $eq: ['$ipInfo.hosting', true] }, 1, 0] } },
                        highRisk: { $sum: { $cond: [{ $gte: ['$riskScore', 70] }, 1, 0] } },
                        panelRevisionMismatch: {
                            $sum: {
                                $cond: [
                                    { $eq: ['$reason', 'panel_revision_mismatch'] },
                                    1,
                                    0
                                ]
                            }
                        },
                        lastAt: { $max: '$verifiedAt' }
                    }
                }
            ]),

            VerifyLog.find(filter)
                .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
                .limit(10)
                .select(
                    'requestId userId roleId result reason ' +
                    'guildSnapshot.statePanelRevision guildSnapshot.latestPanelRevision ' +
                    'discordSnapshot.statePanelRevision discordSnapshot.latestPanelRevision ' +
                    'ipInfo.country ipInfo.countryCode ipInfo.city ipInfo.isp ' +
                    'ipInfo.isVPN ipInfo.isProxy ipInfo.isTOR ipInfo.hosting ' +
                    'device.browser device.os device.platform ' +
                    'riskScore verifiedAt createdAt'
                )
                .lean()
        ]);

        res.json({
            success: true,
            config: safeConfig(config),
            stats: counts[0] || emptyStats(),
            recent: recentLogs.map(safeRecentLog)
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
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit, 20, 100);

    try {
        const filter = {
            guildId,
            result: 'success',
            deletedAt: { $exists: false }
        };

        const [total, logs] = await Promise.all([
            VerifyLog.countDocuments(filter),
            VerifyLog.find(filter)
                .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
                .skip(page * limit)
                .limit(limit)
                .lean()
        ]);

        const userIds = [...new Set(logs.map(l => l.userId).filter(Boolean))];
        const userMap = await makeOAuthUserSummaryMap(userIds);

        const members = logs.map(log => {
            const user = userMap[log.userId];

            return {
                logId: String(log._id || ''),
                requestId: log.requestId || '',

                userId: log.userId,
                roleId: log.roleId || null,

                username: user?.discord?.username || log.discordSnapshot?.username || 'Unknown',
                globalName: user?.discord?.globalName || log.discordSnapshot?.globalName || null,
                tag: user?.discord?.displayTag || log.discordSnapshot?.displayTag || null,
                avatarUrl: user?.discord?.avatarUrl || log.discordSnapshot?.avatarUrl || null,

                email: user?.discord?.email || log.discordSnapshot?.email || null,
                emailVerified: user?.discord?.emailVerified === true || log.discordSnapshot?.emailVerified === true,
                accountAgeDays: user?.discord?.accountAgeDays || log.discordSnapshot?.accountAgeDays || null,

                connections: Number(user?.connectionsCount ?? log.discordSnapshot?.connectionsCount ?? 0),

                guilds: Number(user?.guildsCount ?? log.discordSnapshot?.guildsCount ?? 0),

                country: log.ipInfo?.country,
                countryCode: log.ipInfo?.countryCode,
                city: log.ipInfo?.city,
                isp: log.ipInfo?.isp,

                isVPN: !!(log.ipInfo?.isVPN || log.ipInfo?.isProxy || log.ipInfo?.isTOR),
                isProxy: !!log.ipInfo?.isProxy,
                isTOR: !!log.ipInfo?.isTOR,
                hosting: !!log.ipInfo?.hosting,

                riskScore: log.riskScore || log.ipInfo?.riskScore || 0,
                riskFlags: Array.isArray(log.riskFlags) ? log.riskFlags : [],

                browser: log.device?.browser || null,
                os: log.device?.os || null,
                platform: log.device?.platform || null,

                verifiedAt: log.verifiedAt,
                createdAt: log.createdAt || log.verifiedAt
            };
        });

        res.json({
            success: true,
            members,
            page,
            limit,
            total,
            hasMore: (page + 1) * limit < total
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.post('/internal/guild/:guildId/sensitive-access/approve', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const { guildId } = req.params;
    const { approvedBy, ownerNote, guildName, scope, expiresAt } = req.body || {};

    try {
        const config = await GuildConfig.findOneAndUpdate(
            { guildId },
            {
                $set: {
                    guildId,
                    ...(guildName ? { guildName: String(guildName).slice(0, 120) } : {}),
                    ...buildSensitiveAccessPatch({
                        enabled: true,
                        actor: approvedBy || 'owner-dashboard',
                        ownerNote,
                        scope,
                        expiresAt
                    })
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();

        res.json({
            success: true,
            guildId,
            sensitiveDataAccess: normalizeSensitiveAccess(config.security || {})
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

router.post('/internal/guild/:guildId/sensitive-access/revoke', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const { guildId } = req.params;
    const { revokedBy, ownerNote } = req.body || {};

    try {
        const config = await GuildConfig.findOneAndUpdate(
            { guildId },
            {
                $set: buildSensitiveAccessPatch({
                    enabled: false,
                    actor: revokedBy || 'owner-dashboard',
                    ownerNote
                })
            },
            { new: true }
        ).lean();

        if (!config) {
            return res.status(404).json({
                success: false,
                error: 'ไม่พบ guild config'
            });
        }

        res.json({
            success: true,
            guildId,
            sensitiveDataAccess: normalizeSensitiveAccess(config.security || {})
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
        await expireRevealRequests();

        const requests = await IPRevealRequest.find({
            status: 'pending',
            expiresAt: { $gt: Date.now() }
        })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        res.json({
            success: true,
            requests: requests.map(safeRevealRequest)
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
        const requestObjectId = parseObjectIdHex(requestId);
        if (!requestObjectId) {
            return res.status(400).json({
                success: false,
                error: 'requestId ไม่ถูกต้อง'
            });
        }

        const now = Date.now();
        const actor = String(approvedBy || 'owner').slice(0, 80) || 'owner';
        const safeNote = String(ownerNote || '').trim().slice(0, 500);
        const [requestForLookup] = await IPRevealRequest.find({ _id: requestObjectId }).limit(1).lean();

        if (!requestForLookup) {
            return res.status(404).json({
                success: false,
                error: 'ไม่พบคำขอ'
            });
        }

        if (requestForLookup.status !== 'pending' || Number(requestForLookup.expiresAt || 0) <= now) {
            await IPRevealRequest.updateOne(
                {
                    _id: { $eq: requestObjectId },
                    status: 'pending',
                    expiresAt: { $lte: now }
                },
                {
                    $set: {
                        status: 'expired',
                        updatedAt: now,
                        ownerNote: 'expired automatically'
                    }
                }
            );
            return res.status(409).json({
                success: false,
                error: 'คำขอนี้หมดอายุหรือถูกดำเนินการแล้ว'
            });
        }

        const log = await VerifyLog.findOne({
            guildId: requestForLookup.guildId,
            userId: requestForLookup.targetUserId,
            ...(requestForLookup.verifyLogId ? { _id: requestForLookup.verifyLogId } : {}),
            deletedAt: { $exists: false }
        }).sort({ verifiedAt: -1, createdAt: -1, _id: -1 }).lean();

        if (!log?.ipInfo?.encryptedRawIp) {
            return res.status(404).json({
                success: false,
                error: 'ไม่พบ IP ที่เข้ารหัสไว้'
            });
        }

        const rawIp = decryptIP(log.ipInfo.encryptedRawIp);
        const verifyLogId = String(requestForLookup.verifyLogId || log._id || '');
        const accessEntry = {
            action: 'approve_view_raw_ip',
            actor,
            viewedBy: actor,
            viewedAt: now,
            guildId: requestForLookup.guildId,
            targetUserId: requestForLookup.targetUserId,
            verifyLogId,
            reason: requestForLookup.reason || '',
            ownerNote: safeNote
        };

        const request = await IPRevealRequest.findOneAndUpdate(
            {
                _id: { $eq: requestObjectId },
                status: 'pending',
                expiresAt: { $gt: now }
            },
            {
                $set: {
                    status: 'approved',
                    approvedBy: actor,
                    approvedAt: now,
                    viewedBy: actor,
                    viewedAt: now,
                    ownerNote: safeNote,
                    updatedAt: now
                },
                $inc: {
                    viewCount: 1
                },
                $push: {
                    accessLog: {
                        $each: [accessEntry],
                        $slice: -25
                    }
                }
            },
            { new: true }
        ).lean();

        if (!request) {
            await IPRevealRequest.updateOne(
                {
                    _id: { $eq: requestObjectId },
                    status: 'pending',
                    expiresAt: { $lte: Date.now() }
                },
                {
                    $set: {
                        status: 'expired',
                        updatedAt: Date.now(),
                        ownerNote: 'expired automatically'
                    }
                }
            );
            return res.status(409).json({
                success: false,
                error: 'คำขอนี้หมดอายุหรือถูกดำเนินการแล้ว'
            });
        }

        res.json({
            success: true,
            requestId: String(request._id || requestId),
            guildId: request.guildId,
            targetUserId: request.targetUserId,
            verifyLogId,
            approvedBy: request.approvedBy,
            approvedAt: request.approvedAt,
            viewedBy: request.viewedBy,
            viewedAt: request.viewedAt,
            rawIp,
            ipInfo: {
                country: log.ipInfo.country,
                countryCode: log.ipInfo.countryCode,
                city: log.ipInfo.city,
                isp: log.ipInfo.isp,
                isVPN: log.ipInfo.isVPN,
                isProxy: log.ipInfo.isProxy,
                isTOR: log.ipInfo.isTOR,
                hosting: log.ipInfo.hosting
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
        const requestObjectId = parseObjectIdHex(requestId);
        if (!requestObjectId) {
            return res.status(400).json({
                success: false,
                error: 'requestId ไม่ถูกต้อง'
            });
        }

        const now = Date.now();
        const request = await IPRevealRequest.findOneAndUpdate(
            {
                _id: { $eq: requestObjectId },
                status: 'pending',
                expiresAt: { $gt: now }
            },
            {
                $set: {
                    status: 'rejected',
                    rejectedBy: String(rejectedBy || 'owner').slice(0, 80) || 'owner',
                    rejectedAt: now,
                    ownerNote: String(ownerNote || '').trim().slice(0, 500),
                    updatedAt: now
                }
            },
            { new: true }
        );

        if (!request) {
            const exists = await IPRevealRequest.exists({ _id: { $eq: requestObjectId } });
            if (!exists) {
                return res.status(404).json({
                    success: false,
                    error: 'ไม่พบคำขอ'
                });
            }

            await IPRevealRequest.updateOne(
                {
                    _id: { $eq: requestObjectId },
                    status: 'pending',
                    expiresAt: { $lte: now }
                },
                {
                    $set: {
                        status: 'expired',
                        updatedAt: now,
                        ownerNote: 'expired automatically'
                    }
                }
            );
            return res.status(409).json({
                success: false,
                error: 'คำขอนี้หมดอายุหรือถูกดำเนินการแล้ว'
            });
        }

        res.json({
            success: true,
            request: safeRevealRequest(request)
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

module.exports = router;
