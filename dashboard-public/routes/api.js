/*
 * Internal API — ให้ Service 1 (main bot) เรียกดูข้อมูลจาก Service 2
 * ป้องกันด้วย x-internal-secret header (ใช้ค่าเดียวกับ API_SECRET)
 */
const router      = require('express').Router();
const crypto      = require('crypto');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog   = require('../models/VerifyLog');
const OAuthUser   = require('../models/OAuthUser');

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || process.env.API_SECRET;

function checkAuth(req, res) {
    const auth = req.headers['x-internal-secret'] || '';
    try {
        const a = Buffer.from(auth,            'utf8');
        const b = Buffer.from(INTERNAL_SECRET, 'utf8');
        if (a.length !== b.length) { res.status(401).json({ error: 'Unauthorized' }); return false; }
        if (!crypto.timingSafeEqual(a, b))    { res.status(401).json({ error: 'Unauthorized' }); return false; }
    } catch { res.status(401).json({ error: 'Unauthorized' }); return false; }
    return true;
}

// ── GET /internal/overview ──
// สรุปภาพรวมทุก guild ที่ใช้ระบบ
router.get('/internal/overview', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
        const configs = await GuildConfig.find({ 'verification.enabled': true }).select('guildId guildName updatedAt');
        const guildIds = configs.map(c => c.guildId);

        const stats = await VerifyLog.aggregate([
            { $match: { guildId: { $in: guildIds } } },
            { $group: {
                _id:     '$guildId',
                total:   { $sum: 1 },
                success: { $sum: { $cond: [{ $eq: ['$result','success'] }, 1, 0] } },
                blocked: { $sum: { $cond: [{ $eq: ['$result','blocked'] }, 1, 0] } },
                failed:  { $sum: { $cond: [{ $eq: ['$result','failed'] }, 1, 0] } },
                lastAt:  { $max: '$verifiedAt' }
            }}
        ]);

        const statsMap = Object.fromEntries(stats.map(s => [s._id, s]));

        const result = configs.map(c => ({
            guildId:   c.guildId,
            guildName: c.guildName || 'Unknown',
            stats:     statsMap[c.guildId] || { total:0, success:0, blocked:0, failed:0 }
        }));

        res.json({ success: true, guilds: result, total: result.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GET /internal/guild/:guildId/stats ──
router.get('/internal/guild/:guildId/stats', async (req, res) => {
    if (!checkAuth(req, res)) return;
    const { guildId } = req.params;
    try {
        const [config, counts, recentLogs] = await Promise.all([
            GuildConfig.findOne({ guildId }),
            VerifyLog.aggregate([
                { $match: { guildId } },
                { $group: {
                    _id:     null,
                    total:   { $sum: 1 },
                    success: { $sum: { $cond: [{ $eq: ['$result','success'] }, 1, 0] } },
                    blocked: { $sum: { $cond: [{ $eq: ['$result','blocked'] }, 1, 0] } },
                    failed:  { $sum: { $cond: [{ $eq: ['$result','failed'] }, 1, 0] } }
                }}
            ]),
            VerifyLog.find({ guildId }).sort({ verifiedAt: -1 }).limit(10)
                .select('userId result reason ipInfo.country ipInfo.isVPN verifiedAt')
        ]);

        res.json({
            success: true,
            config:  config?.verification || null,
            stats:   counts[0] || { total:0, success:0, blocked:0, failed:0 },
            recent:  recentLogs
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GET /internal/guild/:guildId/members ──
router.get('/internal/guild/:guildId/members', async (req, res) => {
    if (!checkAuth(req, res)) return;
    const { guildId } = req.params;
    const page  = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    try {
        const logs = await VerifyLog.find({ guildId, result: 'success' })
            .sort({ verifiedAt: -1 }).skip(page * limit).limit(limit);

        const userIds = logs.map(l => l.userId);
        const users   = await OAuthUser.find({ 'discord.userId': { $in: userIds } })
            .select('discord.userId discord.username discord.globalName discord.avatarHash connections');
        const uMap = Object.fromEntries(users.map(u => [u.discord.userId, u]));

        const members = logs.map(l => {
            const u = uMap[l.userId]?.discord || {};
            return {
                userId:      l.userId,
                username:    u.username    || 'Unknown',
                globalName:  u.globalName  || null,
                avatarHash:  u.avatarHash  || null,
                country:     l.ipInfo?.country,
                isVPN:       l.ipInfo?.isVPN,
                connections: uMap[l.userId]?.connections?.length || 0,
                verifiedAt:  l.verifiedAt
            };
        });

        res.json({ success: true, members, page, limit });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
