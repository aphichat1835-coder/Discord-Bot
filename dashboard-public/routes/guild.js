const router      = require('express').Router();
const GuildConfig = require('../models/GuildConfig');
const VerifyLog   = require('../models/VerifyLog');
const OAuthUser   = require('../models/OAuthUser');

function requireAdmin(req, res, next) {
    if (!req.session?.adminUser) return res.status(401).json({ success: false, error: 'กรุณา Login ก่อน' });
    next();
}

function requireGuildAdmin(req, res, next) {
    const guildId = req.params.guildId || req.body?.guildId;
    const user    = req.session.adminUser;
    if (!user?.adminGuilds?.some(g => g.id === guildId)) {
        return res.status(403).json({ success: false, error: 'ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้' });
    }
    next();
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim().toUpperCase()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
    return [];
}

function sanitizeVerification(input = {}) {
    const out = {};
    if ('enabled' in input) out.enabled = !!input.enabled;
    if ('blockVPN' in input) out.blockVPN = !!input.blockVPN;
    if ('requireEmail' in input) out.requireEmail = !!input.requireEmail;
    if ('requireEmailVerified' in input) out.requireEmailVerified = !!input.requireEmailVerified;
    if ('requireConnections' in input) out.requireConnections = !!input.requireConnections;
    if ('minAccountAgeDays' in input) out.minAccountAgeDays = Math.max(0, Math.min(3650, parseInt(input.minAccountAgeDays) || 0));
    if ('minConnections' in input) out.minConnections = Math.max(1, Math.min(20, parseInt(input.minConnections) || 1));
    if ('roleId' in input) out.roleId = input.roleId ? String(input.roleId).trim() : null;
    if ('channelId' in input) out.channelId = input.channelId ? String(input.channelId).trim() : null;
    if ('messageId' in input) out.messageId = input.messageId ? String(input.messageId).trim() : null;
    if ('allowedCountries' in input) out.allowedCountries = normalizeStringArray(input.allowedCountries);
    if ('blockedCountries' in input) out.blockedCountries = normalizeStringArray(input.blockedCountries);
    out.updatedAt = Date.now();
    return out;
}

router.get('/api/guilds', requireAdmin, (req, res) => {
    res.json({ success: true, guilds: req.session.adminUser.adminGuilds });
});

router.get('/api/guild/:guildId', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    try {
        const config = await GuildConfig.findOne({ guildId }) || {};
        res.json({ success: true, config });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/api/guild/:guildId/settings', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { verification } = req.body || {};
    try {
        const set = { setupBy: req.session.adminUser.userId, updatedAt: Date.now() };
        const v = sanitizeVerification(verification || {});
        for (const [k, val] of Object.entries(v)) set[`verification.${k}`] = val;

        await GuildConfig.findOneAndUpdate(
            { guildId },
            { $set: set, $setOnInsert: { guildId, createdAt: Date.now() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/guild/:guildId/logs', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page  = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    try {
        const [logs, total] = await Promise.all([
            VerifyLog.find({ guildId, deletedAt: { $exists: false } }).sort({ verifiedAt: -1 }).skip(page * limit).limit(limit),
            VerifyLog.countDocuments({ guildId, deletedAt: { $exists: false } })
        ]);
        res.json({ success: true, logs, total, page, limit });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/guild/:guildId/stats', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    try {
        const [total, success, blocked, failed] = await Promise.all([
            VerifyLog.countDocuments({ guildId, deletedAt: { $exists: false } }),
            VerifyLog.countDocuments({ guildId, result: 'success', deletedAt: { $exists: false } }),
            VerifyLog.countDocuments({ guildId, result: 'blocked', deletedAt: { $exists: false } }),
            VerifyLog.countDocuments({ guildId, result: 'failed', deletedAt: { $exists: false } })
        ]);
        res.json({ success: true, stats: { total, success, blocked, failed } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/guild/:guildId/members', requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const page  = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    try {
        const logs = await VerifyLog.find({ guildId, result: 'success', deletedAt: { $exists: false } })
            .sort({ verifiedAt: -1 }).skip(page * limit).limit(limit)
            .select('userId verifiedAt ipInfo.country ipInfo.city ipInfo.isVPN ipInfo.isProxy ipInfo.isTOR riskScore device.deviceType');
        const userIds = logs.map(l => l.userId);
        const users   = await OAuthUser.find({ 'discord.userId': { $in: userIds } }).select('discord connections');
        const userMap = Object.fromEntries(users.map(u => [u.discord.userId, u]));
        const members = logs.map(l => {
            const u = userMap[l.userId] || {};
            return {
                userId: l.userId,
                username: u.discord?.username || 'Unknown',
                globalName: u.discord?.globalName || null,
                avatar: u.discord?.avatarHash,
                connections: u.connections?.length || 0,
                country: l.ipInfo?.country,
                city: l.ipInfo?.city,
                isVPN: l.ipInfo?.isVPN || l.ipInfo?.isProxy || l.ipInfo?.isTOR,
                riskScore: l.riskScore || 0,
                deviceType: l.device?.deviceType || 'unknown',
                verifiedAt: l.verifiedAt
            };
        });
        res.json({ success: true, members, page, limit });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
