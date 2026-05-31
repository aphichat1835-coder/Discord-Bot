const router = require('express').Router();
const path = require('path');
const crypto = require('crypto');

const discord = require('../utils/discordAPI');
const { processIP, extractDevice } = require('../utils/ipUtils');

const OAuthUser = require('../models/OAuthUser');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');

const BASE_URL = (process.env.DASHBOARD_URL || 'http://localhost:3001').replace(/\/$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const ADMIN_REDIRECT_URI = `${BASE_URL}/auth/admin-callback`;

const VERIFY_SCOPE = 'identify email guilds guilds.members.read connections';
const ADMIN_SCOPE = 'identify guilds';
const VERIFY_STATE_MAX_AGE_MS = 5 * 60 * 1000;

function getStateSecret() {
    return String(
        process.env.VERIFY_STATE_SECRET ||
        process.env.API_SECRET ||
        process.env.INTERNAL_API_SECRET ||
        process.env.SESSION_SECRET ||
        process.env.ENCRYPTION_KEY ||
        ''
    );
}

function signEncodedPayload(encodedPayload) {
    const secret = getStateSecret();
    if (!secret) {
        throw new Error('Missing VERIFY_STATE_SECRET/API_SECRET/ENCRYPTION_KEY for verify state signing');
    }

    return crypto
        .createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64url');
}

function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');

    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function encodeSignedState(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = signEncodedPayload(encoded);

    return `${encoded}.${sig}`;
}

function decodeSignedState(token, expectedType) {
    try {
        const [encoded, sig] = String(token || '').split('.');

        if (!encoded || !sig) return null;

        const expected = signEncodedPayload(encoded);

        if (!safeEqual(sig, expected)) return null;

        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

        if (expectedType && parsed.type !== expectedType) return null;
        if (!parsed.guildId || !parsed.roleId || !parsed.userId || !parsed.ts) return null;

        if (Date.now() - Number(parsed.ts) > VERIFY_STATE_MAX_AGE_MS) return null;

        return parsed;
    } catch {
        return null;
    }
}

function decodeLegacyVerifyState(token) {
    if (process.env.ALLOW_LEGACY_VERIFY_STATE !== 'true') return null;

    try {
        const str = Buffer.from(String(token || ''), 'base64url').toString('utf8');
        const [guildId, roleId, userId, ts, nonce] = str.split(':');

        if (!guildId || !roleId || !userId || !ts) return null;

        const createdAt = Number(ts);

        if (!Number.isFinite(createdAt)) return null;
        if (Date.now() - createdAt > VERIFY_STATE_MAX_AGE_MS) return null;

        return {
            type: 'verify',
            guildId,
            roleId,
            userId,
            ts: createdAt,
            nonce: nonce || null,
            legacy: true
        };
    } catch {
        return null;
    }
}

function decodeVerifyState(token) {
    return decodeSignedState(token, 'verify') || decodeLegacyVerifyState(token);
}

function encodeCallbackState(data) {
    return encodeSignedState({
        v: 2,
        type: 'verify-callback',
        guildId: data.guildId,
        roleId: data.roleId,
        userId: data.userId,
        ts: data.ts || Date.now(),
        nonce: data.nonce || crypto.randomBytes(16).toString('hex')
    });
}

function decodeCallbackState(state) {
    return decodeSignedState(state, 'verify-callback');
}

function getAccountCreatedAt(userId) {
    try {
        return Number((BigInt(userId) >> 22n) + 1420070400000n);
    } catch {
        return null;
    }
}

function getAccountAgeDays(userId) {
    const createdAt = getAccountCreatedAt(userId);

    if (!createdAt) return 0;

    return Math.floor((Date.now() - createdAt) / 86400000);
}

function getAvatarUrl(profile) {
    if (!profile?.avatar) {
        const fallback = Number(profile?.discriminator || 0) % 5;
        return `https://cdn.discordapp.com/embed/avatars/${fallback}.png`;
    }

    return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`;
}

function normalizeCountryList(value) {
    if (!Array.isArray(value)) return [];

    return value
        .map(v => String(v).trim().toUpperCase())
        .filter(Boolean);
}

function buildPolicySnapshot(v = {}) {
    return {
        enabled: v.enabled !== false,
        blockVPN: v.blockVPN !== false,
        minAccountAgeDays: Number.isFinite(Number(v.minAccountAgeDays)) ? Number(v.minAccountAgeDays) : 7,
        requireEmail: !!v.requireEmail,
        requireEmailVerified: !!v.requireEmailVerified,
        requireConnections: !!v.requireConnections,
        minConnections: Number.isFinite(Number(v.minConnections)) ? Number(v.minConnections) : 1,
        allowedCountries: normalizeCountryList(v.allowedCountries),
        blockedCountries: normalizeCountryList(v.blockedCountries)
    };
}

function buildRiskSummary({ ageDays, policy, ipInfo, connections, emailOk }) {
    let score = 0;
    const flags = [];

    if (ageDays < policy.minAccountAgeDays) {
        score += 35;
        flags.push('new_account');
    }

    if (ipInfo?.isVPN || ipInfo?.isProxy || ipInfo?.isTOR || ipInfo?.hosting) {
        score += 45;
        flags.push('network_risk');
    }

    if (!connections?.length) {
        score += 10;
        flags.push('no_connections');
    }

    if (!emailOk) {
        score += 10;
        flags.push('email_missing_or_unverified');
    }

    const countryCode = String(ipInfo?.countryCode || '').toUpperCase();

    if (policy.allowedCountries.length && !policy.allowedCountries.includes(countryCode)) {
        score += 25;
        flags.push('country_not_allowed');
    }

    if (policy.blockedCountries.includes(countryCode)) {
        score += 25;
        flags.push('country_blocked');
    }

    score += Math.min(30, ipInfo?.riskScore || 0);

    return {
        score: Math.min(100, score),
        flags
    };
}

async function saveVerifyLog(payload) {
    try {
        await VerifyLog.create(payload);
    } catch (err) {
        console.error('[VERIFY_LOG] failed:', err.message);
    }
}

async function saveOAuthUser({ profile, tokenData, connections, guilds, guildId, roleId, riskScore }) {
    const now = Date.now();
    const accountCreatedAt = getAccountCreatedAt(profile.id);
    const accountAgeDays = getAccountAgeDays(profile.id);

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
                    avatarUrl: getAvatarUrl(profile),
                    bannerHash: profile.banner || null,
                    accentColor: profile.accent_color || null,
                    email: profile.email || null,
                    emailVerified: profile.verified || false,
                    premiumType: profile.premium_type || null,
                    flags: profile.flags || 0,
                    publicFlags: profile.public_flags || 0,
                    accountCreatedAt,
                    accountAgeDays
                },

                oauth: discord.prepareTokenStorage(tokenData),

                connections: (connections || []).map(c => ({
                    type: c.type,
                    id: c.id,
                    name: c.name,
                    verified: c.verified,
                    visibility: c.visibility
                })),

                guilds: (guilds || []).map(g => ({
                    id: g.id,
                    name: g.name,
                    icon: g.icon,
                    owner: !!g.owner,
                    permissions: String(g.permissions || '0')
                })),

                lastVerify: {
                    guildId,
                    roleId,
                    result: 'success',
                    verifiedAt: now,
                    riskScore
                },

                updatedAt: now
            },

            $setOnInsert: {
                createdAt: now
            }
        },
        {
            upsert: true,
            new: true
        }
    );
}

router.get('/verify', (req, res) => {
    const { t } = req.query;

    if (!t) {
        return res.status(400).send('Invalid verification link');
    }

    const stateData = decodeVerifyState(t);

    if (!stateData) {
        return res.redirect('/auth/callback?error=expired_or_invalid');
    }

    const state = encodeCallbackState(stateData);

    const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: VERIFY_SCOPE,
        state,
        prompt: 'consent'
    });

    return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/callback.html'));
});

router.post('/auth/callback', async (req, res) => {
    const { code, state } = req.body || {};

    if (!code) {
        return res.json({
            success: false,
            error: 'ยกเลิกการยืนยันตัวตน หรือลิงก์หมดอายุ'
        });
    }

    const stateObj = decodeCallbackState(state);

    if (!stateObj) {
        return res.json({
            success: false,
            error: 'ลิงก์ยืนยันไม่ถูกต้องหรือถูกแก้ไข กรุณากดปุ่มใหม่อีกครั้ง'
        });
    }

    let profile = null;
    let ipInfo = null;
    let device = null;

    try {
        const tokenData = await discord.exchangeCode(code, REDIRECT_URI);
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

        if (profile.id !== userId) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId,
                result: 'failed',
                reason: 'OAuth user ไม่ตรงกับผู้กดปุ่ม',
                ipInfo,
                device,
                discordSnapshot: {
                    expectedUserId: userId,
                    actualUserId: profile.id
                }
            });

            return res.json({
                success: false,
                error: 'บัญชี Discord ไม่ตรงกับผู้ที่กดปุ่มยืนยัน'
            });
        }

        const guildConfig = await GuildConfig.findOne({ guildId });
        const verificationConfig = guildConfig?.verification || {};
        const policySnapshot = buildPolicySnapshot(verificationConfig);
        const configuredRoleId = verificationConfig.roleId;

        if (!guildConfig || !configuredRoleId) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId,
                result: 'failed',
                reason: 'GuildConfig หรือ Role ID ยังไม่ถูกตั้งค่า',
                ipInfo,
                device,
                policySnapshot
            });

            return res.json({
                success: false,
                error: 'ระบบยังไม่ได้ตั้งค่า Role ID กรุณาแจ้งแอดมิน'
            });
        }

        if (String(roleId) !== String(configuredRoleId)) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId,
                result: 'failed',
                reason: 'Role ID ในลิงก์ไม่ตรงกับ GuildConfig',
                ipInfo,
                device,
                policySnapshot,
                discordSnapshot: {
                    stateRoleId: roleId,
                    configuredRoleId
                }
            });

            return res.json({
                success: false,
                error: 'ลิงก์ยืนยันไม่ตรงกับการตั้งค่าปัจจุบัน กรุณากดปุ่มใหม่อีกครั้ง'
            });
        }

        const effectiveRoleId = configuredRoleId;

        if (verificationConfig.enabled === false) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: 'ระบบยืนยันตัวตนถูกปิด',
                ipInfo,
                device,
                policySnapshot
            });

            return res.json({
                success: false,
                error: 'ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน'
            });
        }

        const inGuild = (guilds || []).some(g => g.id === guildId);

        if (!inGuild) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'failed',
                reason: 'ไม่ได้อยู่ในเซิร์ฟเวอร์',
                ipInfo,
                device,
                policySnapshot
            });

            return res.json({
                success: false,
                error: 'คุณไม่ได้อยู่ในเซิร์ฟเวอร์นี้'
            });
        }

        const memberInfo = await discord.getGuildMember(accessToken, guildId).catch(() => null);

        const accountCreatedAt = getAccountCreatedAt(profile.id);
        const accountAgeDays = getAccountAgeDays(profile.id);
        const emailOk = !!profile.email && (policySnapshot.requireEmailVerified ? profile.verified === true : true);
        const connectionCount = (connections || []).length;
        const connectionOk = connectionCount >= policySnapshot.minConnections;
        const countryCode = String(ipInfo?.countryCode || '').toUpperCase();

        const riskSummary = buildRiskSummary({
            ageDays: accountAgeDays,
            policy: policySnapshot,
            ipInfo,
            connections,
            emailOk
        });

        if (accountAgeDays < policySnapshot.minAccountAgeDays) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: `บัญชีอายุน้อยเกินไป (${accountAgeDays}วัน)`,
                ipInfo,
                device,
                policySnapshot,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            return res.json({
                success: false,
                error: `บัญชีอายุน้อยเกินไป (${accountAgeDays} วัน ต้องการ ${policySnapshot.minAccountAgeDays} วัน)`
            });
        }

        if (policySnapshot.blockVPN && (ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTOR)) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: 'ตรวจพบ VPN/Proxy/TOR',
                ipInfo,
                device,
                policySnapshot,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            return res.json({
                success: false,
                error: 'ตรวจพบการใช้ VPN, Proxy หรือ TOR กรุณาปิดก่อน'
            });
        }

        if (policySnapshot.requireEmail && !emailOk) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: 'ไม่พบ Email หรือ Email ยังไม่ผ่านเงื่อนไข',
                ipInfo,
                device,
                policySnapshot,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            return res.json({
                success: false,
                error: 'บัญชีนี้ไม่มี Email หรือ Email ยังไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
            });
        }

        if (policySnapshot.requireConnections && !connectionOk) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: 'Connections ไม่ผ่านเงื่อนไข',
                ipInfo,
                device,
                policySnapshot,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            return res.json({
                success: false,
                error: `ต้องมีบัญชีเชื่อมต่ออย่างน้อย ${policySnapshot.minConnections} บัญชี`
            });
        }

        if (policySnapshot.allowedCountries.length && !policySnapshot.allowedCountries.includes(countryCode)) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: `ประเทศไม่อยู่ใน allowedCountries (${countryCode || 'unknown'})`,
                ipInfo,
                device,
                policySnapshot,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            return res.json({
                success: false,
                error: 'ประเทศของคุณไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
            });
        }

        if (policySnapshot.blockedCountries.includes(countryCode)) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: effectiveRoleId,
                result: 'blocked',
                reason: `ประเทศอยู่ใน blockedCountries (${countryCode || 'unknown'})`,
                ipInfo,
                device,
                policySnapshot,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            return res.json({
                success: false,
                error: 'ประเทศของคุณถูกบล็อกโดยเซิร์ฟเวอร์นี้'
            });
        }

        const assigned = await discord.addRoleToMember(guildId, profile.id, effectiveRoleId);

        await saveOAuthUser({
            profile,
            tokenData,
            connections,
            guilds,
            guildId,
            roleId: effectiveRoleId,
            riskScore: riskSummary.score
        });

        await saveVerifyLog({
            guildId,
            userId: profile.id,
            roleId: effectiveRoleId,
            result: assigned ? 'success' : 'failed',
            reason: assigned ? 'ได้รับยศแล้ว' : 'ยืนยันสำเร็จ แต่ไม่สามารถให้ยศได้',
            ipInfo,
            device,
            policySnapshot,
            discordSnapshot: {
                username: profile.username,
                globalName: profile.global_name || profile.username,
                avatarUrl: getAvatarUrl(profile),
                accountCreatedAt,
                accountAgeDays,
                emailVerified: !!profile.verified,
                connectionsCount: connectionCount
            },
            memberSnapshot: memberInfo ? {
                nick: memberInfo.nick || null,
                roles: memberInfo.roles || [],
                joinedAt: memberInfo.joined_at || null,
                pending: !!memberInfo.pending,
                communicationDisabledUntil: memberInfo.communication_disabled_until || null
            } : null,
            oauthScope: tokenData.scope || '',
            riskScore: riskSummary.score,
            riskFlags: riskSummary.flags
        });

        return res.json({
            success: assigned,
            message: assigned
                ? 'ระบบเพิ่มยศให้เรียบร้อยแล้ว'
                : 'ยืนยันสำเร็จ แต่บอทไม่มีสิทธิ์ให้ยศหรือไม่พบยศ',
            roleName: verificationConfig.roleName || null,
            user: {
                id: profile.id,
                username: profile.global_name || profile.username,
                tag: profile.discriminator && profile.discriminator !== '0'
                    ? `${profile.username}#${profile.discriminator}`
                    : `@${profile.username}`,
                avatarUrl: getAvatarUrl(profile)
            }
        });

    } catch (err) {
        console.error('[OAUTH] callback error:', err.message);

        if (stateObj?.guildId && profile?.id) {
            await saveVerifyLog({
                guildId: stateObj.guildId,
                userId: profile.id,
                roleId: stateObj.roleId,
                result: 'failed',
                reason: `internal_error:${err.message}`,
                ipInfo,
                device
            });
        }

        return res.json({
            success: false,
            error: 'เกิดข้อผิดพลาดภายใน กรุณาลองใหม่'
        });
    }
});

