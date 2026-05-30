const router   = require('express').Router();
const path     = require('path');
const crypto   = require('crypto');
const discord  = require('../utils/discordAPI');
const { processIP } = require('../utils/ipUtils');
const OAuthUser  = require('../models/OAuthUser');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog  = require('../models/VerifyLog');

const BASE_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const ADMIN_REDIRECT_URI = `${BASE_URL}/auth/admin-callback`;

// ── Decode state token ที่บอทสร้างไว้ (guildId:roleId:userId:ts) ──
function decodeVerifyState(token) {
    try {
        const str  = Buffer.from(token, 'base64url').toString();
        const [guildId, roleId, userId, ts] = str.split(':');
        if (!guildId || !roleId || !userId) return null;
        if (Date.now() - parseInt(ts) > 5 * 60 * 1000) return null; // หมดอายุ 5 นาที
        return { guildId, roleId, userId };
    } catch { return null; }
}

function getAccountAge(userId) {
    const ms = Number((BigInt(userId) >> BigInt(22)) + BigInt(1420070400000));
    return Math.floor((Date.now() - ms) / 86400000);
}

function extractDevice(req) {
    const ua = req.headers['user-agent'] || '';
    let platform = 'Unknown';
    if (/Android/i.test(ua))       platform = 'Android';
    else if (/iPhone|iPad/i.test(ua)) platform = 'iOS';
    else if (/Windows/i.test(ua))  platform = 'Windows';
    else if (/Mac OS X/i.test(ua)) platform = 'macOS';
    else if (/Linux/i.test(ua))    platform = 'Linux';
    return {
        userAgent: ua.substring(0, 300),
        language:  req.headers['accept-language']?.split(',')[0] || 'unknown',
        timezone:  req.body?.timezone || 'unknown',
        platform
    };
}

// ════════════════════════════════════════════════════════════
//  1.  /oauth/verify?t=TOKEN  — ผู้ใช้คลิกลิงก์จากดิส
//      สร้าง OAuth URL แล้ว redirect ไป Discord
// ════════════════════════════════════════════════════════════
router.get('/verify', (req, res) => {
    const { t } = req.query;
    if (!t) return res.status(400).send('Invalid link');

    const stateData = decodeVerifyState(t);
    if (!stateData) return res.redirect('/verify-result?status=expired');

    const state  = Buffer.from(JSON.stringify({ ...stateData, type: 'verify', ts: Date.now() })).toString('base64url');
    const params = new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        redirect_uri:  REDIRECT_URI,
        response_type: 'code',
        scope:         'identify guilds guilds.members.read connections',
        state,
        prompt:        'none'
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ════════════════════════════════════════════════════════════
//  2.  GET /auth/callback  — Discord redirect กลับมา
//      serve callback.html (JS จะ POST ต่อ)
// ════════════════════════════════════════════════════════════
router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/callback.html'));
});

