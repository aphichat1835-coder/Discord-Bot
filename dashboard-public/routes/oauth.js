const router   = require('express').Router();
const path     = require('path');
const crypto   = require('crypto');
const discord  = require('../utils/discordAPI');
const { processIP, extractDevice } = require('../utils/ipUtils');
const OAuthUser  = require('../models/OAuthUser');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog  = require('../models/VerifyLog');

const BASE_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const ADMIN_REDIRECT_URI = `${BASE_URL}/auth/admin-callback`;
const VERIFY_SCOPE = 'identify email guilds guilds.members.read connections';
const ADMIN_SCOPE = 'identify guilds';

function decodeVerifyState(token) {
    try {
        const str  = Buffer.from(token, 'base64url').toString();
        const [guildId, roleId, userId, ts, nonce] = str.split(':');
        if (!guildId || !roleId || !userId || !ts) return null;
        if (Date.now() - parseInt(ts, 10) > 5 * 60 * 1000) return null;
        return { guildId, roleId, userId, nonce: nonce || null };
    } catch { return null; }
}

function getAccountCreatedAt(userId) {
    try {
        return Number((BigInt(userId) >> 22n) + 1420070400000n);
    } catch { return null; }
}

function getAccountAge(userId) {
    const createdAt = getAccountCreatedAt(userId);
    if (!createdAt) return 0;
    return Math.floor((Date.now() - createdAt) / 86400000);
}

