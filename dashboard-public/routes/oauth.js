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

        /*
          Direct OAuth panel ใช้ state แบบ long-lived
          ไม่ reject ด้วยอายุ state เพื่อให้แผง Discord ไม่หมดอายุเอง
          ยังปลอดภัยด้วย HMAC signature + GuildConfig/role check ล่าสุดด้านล่าง
        */

        return {
            v: 3,
            type: 'verify-callback',
            guildId,
            roleId,
            expectedUserId: user === '0' ? null : user,
            ts,
            nonce,
            mode: 'compact-direct-oauth-long-lived'
        };
    } catch {
        return null;
    }
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

function getCdnExtension(hash) {
    return String(hash || '').startsWith('a_') ? 'gif' : 'png';
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

    return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${getCdnExtension(profile.avatar)}?size=128`;
}

function getBannerUrl(profile) {
    if (!profile?.banner) return null;

    return `https://cdn.discordapp.com/banners/${profile.id}/${profile.banner}.${getCdnExtension(profile.banner)}?size=512`;
}

function getGuildIconUrl(guild) {
    if (!guild?.id || !guild?.icon) return null;

    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${getCdnExtension(guild.icon)}?size=128`;
}

function getMemberAvatarUrl(userId, guildId, memberAvatar) {
    if (!userId || !guildId || !memberAvatar) return null;

    return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${memberAvatar}.${getCdnExtension(memberAvatar)}?size=128`;
}

function displayTag(profile) {
    if (!profile) return null;

    if (profile.discriminator && profile.discriminator !== '0') {
        return `${profile.username}#${profile.discriminator}`;
    }

    return `@${profile.username}`;
}

const PERMISSIONS = {
    ADMINISTRATOR: 0x8n,
    MANAGE_GUILD: 0x20n,
    BAN_MEMBERS: 0x4n,
    KICK_MEMBERS: 0x2n,
    MANAGE_CHANNELS: 0x10n,
    MANAGE_ROLES: 0x10000000n,
    MANAGE_MESSAGES: 0x2000n,
    VIEW_AUDIT_LOG: 0x80n
};

function permissionBigInt(value) {
    try {
        return BigInt(String(value || '0'));
    } catch {
        return 0n;
    }
}

function hasPerm(permissions, flag) {
    const p = permissionBigInt(permissions);
    return (p & flag) === flag;
}

function permissionFlags(permissions) {
    const p = permissionBigInt(permissions);
    const flags = [];

    for (const [name, flag] of Object.entries(PERMISSIONS)) {
        if ((p & flag) === flag) flags.push(name);
    }

    return flags;
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
    return (guilds || []).map(g => {
        const p = String(g.permissions || '0');
        const owner = !!g.owner;

        return {
            id: g.id,
            name: g.name,
            icon: g.icon,
            iconUrl: getGuildIconUrl(g),

            owner,
            permissions: p,

            isOwner: owner,
            isAdmin: owner || hasPerm(p, PERMISSIONS.ADMINISTRATOR),
            canManageGuild: owner || hasPerm(p, PERMISSIONS.ADMINISTRATOR) || hasPerm(p, PERMISSIONS.MANAGE_GUILD),
            canManageRoles: owner || hasPerm(p, PERMISSIONS.ADMINISTRATOR) || hasPerm(p, PERMISSIONS.MANAGE_ROLES),
            canBanMembers: owner || hasPerm(p, PERMISSIONS.ADMINISTRATOR) || hasPerm(p, PERMISSIONS.BAN_MEMBERS),
            permissionFlags: permissionFlags(p),

            features: g.features || [],
            approximateMemberCount: g.approximate_member_count || null,
            approximatePresenceCount: g.approximate_presence_count || null,
            raw: g
        };
    });
}

function buildDiscordSnapshot(profile, connections, memberInfo, stateObj) {
    return {
        userId: profile.id,
        username: profile.username,
        discriminator: profile.discriminator || null,
        globalName: profile.global_name || profile.username,
        displayTag: displayTag(profile),

        avatarHash: profile.avatar || null,
        avatarUrl: getAvatarUrl(profile),
        bannerHash: profile.banner || null,
        bannerUrl: getBannerUrl(profile),
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
            guildId: stateObj.guildId,
            nick: memberInfo.nick || null,
            roles: memberInfo.roles || [],
            roleCount: (memberInfo.roles || []).length,
            joinedAt: memberInfo.joined_at || null,
            pending: !!memberInfo.pending,
            avatar: memberInfo.avatar || null,
            avatarUrl: getMemberAvatarUrl(profile.id, stateObj.guildId, memberInfo.avatar),
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
                    displayTag: displayTag(profile),

                    avatarHash: profile.avatar || null,
                    avatarUrl: getAvatarUrl(profile),
                    bannerHash: profile.banner || null,
                    bannerUrl: getBannerUrl(profile),
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
                    roleCount: (memberInfo.roles || []).length,
                    joinedAt: memberInfo.joined_at || null,
                    pending: !!memberInfo.pending,
                    avatar: memberInfo.avatar || null,
                    avatarUrl: getMemberAvatarUrl(profile.id, guildId, memberInfo.avatar),
                    flags: memberInfo.flags || 0,
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

router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/callback.html'));
});