router.get('/oauth/admin', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.adminState = state;

    const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: ADMIN_REDIRECT_URI,
        response_type: 'code',
        scope: ADMIN_SCOPE,
        state,
        prompt: 'consent'
    });

    return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

router.get('/auth/admin-callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/admin-callback.html'));
});

router.post('/auth/admin-callback', async (req, res) => {
    const { code, state } = req.body || {};

    if (!code) {
        return res.json({
            success: false,
            error: 'ยกเลิก'
        });
    }

    if (!state || state !== req.session?.adminState) {
        return res.status(403).json({
            success: false,
            error: 'Invalid OAuth state'
        });
    }

    delete req.session.adminState;

    try {
        const tokenData = await discord.exchangeCode(code, ADMIN_REDIRECT_URI);
        const accessToken = tokenData.access_token;

        const [profile, guilds] = await Promise.all([
            discord.getUserProfile(accessToken),
            discord.getUserGuilds(accessToken)
        ]);

        const ADMINISTRATOR = 0x8;

        const adminGuilds = (guilds || []).filter(g => {
            const permissions = BigInt(g.permissions || '0');
            return g.owner || (permissions & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);
        });

        req.session.adminUser = {
            userId: profile.id,
            username: profile.username,
            globalName: profile.global_name || profile.username,
            avatar: profile.avatar,
            adminGuilds: adminGuilds.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.icon
            }))
        };

        return res.json({
            success: true,
            redirect: '/guilds'
        });

    } catch (err) {
        console.error('[OAUTH] admin callback error:', err.message);

        return res.json({
            success: false,
            error: 'เกิดข้อผิดพลาด'
        });
    }
});

module.exports = router;