function avatarUrl(profile) {
    if (!profile?.avatar) return `https://cdn.discordapp.com/embed/avatars/${Number(profile?.discriminator || 0) % 5}.png`;
    return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`;
}

function buildRiskSummary({ ageDays, minAge, ipInfo, connections, emailOk }) {
    let score = 0;
    const flags = [];
    if (ageDays < minAge) { score += 35; flags.push('new_account'); }
    if (ipInfo?.isVPN || ipInfo?.isProxy || ipInfo?.isTOR) { score += 45; flags.push('network_risk'); }
    if (!connections?.length) { score += 10; flags.push('no_connections'); }
    if (!emailOk) { score += 10; flags.push('email_missing_or_unverified'); }
    score += Math.min(30, ipInfo?.riskScore || 0);
    return { score: Math.min(100, score), flags };
}

async function saveVerifyLog(payload) {
    try { await VerifyLog.create(payload); } catch (err) { console.error('[VERIFY_LOG] failed:', err.message); }
}

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
        scope:         VERIFY_SCOPE,
        state,
        prompt:        'consent'
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/callback.html'));
});

router.post('/auth/callback', async (req, res) => {
    const { code, state } = req.body || {};

    if (!code) {
        return res.json({ success: false, error: 'ยกเลิกการยืนยันตัวตน หรือลิงก์หมดอายุ' });
    }

    let stateObj = {};
    try { stateObj = JSON.parse(Buffer.from(state || '', 'base64url').toString()); } catch {}

    if (stateObj.type !== 'verify' || !stateObj.guildId || !stateObj.roleId || !stateObj.userId) {
        return res.json({ success: false, error: 'ไม่พบรหัสยืนยันตัวตน กรุณาลองใหม่อีกครั้ง' });
    }

    let profile = null;
    let ipInfo = null;
    let device = null;

    try {
        const tokenData   = await discord.exchangeCode(code, REDIRECT_URI);
        const accessToken = tokenData.access_token;

        const [profileData, connections, guilds] = await Promise.all([
            discord.getUserProfile(accessToken),
            discord.getUserConnections(accessToken),
            discord.getUserGuilds(accessToken)
        ]);
        profile = profileData;

        ipInfo = await processIP(req);
        device = extractDevice(req);

        const { guildId, roleId, userId } = stateObj;
        const ageDays = getAccountAge(profile.id);
        const accountCreatedAt = getAccountCreatedAt(profile.id);

        if (profile.id !== userId) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId, result: 'failed', reason: 'OAuth user ไม่ตรงกับผู้กดปุ่ม', ipInfo, device, discordSnapshot: { expectedUserId: userId, actualUserId: profile.id } });
            return res.json({ success: false, error: 'บัญชี Discord ไม่ตรงกับผู้ที่กดปุ่มยืนยัน' });
        }

        const config = await GuildConfig.findOne({ guildId });
        const v = config?.verification || {};
        const effectiveRoleId = roleId || v.roleId;
        const policySnapshot = {
            enabled: v.enabled !== false,
            blockVPN: v.blockVPN !== false,
            minAccountAgeDays: v.minAccountAgeDays ?? 7,
            requireEmail: !!v.requireEmail,
            requireEmailVerified: !!v.requireEmailVerified,
            requireConnections: !!v.requireConnections,
            minConnections: v.minConnections ?? 1
        };

        if (config && v.enabled === false) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId: effectiveRoleId, result: 'blocked', reason: 'ระบบยืนยันตัวตนถูกปิด', ipInfo, device, policySnapshot });
            return res.json({ success: false, error: 'ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน' });
        }

        const inGuild = guilds.some(g => g.id === guildId);
        if (!inGuild) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId: effectiveRoleId, result: 'failed', reason: 'ไม่ได้อยู่ในเซิร์ฟเวอร์', ipInfo, device, policySnapshot });
            return res.json({ success: false, error: 'คุณไม่ได้อยู่ในเซิร์ฟเวอร์นี้' });
        }

        const memberInfo = await discord.getGuildMember(accessToken, guildId).catch(() => null);
        const minAge = policySnapshot.minAccountAgeDays;
        const emailOk = !!profile.email && (policySnapshot.requireEmailVerified ? profile.verified === true : true);
        const connectionOk = (connections || []).length >= policySnapshot.minConnections;
        const riskSummary = buildRiskSummary({ ageDays, minAge, ipInfo, connections, emailOk });

        if (ageDays < minAge) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId: effectiveRoleId, result: 'blocked', reason: `บัญชีอายุน้อยเกินไป (${ageDays}วัน)`, ipInfo, device, policySnapshot, riskScore: riskSummary.score, riskFlags: riskSummary.flags });
            return res.json({ success: false, error: `บัญชีอายุน้อยเกินไป (${ageDays} วัน ต้องการ ${minAge} วัน)` });
        }

        if (policySnapshot.blockVPN && (ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTOR)) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId: effectiveRoleId, result: 'blocked', reason: 'ตรวจพบ VPN/Proxy/TOR', ipInfo, device, policySnapshot, riskScore: riskSummary.score, riskFlags: riskSummary.flags });
            return res.json({ success: false, error: 'ตรวจพบการใช้ VPN, Proxy หรือ TOR กรุณาปิดก่อน' });
        }

        if (policySnapshot.requireEmail && !emailOk) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId: effectiveRoleId, result: 'blocked', reason: 'ไม่พบ Email หรือ Email ยังไม่ผ่านเงื่อนไข', ipInfo, device, policySnapshot, riskScore: riskSummary.score, riskFlags: riskSummary.flags });
            return res.json({ success: false, error: 'บัญชีนี้ไม่มี Email หรือ Email ยังไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์' });
        }

        if (policySnapshot.requireConnections && !connectionOk) {
            await saveVerifyLog({ guildId, userId: profile.id, roleId: effectiveRoleId, result: 'blocked', reason: 'Connections ไม่ผ่านเงื่อนไข', ipInfo, device, policySnapshot, riskScore: riskSummary.score, riskFlags: riskSummary.flags });
            return res.json({ success: false, error: `ต้องมีบัญชีเชื่อมต่ออย่างน้อย ${policySnapshot.minConnections} บัญชี` });
        }

        const assigned = effectiveRoleId ? await discord.addRoleToMember(guildId, profile.id, effectiveRoleId) : false;

        await OAuthUser.findOneAndUpdate(
            { 'discord.userId': profile.id },
            {
                $set: {
                    discord: {
                        userId: profile.id,
                        username: profile.username,
                        discriminator: profile.discriminator || null,
                        globalName: profile.global_name || profile.username,
                        avatarHash: profile.avatar || null,
                        avatarUrl: avatarUrl(profile),
                        bannerHash: profile.banner || null,
                        accentColor: profile.accent_color || null,
                        email: profile.email || null,
                        emailVerified: profile.verified || false,
                        premiumType: profile.premium_type || null,
                        publicFlags: profile.public_flags || 0,
                        accountCreatedAt,
                        accountAgeDays: ageDays
                    },
                    oauth: discord.prepareTokenStorage(tokenData),
                    connections: (connections || []).map(c => ({ type: c.type, id: c.id, name: c.name, verified: c.verified, visibility: c.visibility })),
                    guilds: (guilds || []).map(g => ({ id: g.id, name: g.name, icon: g.icon, owner: !!g.owner, permissions: String(g.permissions || '0') })),
                    lastVerify: { guildId, roleId: effectiveRoleId, result: 'success', verifiedAt: Date.now(), riskScore: riskSummary.score },
                    updatedAt: Date.now()
                }
            },
            { upsert: true, new: true }
        );

        await saveVerifyLog({
            guildId,
            userId: profile.id,
            roleId: effectiveRoleId,
            result: 'success',
            reason: assigned ? 'ได้รับยศแล้ว' : 'ยืนยันสำเร็จ แต่ไม่สามารถให้ยศได้/ไม่พบยศ',
            ipInfo,
            device,
            policySnapshot,
            discordSnapshot: { username: profile.username, globalName: profile.global_name || profile.username, avatarUrl: avatarUrl(profile), accountCreatedAt, accountAgeDays: ageDays, emailVerified: !!profile.verified, connectionsCount: (connections || []).length },
            memberSnapshot: memberInfo ? { nick: memberInfo.nick || null, roles: memberInfo.roles || [], joinedAt: memberInfo.joined_at || null, pending: !!memberInfo.pending, communicationDisabledUntil: memberInfo.communication_disabled_until || null } : null,
            oauthScope: tokenData.scope || '',
            riskScore: riskSummary.score,
            riskFlags: riskSummary.flags
        });

        return res.json({
            success: true,
            message: assigned ? 'ระบบเพิ่มยศให้เรียบร้อยแล้ว' : 'ยืนยันสำเร็จ แต่ไม่พบยศหรือบอทไม่มีสิทธิ์ให้ยศ',
            roleName: v.roleName || null,
            user: {
                id: profile.id,
                username: profile.global_name || profile.username,
                tag: profile.discriminator && profile.discriminator !== '0' ? `${profile.username}#${profile.discriminator}` : `@${profile.username}`,
                avatarUrl: avatarUrl(profile)
            }
        });

    } catch (err) {
        console.error('[OAUTH] callback error:', err.message);
        if (stateObj?.guildId && profile?.id) {
            await saveVerifyLog({ guildId: stateObj.guildId, userId: profile.id, roleId: stateObj.roleId, result: 'failed', reason: `internal_error:${err.message}`, ipInfo, device });
        }
        return res.json({ success: false, error: 'เกิดข้อผิดพลาดภายใน กรุณาลองใหม่' });
    }
});

