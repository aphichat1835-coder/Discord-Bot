const router = require('express').Router();
const path = require('path');
const crypto = require('crypto');

const discord = require('../utils/discordAPI');
const { processIP, extractDevice } = require('../utils/ipUtils');

const OAuthUser = require('../models/OAuthUser');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');

const BASE_URL = (
    process.env.PUBLIC_DASHBOARD_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3001'
).replace(/\/$/, '');

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const ADMIN_REDIRECT_URI = `${BASE_URL}/auth/admin-callback`;

const VERIFY_SCOPE = 'identify email connections guilds guilds.members.read guilds.join';
const ADMIN_SCOPE = 'identify guilds';
const CALLBACK_STATE_MAX_AGE_MS = 10 * 60 * 1000;

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

function requireStateSecret() {
    const secret = getStateSecret();
    if (!secret) {
        throw new Error('Missing VERIFY_STATE_SECRET/API_SECRET/INTERNAL_API_SECRET/SESSION_SECRET/ENCRYPTION_KEY');
    }
    return secret;
}

function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');

    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signEncodedPayload(encodedPayload) {
    return crypto
        .createHmac('sha256', requireStateSecret())
        .update(encodedPayload)
        .digest('base64url');
}

function signCompactStateData(data) {
    return crypto
        .createHmac('sha256', requireStateSecret())
        .update(data)
        .digest('base64url')
        .slice(0, 22);
}

function encodeSignedState(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = signEncodedPayload(encoded);

    return `${encoded}.${sig}`;
}

function decodeSignedState(token) {
    try {
        const [encoded, sig] = String(token || '').split('.');

        if (!encoded || !sig) return null;

        const expected = signEncodedPayload(encoded);

        if (!safeEqual(sig, expected)) return null;

        return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function decodeCompactCallbackState(token) {
    try {
        const parts = String(token || '').split('.');

        if (parts.length !== 7) return null;

        const [version, guildId, roleId, user, ts36, nonce, sig] = parts;

        if (
            version !== '3' ||
            !guildId ||
            !roleId ||
            !user ||
            !ts36 ||
            !nonce ||
            !sig
        ) {
            return null;
        }

        const data = `${version}|${guildId}|${roleId}|${user}|${ts36}|${nonce}`;
        const expected = signCompactStateData(data);

        if (!safeEqual(sig, expected)) return null;

        const ts = parseInt(ts36, 36);

        if (!Number.isFinite(ts)) return null;
        if (Date.now() - ts > CALLBACK_STATE_MAX_AGE_MS) return null;

        return {
            v: 3,
            type: 'verify-callback',
            guildId,
            roleId,
            expectedUserId: user === '0' ? null : user,
            ts,
            nonce,
            mode: 'compact-direct-oauth'
        };
    } catch {
        return null;
    }
}

function decodePanelState(token) {
    const parsed = decodeSignedState(token);

    if (!parsed) return null;

    if (parsed.type === 'verify-panel') {
        if (!parsed.guildId || !parsed.roleId) return null;

        return {
            type: 'verify-panel',
            guildId: parsed.guildId,
            roleId: parsed.roleId,
            expectedUserId: parsed.expectedUserId || null,
            iat: parsed.iat || null,
            nonce: parsed.nonce || null
        };
    }

    if (parsed.type === 'verify') {
        if (!parsed.guildId || !parsed.roleId || !parsed.userId) return null;

        return {
            type: 'verify-legacy',
            guildId: parsed.guildId,
            roleId: parsed.roleId,
            expectedUserId: parsed.userId,
            ts: parsed.ts || Date.now(),
            nonce: parsed.nonce || null
        };
    }

    if (parsed.type === 'verify-callback') {
        if (!parsed.guildId || !parsed.roleId) return null;

        return {
            type: 'verify-callback-legacy-panel',
            guildId: parsed.guildId,
            roleId: parsed.roleId,
            expectedUserId: parsed.expectedUserId || parsed.userId || null,
            ts: parsed.ts || Date.now(),
            nonce: parsed.nonce || null
        };
    }

    return null;
}

function encodeCallbackState(data) {
    return encodeSignedState({
        v: 3,
        type: 'verify-callback',
        guildId: data.guildId,
        roleId: data.roleId,
        expectedUserId: data.expectedUserId || null,
        ts: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex')
    });
}

function decodeCallbackState(state) {
    const compact = decodeCompactCallbackState(state);

    if (compact) return compact;

    const parsed = decodeSignedState(state);

    if (!parsed || parsed.type !== 'verify-callback') return null;
    if (!parsed.guildId || !parsed.roleId || !parsed.ts) return null;

    if (Date.now() - Number(parsed.ts) > CALLBACK_STATE_MAX_AGE_MS) {
        return null;
    }

    return {
        ...parsed,
        expectedUserId: parsed.expectedUserId || parsed.userId || null,
        mode: 'legacy-json-oauth'
    };
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
        minAccountAgeDays: Number.isFinite(Number(v.minAccountAgeDays))
            ? Number(v.minAccountAgeDays)
            : 7,
        requireEmail: !!v.requireEmail,
        requireEmailVerified: !!v.requireEmailVerified,
        requireConnections: !!v.requireConnections,
        minConnections: Number.isFinite(Number(v.minConnections))
            ? Number(v.minConnections)
            : 1,
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

function normalizeConnections(connections = []) {
    return (connections || []).map(c => ({
        type: c.type,
        id: c.id,
        name: c.name,
        verified: c.verified,
        visibility: c.visibility,
        friendSync: c.friend_sync,
        showActivity: c.show_activity,
        twoWayLink: c.two_way_link,
        revoked: c.revoked,
        integrations: c.integrations || [],
        metadata: c.metadata || {},
        raw: c
    }));
}

function normalizeGuilds(guilds = []) {
    return (guilds || []).map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        owner: !!g.owner,
        permissions: String(g.permissions || '0'),
        features: g.features || [],
        approximateMemberCount: g.approximate_member_count || null,
        approximatePresenceCount: g.approximate_presence_count || null,
        raw: g
    }));
}

