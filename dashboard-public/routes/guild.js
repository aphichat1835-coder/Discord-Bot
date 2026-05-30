const router      = require('express').Router();
const GuildConfig = require('../models/GuildConfig');
const VerifyLog   = require('../models/VerifyLog');
const OAuthUser   = require('../models/OAuthUser');

// ── Middleware: ต้อง login ก่อน ──
function requireAdmin(req, res, next) {
    if (!req.session?.adminUser) {
        return res.status(401).json({ success: false, error: 'กรุณา Login ก่อน' });
    }
    next();
}

// ── Middleware: ต้องเป็น admin ของ guild นั้นจริงๆ ──
function requireGuildAdmin(req, res, next) {
    const guildId = req.params.guildId || req.body?.guildId;
    const user    = req.session.adminUser;
    if (!user?.adminGuilds?.some(g => g.id === guildId)) {
        return res.status(403).json({ success: false, error: 'ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้' });
    }
    next();
}

// --- GET /api/guilds ---
router.get('/api/guilds', requireAdmin, (req, res) => {
    res.json({ success: true, guilds: req.session.adminUser.adminGuilds });
});

// --- GET /api/guild/:guildId ---
router.get('/api/guild/:guildId', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    try {
        const config = await GuildConfig.findOne({ guildId }) || {};
        res.json({ success: true, config });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- POST /api/guild/:guildId/settings ---
router.post('/api/guild/:guildId/settings', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { verification } = req.body || {};

    try {
        await GuildConfig.findOneAndUpdate(
            { guildId },
            { $set: { verification, setupBy: req.session.adminUser.userId, updatedAt: Date.now() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- GET /api/guild/:guildId/logs ---
router.get('/api/guild/:guildId/logs', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page  = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    try {
        const [logs, total] = await Promise.all([
            VerifyLog.find({ guildId }).sort({ verifiedAt: -1 }).skip(page * limit).limit(limit),
            VerifyLog.countDocuments({ guildId })
        ]);
        res.json({ success: true, logs, total, page, limit });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- GET /api/guild/:guildId/stats ---
router.get('/api/guild/:guildId/stats', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    try {
        const [total, success, blocked, failed] = await Promise.all([
            VerifyLog.countDocuments({ guildId }),
            VerifyLog.countDocuments({ guildId, result: 'success' }),
            VerifyLog.countDocuments({ guildId, result: 'blocked' }),
            VerifyLog.countDocuments({ guildId, result: 'failed' })
        ]);
        res.json({ success: true, stats: { total, success, blocked, failed } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- GET /api/guild/:guildId/members ---
router.get('/api/guild/:guildId/members', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page  = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    try {
        // ดึง userId ที่ verify สำเร็จ
        const logs = await VerifyLog.find({ guildId, result: 'success' })
            .sort({ verifiedAt: -1 }).skip(page * limit).limit(limit).select('userId verifiedAt ipInfo.country ipInfo.isVPN');

        // ดึงข้อมูล user profile
        const userIds = logs.map(l => l.userId);
        const users   = await OAuthUser.find({ 'discord.userId': { $in: userIds } }).select('discord connections');

        const userMap = Object.fromEntries(users.map(u => [u.discord.userId, u]));

        const members = logs.map(l => {
            const u = userMap[l.userId] || {};
            return {
                userId:      l.userId,
                username:    u.discord?.username || 'Unknown',
                globalName:  u.discord?.globalName || null,
                avatar:      u.discord?.avatarHash,
                connections: u.connections?.length || 0,
                country:     l.ipInfo?.country,
                isVPN:       l.ipInfo?.isVPN,
                verifiedAt:  l.verifiedAt
            };
        });

        res.json({ success: true, members });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