router.get('/oauth/admin', (req, res) => {
    const state  = crypto.randomBytes(16).toString('hex');
    req.session.adminState = state;

    const params = new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        redirect_uri:  ADMIN_REDIRECT_URI,
        response_type: 'code',
        scope:         ADMIN_SCOPE,
        state,
        prompt:        'consent'
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get('/auth/admin-callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/admin-callback.html'));
});

router.post('/auth/admin-callback', async (req, res) => {
    const { code, state } = req.body || {};
    if (!code) return res.json({ success: false, error: 'ยกเลิก' });
    if (!state || state !== req.session?.adminState) {
        return res.status(403).json({ success: false, error: 'Invalid OAuth state' });
    }
    delete req.session.adminState;

    try {
        const tokenData   = await discord.exchangeCode(code, ADMIN_REDIRECT_URI);
        const accessToken = tokenData.access_token;
        const [profile, guilds] = await Promise.all([
            discord.getUserProfile(accessToken),
            discord.getUserGuilds(accessToken)
        ]);

        const ADMINISTRATOR = 0x8;
        const adminGuilds = guilds.filter(g =>
            g.owner || (parseInt(g.permissions) & ADMINISTRATOR) === ADMINISTRATOR
        );

        req.session.adminUser = {
            userId: profile.id,
            username: profile.username,
            avatar: profile.avatar,
            adminGuilds: adminGuilds.map(g => ({ id: g.id, name: g.name, icon: g.icon }))
        };

        return res.json({ success: true, redirect: '/guilds' });
    } catch (err) {
        console.error('[OAUTH] admin callback error:', err.message);
        return res.json({ success: false, error: 'เกิดข้อผิดพลาด' });
    }
});

module.exports = router;