function buildDiscordSnapshot(profile, connections, memberInfo, stateObj) {
    return {
        userId: profile.id,
        username: profile.username,
        discriminator: profile.discriminator || null,
        globalName: profile.global_name || profile.username,
        avatarHash: profile.avatar || null,
        avatarUrl: getAvatarUrl(profile),
        bannerHash: profile.banner || null,
        accentColor: profile.accent_color || null,
        email: profile.email || null,
        emailVerified: !!profile.verified,
        locale: profile.locale || null,
        mfaEnabled: !!profile.mfa_enabled,
        premiumType: profile.premium_type || null,
        flags: profile.flags || 0,
        publicFlags: profile.public_flags || 0,
        accountCreatedAt: getAccountCreatedAt(profile.id),
        accountAgeDays: getAccountAgeDays(profile.id),
        connectionsCount: (connections || []).length,
        callbackStateMode: stateObj?.mode || null,
        member: memberInfo ? {
            nick: memberInfo.nick || null,
            roles: memberInfo.roles || [],
            joinedAt: memberInfo.joined_at || null,
            pending: !!memberInfo.pending,
            avatar: memberInfo.avatar || null,
            flags: memberInfo.flags || 0,
            communicationDisabledUntil: memberInfo.communication_disabled_until || null,
            raw: memberInfo
        } : null,
        rawProfile: profile
    };
}

async function saveVerifyLog(payload) {
    try {
        await VerifyLog.create(payload);
    } catch (err) {
        console.error('[VERIFY_LOG] failed:', err.message);
    }
}