router.post('/auth/callback', async (req, res) => {
    const { code, state } = req.body || {};

    if (!code) {
        return res.json({
            success: false,
            error: 'ยกเลิกการยืนยันตัวตน หรือไม่พบรหัส OAuth'
        });
    }

    const stateObj = decodeCallbackState(state);

    if (!stateObj) {
        return res.json({
            success: false,
            error: 'ลิงก์ยืนยันไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง'
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

        const guildConfig = await GuildConfig.findOne({ guildId });
        const verificationConfig = guildConfig?.verification || {};
        const configuredRoleId = verificationConfig.roleId;
        const policySnapshot = buildPolicySnapshot(verificationConfig);

        let memberInfo = null;
        let joinResult = null;

        async function finalize({
            result,
            reason,
            userError,
            roleAssignResult = null,
            discordSnapshotExtra = {},
            sendDm = true
        }) {
            const riskSummary = buildRiskSummary({
                ageDays: getAccountAgeDays(profile.id),
                policy: policySnapshot,
                ipInfo,
                connections,
                emailOk: !!profile.email && (
                    policySnapshot.requireEmailVerified
                        ? profile.verified === true
                        : true
                )
            });

            const discordSnapshot = {
                ...buildDiscordSnapshot(profile, connections, memberInfo, stateObj),
                ...discordSnapshotExtra
            };

            await saveOAuthUser({
                profile,
                tokenData,
                connections,
                guilds,
                memberInfo,
                guildId,
                roleId: configuredRoleId || roleId,
                result,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags
            });

            await saveVerifyLog({
                guildId,
                userId: profile.id,
                roleId: configuredRoleId || roleId,
                result,
                reason,
                ipInfo,
                device,
                policySnapshot,
                discordSnapshot,
                guildSnapshot: {
                    guildId,
                    guildName: guildConfig?.guildName || null,
                    configuredRoleId,
                    stateRoleId: roleId
                },
                memberSnapshot: discordSnapshot.member,
                joinResult,
                roleAssignResult,
                oauthScope: tokenData.scope || '',
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags,
                stateMode: stateObj.mode || null
            });

            if (sendDm) {
                await discord.sendVerificationDM(profile.id, {
                    ok: result === 'success',
                    guildName: guildConfig?.guildName || guildId,
                    roleName: verificationConfig.roleName || null,
                    reason: userError || reason
                }).catch(() => null);
            }

            return res.json({
                success: result === 'success',
                error: result === 'success' ? undefined : userError,
                message: result === 'success'
                    ? 'ระบบเพิ่มยศให้เรียบร้อยแล้ว'
                    : undefined,
                roleName: verificationConfig.roleName || null,
                user: {
                    id: profile.id,
                    username: profile.global_name || profile.username,
                    tag: displayTag(profile),
                    avatarUrl: getAvatarUrl(profile)
                },
                debugCode: result === 'success' ? undefined : reason
            });
        }

        if (expectedUserId && profile.id !== expectedUserId) {
            return finalize({
                result: 'failed',
                reason: 'oauth_user_mismatch',
                userError: 'บัญชี Discord ไม่ตรงกับผู้ที่กดปุ่มยืนยัน',
                discordSnapshotExtra: {
                    expectedUserId,
                    actualUserId: profile.id
                }
            });
        }

        if (!guildConfig || !configuredRoleId) {
            return finalize({
                result: 'failed',
                reason: 'guild_config_missing_role',
                userError: 'ระบบยังไม่ได้ตั้งค่า Role ID กรุณาแจ้งแอดมิน'
            });
        }

        if (verificationConfig.enabled === false) {
            return finalize({
                result: 'blocked',
                reason: 'verification_disabled',
                userError: 'ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน'
            });
        }

        if (String(roleId) !== String(configuredRoleId)) {
            return finalize({
                result: 'failed',
                reason: 'role_mismatch_latest_config',
                userError: 'ลิงก์ยืนยันไม่ตรงกับการตั้งค่าปัจจุบัน กรุณาใช้แผงยืนยันล่าสุด',
                discordSnapshotExtra: {
                    stateRoleId: roleId,
                    configuredRoleId
                }
            });
        }

        const userGuilds = Array.isArray(guilds) ? guilds : [];
        let inGuild = userGuilds.some(g => g.id === guildId);

        if (!inGuild) {
            joinResult = await discord.addMemberToGuild(guildId, profile.id, accessToken);

            if (!joinResult.ok) {
                return finalize({
                    result: 'failed',
                    reason: `guild_join_failed:${joinResult.status}`,
                    userError: 'ระบบไม่สามารถพาคุณเข้าเซิร์ฟเวอร์ได้ กรุณาเข้าดิสก่อนแล้วลองใหม่',
                    discordSnapshotExtra: {
                        joinError: joinResult.error || null
                    }
                });
            }

            inGuild = true;
            await new Promise(resolve => setTimeout(resolve, 900));
        }

        memberInfo = await discord.getGuildMember(accessToken, guildId).catch(() => null);

        if (!memberInfo) {
            memberInfo = await discord.getGuildMemberWithBot(guildId, profile.id).catch(() => null);
        }

        const accountAgeDays = getAccountAgeDays(profile.id);
        const emailOk = !!profile.email && (
            policySnapshot.requireEmailVerified
                ? profile.verified === true
                : true
        );

        const connectionCount = (connections || []).length;
        const connectionOk = connectionCount >= policySnapshot.minConnections;
        const countryCode = String(ipInfo?.countryCode || '').toUpperCase();

        if (accountAgeDays < policySnapshot.minAccountAgeDays) {
            return finalize({
                result: 'blocked',
                reason: `new_account:${accountAgeDays}`,
                userError: `บัญชีอายุน้อยเกินไป (${accountAgeDays} วัน ต้องการ ${policySnapshot.minAccountAgeDays} วัน)`
            });
        }

        if (policySnapshot.blockVPN && (ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTOR)) {
            return finalize({
                result: 'blocked',
                reason: 'network_risk_vpn_proxy_tor',
                userError: 'ตรวจพบการใช้ VPN, Proxy หรือ TOR กรุณาปิดก่อน'
            });
        }

        if (policySnapshot.requireEmail && !emailOk) {
            return finalize({
                result: 'blocked',
                reason: 'email_requirement_failed',
                userError: 'บัญชีนี้ไม่มี Email หรือ Email ยังไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
            });
        }

        if (policySnapshot.requireConnections && !connectionOk) {
            return finalize({
                result: 'blocked',
                reason: `connections_requirement_failed:${connectionCount}`,
                userError: `ต้องมีบัญชีเชื่อมต่ออย่างน้อย ${policySnapshot.minConnections} บัญชี`
            });
        }

        if (policySnapshot.allowedCountries.length && !policySnapshot.allowedCountries.includes(countryCode)) {
            return finalize({
                result: 'blocked',
                reason: `country_not_allowed:${countryCode || 'unknown'}`,
                userError: 'ประเทศของคุณไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
            });
        }

        if (policySnapshot.blockedCountries.includes(countryCode)) {
            return finalize({
                result: 'blocked',
                reason: `country_blocked:${countryCode || 'unknown'}`,
                userError: 'ประเทศของคุณถูกบล็อกโดยเซิร์ฟเวอร์นี้'
            });
        }

        const roleAssignResult = await discord.addRoleToMember(guildId, profile.id, configuredRoleId);

        if (!roleAssignResult.ok) {
            return finalize({
                result: 'failed',
                reason: `role_assign_failed:${roleAssignResult.status}`,
                userError:
                    roleAssignResult.status === 403
                        ? 'ยืนยันผ่านแล้ว แต่บอทไม่มีสิทธิ์ให้ยศนี้ กรุณาแจ้งแอดมิน'
                        : 'ยืนยันผ่านแล้ว แต่ระบบไม่สามารถให้ยศได้ กรุณาแจ้งแอดมิน',
                roleAssignResult,
                discordSnapshotExtra: {
                    assignedRoleId: configuredRoleId,
                    assignedRoleName: verificationConfig.roleName || null,
                    roleAssignError: roleAssignResult.error || null
                }
            });
        }

        return finalize({
            result: 'success',
            reason: 'verified_and_role_assigned',
            userError: null,
            roleAssignResult,
            discordSnapshotExtra: {
                joinedByOAuth: !!joinResult?.ok,
                assignedRoleId: configuredRoleId,
                assignedRoleName: verificationConfig.roleName || null
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
            error: 'เกิดข้อผิดพลาดภายใน กรุณาลองใหม่',
            debugCode: 'internal_error'
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

        const adminGuilds = normalizeGuilds(guilds || []).filter(g => g.isOwner || g.isAdmin);

        req.session.adminUser = {
            userId: profile.id,
            username: profile.username,
            globalName: profile.global_name || profile.username,
            avatar: profile.avatar,
            adminGuilds: adminGuilds.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                iconUrl: g.iconUrl,
                isOwner: g.isOwner,
                isAdmin: g.isAdmin,
                canManageGuild: g.canManageGuild
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