// ════════════════════════════════════════════════════════════
//  3.  POST /auth/callback  — callback.html ส่ง code+state มา
// ════════════════════════════════════════════════════════════
router.post('/auth/callback', async (req, res) => {
    const { code, state } = req.body || {};

    if (!code) {
        return res.json({ success: false, error: 'ยกเลิกการยืนยันตัวตน หรือลิงก์หมดอายุ' });
    }

    try {
        // --- Parse state ---
        let stateObj = {};
        try { stateObj = JSON.parse(Buffer.from(state || '', 'base64url').toString()); } catch {}

        // --- Exchange code ---
        const tokenData   = await discord.exchangeCode(code, REDIRECT_URI);
        const accessToken = tokenData.access_token;

        // --- Fetch user data ---
        const [profile, connections, guilds] = await Promise.all([
            discord.getUserProfile(accessToken),
            discord.getUserConnections(accessToken),
            discord.getUserGuilds(accessToken)
        ]);

        // --- IP ---
        const ipInfo = await processIP(req);
        const device = extractDevice(req);

        // --- ถ้าเป็น verify flow ตรวจสอบเพิ่ม ---
        if (stateObj.type === 'verify' && stateObj.guildId) {
            const { guildId, roleId } = stateObj;
            const config = await GuildConfig.findOne({ guildId });
            const v      = config?.verification || {};

            const inGuild = guilds.some(g => g.id === guildId);
            if (!inGuild) {
                await VerifyLog.create({ guildId, userId: profile.id, result: 'failed', reason: 'ไม่ได้อยู่ในเซิร์ฟเวอร์', ipInfo, device });
                return res.json({ success: false, error: 'คุณไม่ได้อยู่ในเซิร์ฟเวอร์นี้' });
            }

            const ageDays = getAccountAge(profile.id);
            const minAge  = v.minAccountAgeDays ?? 7;
            if (ageDays < minAge) {
                await VerifyLog.create({ guildId, userId: profile.id, result: 'blocked', reason: `บัญชีอายุน้อยเกินไป (${ageDays}วัน)`, ipInfo, device });
                return res.json({ success: false, error: `บัญชีอายุน้อยเกินไป (${ageDays} วัน ต้องการ ${minAge} วัน)` });
            }

            if (v.blockVPN !== false && (ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTOR)) {
                await VerifyLog.create({ guildId, userId: profile.id, result: 'blocked', reason: 'ตรวจพบ VPN/Proxy', ipInfo, device });
                return res.json({ success: false, error: 'ตรวจพบการใช้ VPN หรือ Proxy กรุณาปิดก่อน' });
            }

            // ให้ยศ
            const assigned = await discord.addRoleToMember(guildId, profile.id, roleId);

            // บันทึก log
            await VerifyLog.create({ guildId, userId: profile.id, result: 'success', reason: assigned ? 'ได้รับยศแล้ว' : 'ยืนยันสำเร็จ (ไม่พบยศ)', ipInfo, device });
        }

        // --- บันทึก / อัปเดต user ---
        await OAuthUser.findOneAndUpdate(
            { 'discord.userId': profile.id },
            {
                $set: {
                    discord: {
                        userId:        profile.id,
                        username:      profile.username,
                        globalName:    profile.global_name || profile.username,
                        avatarHash:    profile.avatar || null,
                        email:         profile.email  || null,
                        emailVerified: profile.verified || false
                    },
                    oauth:       discord.prepareTokenStorage(tokenData),
                    connections: (connections || []).map(c => ({ type: c.type, id: c.id, name: c.name, verified: c.verified })),
                    updatedAt:   Date.now()
                }
            },
            { upsert: true, new: true }
        );

        return res.json({ success: true, message: 'ยืนยันตัวตนสำเร็จ! กลับไปที่ Discord ได้เลย' });

    } catch (err) {
        console.error('[OAUTH] callback error:', err.message);
        return res.json({ success: false, error: 'เกิดข้อผิดพลาดภายใน กรุณาลองใหม่' });
    }
});

// ════════════════════════════════════════════════════════════
//  4.  /oauth/admin  — Admin เซิร์ฟ login เข้า dashboard
// ════════════════════════════════════════════════════════════
router.get('/oauth/admin', (req, res) => {
    const state  = crypto.randomBytes(16).toString('hex');
    req.session.adminState = state;

    const params = new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        redirect_uri:  ADMIN_REDIRECT_URI,
        response_type: 'code',
        scope:         'identify guilds',
        state,
        prompt:        'none'
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get('/auth/admin-callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/admin-callback.html'));
});

router.post('/auth/admin-callback', async (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.json({ success: false, error: 'ยกเลิก' });

    try {
        const tokenData   = await discord.exchangeCode(code, ADMIN_REDIRECT_URI);
        const accessToken = tokenData.access_token;
        const [profile, guilds] = await Promise.all([
            discord.getUserProfile(accessToken),
            discord.getUserGuilds(accessToken)
        ]);

        // เช็คว่ามี ADMINISTRATOR ในเซิร์ฟไหนบ้าง
        const ADMINISTRATOR = 0x8;
        const adminGuilds = guilds.filter(g =>
            g.owner || (parseInt(g.permissions) & ADMINISTRATOR) === ADMINISTRATOR
        );

        // เก็บ session
        req.session.adminUser = {
            userId:      profile.id,
            username:    profile.username,
            avatar:      profile.avatar,
            adminGuilds: adminGuilds.map(g => ({ id: g.id, name: g.name, icon: g.icon }))
        };

        return res.json({ success: true, redirect: '/guilds' });
    } catch (err) {
        console.error('[OAUTH] admin callback error:', err.message);
        return res.json({ success: false, error: 'เกิดข้อผิดพลาด' });
    }
});

module.exports = router;