async function saveOAuthUser({
    profile,
    tokenData,
    connections,
    guilds,
    memberInfo,
    guildId,
    roleId,
    result,
    riskScore,
    riskFlags
}) {
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
                    locale: profile.locale || null,
                    mfaEnabled: !!profile.mfa_enabled,
                    premiumType: profile.premium_type || null,
                    flags: profile.flags || 0,
                    publicFlags: profile.public_flags || 0,
                    accountCreatedAt,
                    accountAgeDays,
                    rawProfile: profile
                },

                oauth: discord.prepareTokenStorage(tokenData),

                connections: normalizeConnections(connections),
                guilds: normalizeGuilds(guilds),

                lastMember: memberInfo ? {
                    guildId,
                    nick: memberInfo.nick || null,
                    roles: memberInfo.roles || [],
                    joinedAt: memberInfo.joined_at || null,
                    pending: !!memberInfo.pending,
                    avatar: memberInfo.avatar || null,
                    communicationDisabledUntil: memberInfo.communication_disabled_until || null,
                    raw: memberInfo
                } : null,

                lastVerify: {
                    guildId,
                    roleId,
                    result,
                    verifiedAt: now,
                    riskScore,
                    riskFlags: riskFlags || []
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

async function loadAndValidatePanel(panelState) {
    const guildConfig = await GuildConfig.findOne({ guildId: panelState.guildId });
    const verificationConfig = guildConfig?.verification || {};
    const configuredRoleId = verificationConfig.roleId;

    if (!guildConfig || !configuredRoleId) {
        return {
            ok: false,
            error: 'server_not_configured'
        };
    }

    if (verificationConfig.enabled === false) {
        return {
            ok: false,
            error: 'verification_disabled'
        };
    }

    if (String(panelState.roleId) !== String(configuredRoleId)) {
        return {
            ok: false,
            error: 'role_mismatch'
        };
    }

    return {
        ok: true,
        guildConfig,
        verificationConfig,
        roleId: configuredRoleId
    };
}

router.get('/verify', async (req, res) => {
    const { t } = req.query;

    if (!t) {
        return res.redirect('/auth/callback?error=missing_verify_token');
    }

    const panelState = decodePanelState(t);

    if (!panelState) {
        return res.redirect('/auth/callback?error=invalid_or_expired_link');
    }

    try {
        const check = await loadAndValidatePanel(panelState);

        if (!check.ok) {
            return res.redirect(`/auth/callback?error=${encodeURIComponent(check.error)}`);
        }

        const state = encodeCallbackState({
            guildId: panelState.guildId,
            roleId: check.roleId,
            expectedUserId: panelState.expectedUserId || null
        });

        const params = new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            scope: VERIFY_SCOPE,
            state,
            prompt: 'consent'
        });

        return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);

    } catch (err) {
        console.error('[OAUTH] /verify error:', err.message);
        return res.redirect('/auth/callback?error=verify_internal_error');
    }
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
            error: 'ลิงก์ยืนยันไม่ถูกต้องหรือหมดอายุ กรุณากดปุ่มใหม่อีกครั้ง'
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

        const { guildId, roleId, expectedUserId } = stateObj;

        if (expectedUserId && profile.id !== expectedUserId) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId,
                result: 'failed',
                reason: 'OAuth user ไม่ตรงกับผู้กดปุ่มเดิม',
                ipInfo,
                device,
                discordSnapshot: {
                    expectedUserId,
                    actualUserId: profile.id
                },
                stateMode: stateObj.mode || null
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
                policySnapshot,
                stateMode: stateObj.mode || null
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
                },
                stateMode: stateObj.mode || null
            });

            return res.json({
                success: false,
                error: 'ลิงก์ยืนยันไม่ตรงกับการตั้งค่าปัจจุบัน กรุณากดปุ่มใหม่อีกครั้ง'
            });
        }

        if (verificationConfig.enabled === false) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: configuredRoleId,
                result: 'blocked',
                reason: 'ระบบยืนยันตัวตนถูกปิด',
                ipInfo,
                device,
                policySnapshot,
                stateMode: stateObj.mode || null
            });

            return res.json({
                success: false,
                error: 'ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน'
            });
        }

        const userGuilds = Array.isArray(guilds) ? guilds : [];
        let inGuild = userGuilds.some(g => g.id === guildId);
        let joinResult = null;

        if (!inGuild) {
            joinResult = await discord.addMemberToGuild(guildId, profile.id, accessToken);

            if (!joinResult.ok) {
                await saveVerifyLog({
                    guildId,
                    userId: profile.id,
                    roleId: configuredRoleId,
                    result: 'failed',
                    reason: `ไม่สามารถพาเข้าเซิร์ฟเวอร์ได้: ${joinResult.status}`,
                    ipInfo,
                    device,
                    policySnapshot,
                    discordSnapshot: {
                        joinError: joinResult.error || null
                    },
                    joinResult,
                    stateMode: stateObj.mode || null
                });

                return res.json({
                    success: false,
                    error: 'ระบบไม่สามารถพาคุณเข้าเซิร์ฟเวอร์ได้ กรุณาเข้าดิสก่อนแล้วลองใหม่'
                });
            }

            inGuild = true;
            await new Promise(resolve => setTimeout(resolve, 900));
        }

        let memberInfo = await discord.getGuildMember(accessToken, guildId).catch(() => null);

        if (!memberInfo) {
            memberInfo = await discord.getGuildMemberWithBot(guildId, profile.id).catch(() => null);
        }

        const accountCreatedAt = getAccountCreatedAt(profile.id);
        const accountAgeDays = getAccountAgeDays(profile.id);
        const emailOk = !!profile.email && (
            policySnapshot.requireEmailVerified
                ? profile.verified === true
                : true
        );
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

        const discordSnapshot = buildDiscordSnapshot(profile, connections, memberInfo, stateObj);

        async function block(reason, error) {
            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: configuredRoleId,
                result: 'blocked',
                reason,
                ipInfo,
                device,
                policySnapshot,
                discordSnapshot,
                memberSnapshot: discordSnapshot.member,
                oauthScope: tokenData.scope || '',
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags,
                stateMode: stateObj.mode || null
            });

            await saveOAuthUser({
                profile,
                tokenData,
                connections,
                guilds,
                memberInfo,
                guildId,
                roleId: configuredRoleId,
                result: 'blocked',
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            await discord.sendVerificationDM(profile.id, {
                ok: false,
                guildName: guildConfig.guildName || guildId,
                reason: error
            }).catch(() => null);

            return res.json({
                success: false,
                error
            });
        }

        if (accountAgeDays < policySnapshot.minAccountAgeDays) {
            return block(
                `บัญชีอายุน้อยเกินไป (${accountAgeDays}วัน)`,
                `บัญชีอายุน้อยเกินไป (${accountAgeDays} วัน ต้องการ ${policySnapshot.minAccountAgeDays} วัน)`
            );
        }

        if (policySnapshot.blockVPN && (ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTOR)) {
            return block(
                'ตรวจพบ VPN/Proxy/TOR',
                'ตรวจพบการใช้ VPN, Proxy หรือ TOR กรุณาปิดก่อน'
            );
        }

        if (policySnapshot.requireEmail && !emailOk) {
            return block(
                'ไม่พบ Email หรือ Email ยังไม่ผ่านเงื่อนไข',
                'บัญชีนี้ไม่มี Email หรือ Email ยังไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
            );
        }

        if (policySnapshot.requireConnections && !connectionOk) {
            return block(
                'Connections ไม่ผ่านเงื่อนไข',
                `ต้องมีบัญชีเชื่อมต่ออย่างน้อย ${policySnapshot.minConnections} บัญชี`
            );
        }

        if (policySnapshot.allowedCountries.length && !policySnapshot.allowedCountries.includes(countryCode)) {
            return block(
                `ประเทศไม่อยู่ใน allowedCountries (${countryCode || 'unknown'})`,
                'ประเทศของคุณไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
            );
        }

        if (policySnapshot.blockedCountries.includes(countryCode)) {
            return block(
                `ประเทศอยู่ใน blockedCountries (${countryCode || 'unknown'})`,
                'ประเทศของคุณถูกบล็อกโดยเซิร์ฟเวอร์นี้'
            );
        }

        const assigned = await discord.addRoleToMember(guildId, profile.id, configuredRoleId);
        const result = assigned ? 'success' : 'failed';

        await saveOAuthUser({
            profile,
            tokenData,
            connections,
            guilds,
            memberInfo,
            guildId,
            roleId: configuredRoleId,
            result,
            riskScore: riskSummary.score,
            riskFlags: riskSummary.flags
        });

        await saveVerifyLog({
            guildId,
            userId: profile.id,
            roleId: configuredRoleId,
            result,
            reason: assigned
                ? 'ได้รับยศแล้ว'
                : 'ยืนยันสำเร็จ แต่ไม่สามารถให้ยศได้',
            ipInfo,
            device,
            policySnapshot,
            discordSnapshot: {
                ...discordSnapshot,
                joinedByOAuth: !!joinResult?.ok,
                assignedRoleId: configuredRoleId,
                assignedRoleName: verificationConfig.roleName || null
            },
            memberSnapshot: discordSnapshot.member,
            joinResult,
            oauthScope: tokenData.scope || '',
            riskScore: riskSummary.score,
            riskFlags: riskSummary.flags,
            stateMode: stateObj.mode || null
        });

        await discord.sendVerificationDM(profile.id, {
            ok: assigned,
            guildName: guildConfig.guildName || guildId,
            roleName: verificationConfig.roleName || null,
            reason: assigned
                ? 'ยืนยันตัวตนสำเร็จและได้รับยศแล้ว'
                : 'ยืนยันสำเร็จ แต่บอทไม่สามารถให้ยศได้'
        }).catch(() => null);

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
                device,
                stateMode: stateObj.mode || null
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
