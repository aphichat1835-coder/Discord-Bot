/* eslint-disable complexity -- OAuth flow is behavior-sensitive; refactor separately. */
const router = require('express').Router();
const path = require('path');
const crypto = require('node:crypto');

const discord = require('../utils/discordAPI');
const { processIP, extractDevice } = require('../utils/ipUtils');
const { normalizeVerificationConfig, normalizeAction, clampNumber } = require('../utils/verifyMode');
const { requireCsrf } = require('../utils/csrf');
const {
    encodeSignedState,
    decodeSignedState,
    decodeCallbackState
} = require('../utils/state');
const { normalizeGuildPermissions } = require('../utils/guildPermissions');
const { shouldStoreOAuthTokens } = require('../utils/oauthTokenLifecycle');

const OAuthUser = require('../models/OAuthUser');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const IpIdentityLink = require('../models/IpIdentityLink');

const BASE_URL = (
    process.env.PUBLIC_DASHBOARD_URL ||
    process.env.DASHBOARD_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.DASHBOARD_PUBLIC_URL ||
    'http://localhost:3001'
).replace(/\/$/, '');

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const ADMIN_REDIRECT_URI = `${BASE_URL}/auth/admin-callback`;

const VERIFY_SCOPE = 'identify email connections guilds guilds.members.read guilds.join';
const ADMIN_SCOPE = 'identify guilds';
const CALLBACK_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_CONNECTIONS_MAX = Math.max(10, Number(process.env.OAUTH_CONNECTIONS_MAX || 50) || 50);
const OAUTH_GUILDS_MAX = Math.max(20, Number(process.env.OAUTH_GUILDS_MAX || 200) || 200);
const OAUTH_MEMBER_ROLES_MAX = Math.max(20, Number(process.env.OAUTH_MEMBER_ROLES_MAX || 80) || 80);
const ADMIN_GUILDS_SESSION_MAX = Math.max(20, Number(process.env.ADMIN_GUILDS_SESSION_MAX || 200) || 200);
const IP_LINK_USERS_MAX = Math.max(20, Number(process.env.IP_LINK_USERS_MAX || 200) || 200);
const IP_LINK_DEVICE_FINGERPRINTS_MAX = Math.max(10, Number(process.env.IP_LINK_DEVICE_FINGERPRINTS_MAX || 30) || 30);
const IP_LINK_ROLE_SNAPSHOTS_MAX = Math.max(20, Number(process.env.IP_LINK_ROLE_SNAPSHOTS_MAX || 80) || 80);
const DEVICE_DUPLICATE_LOOKUP_MAX = Math.max(
    20,
    Number(process.env.DEVICE_DUPLICATE_LOOKUP_MAX || 200) || 200
);

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

function normalizeCountryList(value) {
    if (!Array.isArray(value)) return [];

    return value
        .map(v => String(v).trim().toUpperCase())
        .filter(Boolean);
}

function buildPolicySnapshot(v = {}) {
    const normalized = normalizeVerificationConfig(v || {});
    const antiAlt = normalized.antiAlt || {};

    return {
        enabled: normalized.enabled !== false,
        blockVPN: normalized.blockVPN !== false,
        blockHosting: normalized.blockHosting === true,
        minAccountAgeDays: Number.isFinite(Number(normalized.minAccountAgeDays)) ? Number(normalized.minAccountAgeDays) : 7,
        requireEmail: !!normalized.requireEmail,
        requireEmailVerified: !!normalized.requireEmailVerified,
        requireConnections: !!normalized.requireConnections,
        minConnections: Number.isFinite(Number(normalized.minConnections)) ? Number(normalized.minConnections) : 1,
        allowedCountries: normalizeCountryList(normalized.allowedCountries),
        blockedCountries: normalizeCountryList(normalized.blockedCountries),
        antiAlt: {
            enabled: antiAlt.enabled === true,
            ipDuplicateAction: normalizeAction(antiAlt.ipDuplicateAction, 'log_only'),
            maxUsersPerIp: clampNumber(antiAlt.maxUsersPerIp, 1, 20, 3),
            deviceDuplicateAction: normalizeAction(antiAlt.deviceDuplicateAction, 'log_only'),
            maxUsersPerDevice: clampNumber(antiAlt.maxUsersPerDevice, 1, 20, 2),
            previouslyBlockedIpAction: normalizeAction(antiAlt.previouslyBlockedIpAction, 'delay'),
            spoofedHeaderAction: normalizeAction(antiAlt.spoofedHeaderAction, 'delay'),
            unknownLookupAction: normalizeAction(antiAlt.unknownLookupAction, 'delay'),
            delayMs: clampNumber(antiAlt.delayMs, 0, 10000, 5000)
        }
    };
}

function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function clampDelayMs(value, fallback = 5000) {
    return clampNumber(value, 0, 10000, fallback);
}

function pushUnique(list, value) {
    if (!value) return;
    if (!list.includes(value)) list.push(value);
}

function uniqueStrings(values = []) {
    return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
}

async function applyPolicyAction({
    action,
    reason,
    userError,
    delayMs,
    riskFlags,
    riskFlag,
    finalize
}) {
    const normalizedAction = normalizeAction(action, 'log_only');

    if (normalizedAction === 'off') {
        return { blocked: false };
    }

    pushUnique(riskFlags, riskFlag || reason);

    if (normalizedAction === 'delay') {
        await sleep(clampDelayMs(delayMs));
        return { blocked: false, delayed: true };
    }

    if (normalizedAction === 'block') {
        return {
            blocked: true,
            response: await finalize({
                result: 'blocked',
                reason,
                userError
            })
        };
    }

    return { blocked: false, logged: true };
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

function safeString(value, max = 200) {
    if (value === undefined || value === null) return '';

    return String(value)
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .slice(0, max);
}

function safeNullableString(value, max = 200) {
    const v = safeString(value, max);
    return v || null;
}

function safeNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function safePlainObject(value) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.prototype.toString.call(value) !== '[object Object]'
    ) {
        return {};
    }

    try {
        const json = JSON.stringify(value);
        if (!json || Buffer.byteLength(json, 'utf8') > 10 * 1024) return {};

        const parsed = JSON.parse(json);
        return Object.prototype.toString.call(parsed) === '[object Object]' ? parsed : {};
    } catch {
        return {};
    }
}

function compactConnectionRaw(connection = {}) {
    return {
        type: safeNullableString(connection.type, 80),
        id: safeNullableString(connection.id, 160),
        name: safeNullableString(connection.name, 180),
        verified: connection.verified === true,
        visibility: safeNumberOrNull(connection.visibility),
        friend_sync: connection.friend_sync === true,
        metadata_visibility: safeNumberOrNull(connection.metadata_visibility),
        show_activity: connection.show_activity === true,
        two_way_link: connection.two_way_link === true
    };
}

function normalizeConnections(connections = []) {
    const list = Array.isArray(connections) ? connections : [];

    return list
        .slice(0, OAUTH_CONNECTIONS_MAX)
        .map(connection => {
            if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
                return null;
            }

            return {
                type: safeNullableString(connection.type, 80),
                id: safeNullableString(connection.id, 160),
                name: safeNullableString(connection.name, 180),

                verified: connection.verified === true,
                visibility: safeNumberOrNull(connection.visibility),

                friendSync: connection.friend_sync === true,
                showActivity: connection.show_activity === true,
                twoWayLink: connection.two_way_link === true,
                revoked: connection.revoked === true,

                integrations: Array.isArray(connection.integrations)
                    ? connection.integrations.slice(0, 20).map(safePlainObject)
                    : [],

                metadata: safePlainObject(connection.metadata),

                /*
                  ห้ามเก็บ raw object เต็มก้อนจาก Discord ลง DB/log
                  เพราะเวลา Mongoose error มันอาจพ่นข้อมูล connections ทั้งชุดออก log
                */
                raw: compactConnectionRaw(connection)
            };
        })
        .filter(Boolean);
}
function compactDiscordProfile(profile = {}) {
    return {
        id: safeNullableString(profile.id, 40),
        username: safeNullableString(profile.username, 120),
        discriminator: safeNullableString(profile.discriminator, 20),
        globalName: safeNullableString(profile.global_name || profile.globalName, 120),
        avatar: safeNullableString(profile.avatar, 120),
        banner: safeNullableString(profile.banner, 120),
        accentColor: safeNumberOrNull(profile.accent_color || profile.accentColor),
        locale: safeNullableString(profile.locale, 40),
        verified: profile.verified === true,
        emailVerified: profile.verified === true,
        mfaEnabled: profile.mfa_enabled === true,
        premiumType: safeNumberOrNull(profile.premium_type) || 0,
        flags: safeNumberOrNull(profile.flags) || 0,
        publicFlags: safeNumberOrNull(profile.public_flags) || 0
    };
}

function compactUserGuild(g = {}) {
    return {
        id: safeNullableString(g.id, 40) || '',
        name: safeNullableString(g.name, 120) || '',
        icon: safeNullableString(g.icon, 120),
        owner: g.owner === true,
        permissions: String(g.permissions || '0'),
        features: Array.isArray(g.features)
            ? g.features.map(feature => safeNullableString(feature, 120)).filter(Boolean).slice(0, 50)
            : []
    };
}

function compactMemberInfo(member = {}) {
    const roles = Array.isArray(member.roles)
        ? member.roles.map(String).slice(0, OAUTH_MEMBER_ROLES_MAX)
        : [];

    return {
        userId: safeNullableString(member.user?.id || member.userId, 40),
        nick: safeNullableString(member.nick, 120),
        joinedAt: safeNullableString(member.joined_at || member.joinedAt, 80),
        pending: member.pending === true,
        avatar: safeNullableString(member.avatar, 120),
        roles,
        roleCount: Array.isArray(member.roles) ? member.roles.length : 0,
        flags: safeNumberOrNull(member.flags) || 0,
        communicationDisabledUntil: safeNullableString(
            member.communication_disabled_until || member.communicationDisabledUntil,
            80
        )
    };
}

function normalizeGuilds(guilds = []) {
    return (Array.isArray(guilds) ? guilds : []).slice(0, OAUTH_GUILDS_MAX).map(g => {
        const p = String(g.permissions || '0');
        const owner = !!g.owner;
        const policy = normalizeGuildPermissions({
            ...g,
            owner,
            permissions: p
        });

        return {
            id: safeNullableString(g.id, 40),
            name: safeNullableString(g.name, 120),
            icon: safeNullableString(g.icon, 120),
            iconUrl: getGuildIconUrl(g),

            owner,
            permissions: p,

            isOwner: policy.isOwner,
            isAdmin: policy.isAdmin,
            canManageGuild: policy.canManageGuild,
            canManageRoles: policy.canManageRoles,
            canBanMembers: policy.canBanMembers,
            permissionFlags: policy.permissionFlags,

            features: Array.isArray(g.features)
                ? g.features.map(feature => safeNullableString(feature, 120)).filter(Boolean).slice(0, 50)
                : [],
            approximateMemberCount: g.approximate_member_count || null,
            approximatePresenceCount: g.approximate_presence_count || null,
            snapshot: compactUserGuild(g)
        };
    });
}

function compactAdminGuildForSession(guild = {}) {
    return {
        id: safeNullableString(guild.id, 40) || '',
        name: safeNullableString(guild.name, 120) || 'Unknown Server',
        icon: safeNullableString(guild.icon, 120),
        owner: guild.owner === true,
        isOwner: guild.isOwner === true,
        permissions: safeNullableString(guild.permissions, 40) || '0',
        isAdmin: guild.isAdmin === true,
        canManage: guild.isOwner === true || guild.isAdmin === true,
        canManageGuild: guild.canManageGuild === true,
        canManageRoles: guild.canManageRoles === true
    };
}

function buildDiscordSnapshot(profile, connections, memberInfo, stateObj, extra = {}) {
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

        connectionsCount: Array.isArray(connections) ? connections.length : 0,
        connections: normalizeConnections(connections),

        guildsCount: 0,
        callbackStateMode: stateObj?.mode || null,
        panelRevision: stateObj?.panelRevision || null,

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
            snapshot: compactMemberInfo(memberInfo)
        } : null,

        profileSnapshot: compactDiscordProfile(profile),

        ...extra
    };
}

function safeErrorField(value, max = 120) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return safeString(value, max) || null;
    if (typeof value === 'bigint') return safeString(value.toString(), max) || null;

    return safeString(Object.prototype.toString.call(value), max) || null;
}

function redactMongooseCastError(text) {
    const marker = " failed for value ";
    const markerIndex = text.indexOf(marker);
    if (!text.startsWith("Cast to ") || markerIndex < 0) return text;

    const pathIndex = text.indexOf(" at path", markerIndex + marker.length);
    if (pathIndex < 0) return text;

    return `${text.slice(0, markerIndex + marker.length)}[REDACTED]${text.slice(pathIndex)}`;
}

function redactTrailingForValue(text) {
    const marker = " for value ";
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return text;

    const valueStart = markerIndex + marker.length;
    if (text.slice(valueStart).startsWith("[REDACTED]")) return text;

    return `${text.slice(0, valueStart)}[REDACTED]`;
}

function redactSensitiveText(value, max = 280) {
    let text = safeString(value, max * 3);

    if (!text) return null;

    text = text
        .replace(/(["']?)(access_token|refresh_token|authorization|cookie|token)\1\s*:\s*(["'])[^"']*\3/gi, '$1$2$1:$3[REDACTED]$3')
        .replace(/\b(authorization)\s*[:=]\s*(?:(?:Bearer|Bot)\s+)?[\w.-]{10,}/gi, '$1=[REDACTED]')
        .replace(/(access_token|refresh_token|authorization|cookie|token)\s*[:=]\s*[^,\s}\]]+/gi, '$1=[REDACTED]')
        .replace(/\b(Bot|Bearer)\s+[A-Za-z0-9._-]{20,}\b/g, '$1 [REDACTED]');
    text = redactMongooseCastError(text);
    text = redactTrailingForValue(text);

    return safeString(text, max) || null;
}

function sanitizeSideEffectError(err) {
    const safe = {
        name: safeErrorField(err?.name) || 'Error',
        code: safeErrorField(err?.code),
        path: safeErrorField(err?.path),
        kind: safeErrorField(err?.kind),
        messagePreview: redactSensitiveText(err?.message)
    };

    if (err?.errors && typeof err.errors === 'object') {
        safe.errors = Object.entries(err.errors).slice(0, 8).map(([key, value]) => ({
            key: safeErrorField(key),
            name: safeErrorField(value?.name),
            path: safeErrorField(value?.path),
            kind: safeErrorField(value?.kind)
        }));
    }

    return safe;
}

async function safeSideEffect(label, fn, fallback = null) {
    try {
        return await fn();
    } catch (err) {
        console.error(
            `[VERIFY] ${label} failed:`,
            JSON.stringify(sanitizeSideEffectError(err))
        );

        return fallback;
    }
}

async function saveVerifyLogSafe(payload) {
    return safeSideEffect('saveVerifyLog', async () => {
        await VerifyLog.create(payload);
        return true;
    }, false);
}

async function updateIpIdentityTrackingSafe({
    guildId,
    guildName,
    profile,
    ipInfo,
    device,
    memberInfo,
    roleId,
    result,
    riskSummary
}) {
    return safeSideEffect('updateIpIdentityTracking', async () => {
        if (!guildId || !profile?.id || !ipInfo?.ipHash) return null;

        const nowMs = Date.now();

        let doc = await IpIdentityLink.findOne({
            guildId,
            ipHash: ipInfo.ipHash
        });

        if (!doc) {
            doc = new IpIdentityLink({
                guildId,
                guildName,
                ipHash: ipInfo.ipHash,
                encryptedRawIp: ipInfo.encryptedRawIp,
                firstSeenAt: nowMs,
                users: [],
                deviceFingerprints: [],
                roleSnapshots: [],
                createdAt: nowMs
            });
        }

        doc.guildName = guildName || doc.guildName || guildId;
        doc.encryptedRawIp = ipInfo.encryptedRawIp || doc.encryptedRawIp;
        doc.lastSeenAt = nowMs;
        doc.totalVerifications = (doc.totalVerifications || 0) + 1;
        doc.lastResult = result;
        doc.lastRoleId = roleId;

        doc.lastRiskScore = riskSummary?.score || ipInfo.riskScore || 0;
        doc.maxRiskScore = Math.max(doc.maxRiskScore || 0, doc.lastRiskScore || 0);
        doc.lastRiskFlags = riskSummary?.flags || [];

        doc.lastCountry = ipInfo.country;
        doc.lastCountryCode = ipInfo.countryCode;
        doc.lastRegion = ipInfo.region;
        doc.lastCity = ipInfo.city;
        doc.lastTimezone = ipInfo.timezone;
        doc.lastIsp = ipInfo.isp;
        doc.lastOrg = ipInfo.org;
        doc.lastAs = ipInfo.as;
        doc.lastAsname = ipInfo.asname;

        doc.isVPN = !!ipInfo.isVPN;
        doc.isProxy = !!ipInfo.isProxy;
        doc.isTOR = !!ipInfo.isTOR;
        doc.hosting = !!ipInfo.hosting;
        doc.mobile = !!ipInfo.mobile;

        doc.lastIpInfo = ipInfo;
        doc.lastDevice = device;

        const roles = memberInfo?.roles || [];

        let user = doc.users.find(u => u.userId === profile.id);

        if (!user) {
            user = {
                userId: profile.id,
                firstSeenAt: nowMs,
                verifyCount: 0,
                successCount: 0,
                blockedCount: 0,
                failedCount: 0
            };

            doc.users.push(user);
        }

        user.username = profile.username;
        user.globalName = profile.global_name || profile.username;
        user.displayTag = displayTag(profile);
        user.avatarUrl = getAvatarUrl(profile);
        user.lastSeenAt = nowMs;
        user.verifyCount = (user.verifyCount || 0) + 1;

        user.lastResult = result;
        user.lastRoleId = roleId;
        user.lastRoles = roles;
        user.lastJoinedAt = memberInfo?.joined_at || null;
        user.lastMemberPending = !!memberInfo?.pending;
        user.lastCommunicationDisabledUntil = memberInfo?.communication_disabled_until || null;
        user.lastDeviceFingerprintHash = device?.fingerprintHash || null;
        user.lastRiskScore = riskSummary?.score || ipInfo.riskScore || 0;
        user.lastRiskFlags = riskSummary?.flags || [];

        if (result === 'success') user.successCount = (user.successCount || 0) + 1;
        if (result === 'blocked') user.blockedCount = (user.blockedCount || 0) + 1;
        if (result === 'failed') user.failedCount = (user.failedCount || 0) + 1;

        if (device?.fingerprintHash) {
            let fp = doc.deviceFingerprints.find(d => d.fingerprintHash === device.fingerprintHash);

            if (!fp) {
                fp = {
                    fingerprintHash: device.fingerprintHash,
                    userId: profile.id,
                    firstSeenAt: nowMs,
                    count: 0
                };

                doc.deviceFingerprints.push(fp);
            }

            fp.userId = profile.id;
            fp.fingerprintVersion = Number(device.fingerprintVersion || 0) || 1;
            fp.lastSeenAt = nowMs;
            fp.count = (fp.count || 0) + 1;
            fp.browser = device.browser;
            fp.os = device.os;
            fp.platform = device.platform;
            fp.deviceType = device.deviceType;
            fp.language = device.language;
            fp.timezone = device.timezone;
            fp.screenSize = device.screenSize;

            if (doc.deviceFingerprints.length > IP_LINK_DEVICE_FINGERPRINTS_MAX) {
                doc.deviceFingerprints = doc.deviceFingerprints
                    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
                    .slice(0, IP_LINK_DEVICE_FINGERPRINTS_MAX);
            }
        }

        doc.roleSnapshots.push({
            userId: profile.id,
            roleId,
            roles,
            result,
            at: nowMs
        });
                if (doc.roleSnapshots.length > IP_LINK_ROLE_SNAPSHOTS_MAX) {
            doc.roleSnapshots = doc.roleSnapshots.slice(-IP_LINK_ROLE_SNAPSHOTS_MAX);
        }

        if (doc.users.length > IP_LINK_USERS_MAX) {
            doc.users = doc.users
                .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
                .slice(0, IP_LINK_USERS_MAX);
        }

        doc.uniqueUsers = doc.users.length;
        doc.updatedAt = nowMs;

        doc.markModified('users');
        doc.markModified('deviceFingerprints');
        doc.markModified('roleSnapshots');
        doc.markModified('lastIpInfo');
        doc.markModified('lastDevice');

        await doc.save();

        return {
            ipHash: doc.ipHash,
            firstSeenAt: doc.firstSeenAt,
            lastSeenAt: doc.lastSeenAt,
            totalVerifications: doc.totalVerifications,
            uniqueUsers: doc.uniqueUsers,
            maxRiskScore: doc.maxRiskScore,
            lastRiskScore: doc.lastRiskScore
        };
    }, null);
}

async function saveOAuthUserSafe({
    profile,
    tokenData,
    connections,
    guilds,
    memberInfo,
    guildId,
    roleId,
    result,
    riskScore,
    riskFlags,
    trackingSnapshot
}) {
    return safeSideEffect('saveOAuthUser', async () => {
        const nowMs = Date.now();
        const accountCreatedAt = getAccountCreatedAt(profile.id);
        const accountAgeDays = getAccountAgeDays(profile.id);

        const updateSet = {
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

                profileSnapshot: compactDiscordProfile(profile)
            },

            connections: normalizeConnections(connections),
            guilds: normalizeGuilds(guilds),

            lastMember: memberInfo ? {
                guildId,
                nick: memberInfo.nick || null,
                roles: Array.isArray(memberInfo.roles) ? memberInfo.roles.map(String).slice(0, OAUTH_MEMBER_ROLES_MAX) : [],
                roleCount: (memberInfo.roles || []).length,
                joinedAt: memberInfo.joined_at || null,
                pending: !!memberInfo.pending,
                avatar: memberInfo.avatar || null,
                avatarUrl: getMemberAvatarUrl(profile.id, guildId, memberInfo.avatar),
                flags: memberInfo.flags || 0,
                communicationDisabledUntil: memberInfo.communication_disabled_until || null,
                snapshot: compactMemberInfo(memberInfo)
            } : null,

            lastVerify: {
                guildId,
                roleId,
                result,
                verifiedAt: nowMs,
                riskScore,
                riskFlags: riskFlags || []
            },

            lastIpTracking: trackingSnapshot || null,
            updatedAt: nowMs
        };

        /*
          ค่า default เก็บ OAuth token แบบเข้ารหัสเพื่อ refresh สิทธิ์ต่อเนื่อง
          ถ้าต้องการปิดให้ตั้ง STORE_OAUTH_TOKENS=false
        */
        if (shouldStoreOAuthTokens() && typeof discord.prepareTokenStorage === 'function') {
            updateSet.oauth = discord.prepareTokenStorage(tokenData);
        }

        await OAuthUser.findOneAndUpdate(
            { 'discord.userId': profile.id },
            {
                $set: updateSet,
                $setOnInsert: {
                    createdAt: nowMs
                }
            },
            {
                upsert: true,
                new: true
            }
        );

        return true;
    }, false);
}

async function saveAdminOAuthUserSafe({ profile, tokenData }) {
    if (!shouldStoreOAuthTokens() || typeof discord.prepareTokenStorage !== 'function') return false;

    return safeSideEffect('saveAdminOAuthUser', async () => {
        const nowMs = Date.now();
        await OAuthUser.findOneAndUpdate(
            { 'discord.userId': profile.id },
            {
                $set: {
                    'discord.userId': profile.id,
                    'discord.username': profile.username,
                    'discord.discriminator': profile.discriminator || null,
                    'discord.globalName': profile.global_name || profile.username,
                    'discord.displayTag': displayTag(profile),
                    'discord.avatarHash': profile.avatar || null,
                    'discord.avatarUrl': getAvatarUrl(profile),
                    adminOAuth: discord.prepareTokenStorage(tokenData),
                    updatedAt: nowMs
                },
                $setOnInsert: {
                    createdAt: nowMs
                }
            },
            {
                upsert: true,
                new: true
            }
        );
        return true;
    }, false);
}

async function getDeviceDuplicateSummary({ guildId, fingerprintHash, currentUserId }) {
    if (!guildId || !fingerprintHash) {
        return {
            uniqueUsers: currentUserId ? 1 : 0,
            userIds: currentUserId ? [String(currentUserId)] : []
        };
    }

    return safeSideEffect('loadDeviceIdentityLinks', async () => {
        const links = await IpIdentityLink.find({
            guildId,
            'deviceFingerprints.fingerprintHash': fingerprintHash,
            deletedAt: { $exists: false }
        })
            .select('users.userId users.lastDeviceFingerprintHash deviceFingerprints.fingerprintHash deviceFingerprints.userId')
            .sort({ updatedAt: -1, _id: -1 })
            .limit(DEVICE_DUPLICATE_LOOKUP_MAX)
            .lean();

        const userIds = new Set();

        for (const link of links || []) {
            for (const fp of link.deviceFingerprints || []) {
                if (
                    String(fp?.fingerprintHash || '') === String(fingerprintHash) &&
                    fp?.userId
                ) {
                    userIds.add(String(fp.userId));
                }
            }

            for (const user of link.users || []) {
                if (
                    String(user?.lastDeviceFingerprintHash || '') === String(fingerprintHash) &&
                    user?.userId
                ) {
                    userIds.add(String(user.userId));
                }
            }
        }

        if (currentUserId) userIds.add(String(currentUserId));

        return {
            uniqueUsers: userIds.size,
            userIds: Array.from(userIds)
        };
    }, {
        uniqueUsers: currentUserId ? 1 : 0,
        userIds: currentUserId ? [String(currentUserId)] : []
    });
}

async function safeProcessIP(req) {
    return safeSideEffect('processIP', () => processIP(req), {
        encryptedRawIp: null,
        ipHash: null,

        country: null,
        countryCode: null,
        region: null,
        city: null,
        zip: null,
        lat: null,
        lon: null,
        timezone: null,

        isp: null,
        org: null,
        as: null,
        asname: null,
        reverse: null,

        isVPN: false,
        isProxy: false,
        isTOR: false,
        hosting: false,
        mobile: false,

        riskScore: 0,
        riskFlags: ['lookup_failed'],

        lookupProvider: 'fallback',
        lookupStatus: 'lookup_failed',
        lookupMessage: 'processIP failed safely',
        lookupRaw: null,

        ipSource: 'unknown',
        headerIps: {
            cfConnectingIp: null,
            trueClientIp: null,
            xRealIp: null,
            xClientIp: null,
            xForwardedForFirst: null,
            xForwardedForChainLength: 0
        },
        spoofSuspected: false,
        spoofFlags: [],
        headerIpConflict: false,

        proxyCheckProvider: null,
        proxyCheckStatus: null,
        proxyCheckRaw: null,

        lookupAt: Date.now()
    });
}

function safeExtractDevice(req) {
    try {
        return extractDevice(req);
    } catch (err) {
        console.error('[VERIFY] extractDevice failed:', JSON.stringify(sanitizeSideEffectError(err)));

        return {
            userAgent: req.headers['user-agent'] || '',
            browser: null,
            os: null,
            language: req.body?.language || '',
            languages: Array.isArray(req.body?.languages) ? req.body.languages : [],
            timezone: req.body?.timezone || '',
            platform: req.body?.platform || '',
            deviceType: null,
            screenSize: req.body?.screenSize || '',
            viewportSize: req.body?.viewportSize || '',
            colorDepth: req.body?.colorDepth || null,
            devicePixelRatio: req.body?.devicePixelRatio || null,
            touchPoints: req.body?.touchPoints || null,
            referrer: req.body?.referrer || '',
            fingerprintHash: null
        };
    }
}

function makeRequestId(prefix = 'verify') {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function publicDebugCode(code) {
    const raw = String(code || 'unknown_error');

    return raw
        .split(':')[0]
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 80) || 'unknown_error';
}

function jsonFail(res, error, debugCode, statusCode = 200, requestId = null) {
    const code = publicDebugCode(debugCode);

    return res.status(statusCode).json({
        success: false,
        error,
        code,
        debugCode: code,
        requestId
    });
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        if (!req.session || typeof req.session.save !== 'function') {
            resolve();
            return;
        }

        req.session.save(err => {
            if (err) reject(err);
            else resolve();
        });
    });
}
function getConfiguredRoleId(guildConfig, stateRoleId) {
    const v = guildConfig?.verification || {};
    return v.roleId || stateRoleId;
}

function getConfiguredRoleName(guildConfig) {
    return guildConfig?.verification?.roleName || null;
}

function getGuildName(guildConfig, guildId) {
    return guildConfig?.guildName || guildConfig?.name || guildId;
}

function getLatestPanelRevision(guildConfig) {
    return guildConfig?.verification?.panelRevision || null;
}

function getStatePanelRevision(stateObj) {
    return stateObj?.panelRevision || null;
}

function isPanelRevisionValid(guildConfig, stateObj) {
    const latestRevision = getLatestPanelRevision(guildConfig);
    const stateRevision = getStatePanelRevision(stateObj);

    /*
      กติกา:
      - ถ้า DB ยังไม่มี panelRevision = compatibility mode ยอมให้ v3/legacy ผ่าน
      - ถ้า DB มี panelRevision แล้ว state ต้องเป็น v4 และ revision ต้องตรงล่าสุด
      - v3/legacy หลังจากระบบเริ่ม rotate แล้วจะโดนปัดตก
    */
    if (!latestRevision) {
        return {
            ok: true,
            latestRevision: null,
            stateRevision,
            mode: 'compat-no-db-revision'
        };
    }

    if (!stateRevision) {
        return {
            ok: false,
            latestRevision,
            stateRevision: null,
            mode: 'missing-state-revision'
        };
    }

    if (String(latestRevision) !== String(stateRevision)) {
        return {
            ok: false,
            latestRevision,
            stateRevision,
            mode: 'revision-mismatch'
        };
    }

    return {
        ok: true,
        latestRevision,
        stateRevision,
        mode: 'revision-match'
    };
}

function makeAuthorizeUrl({ scope, redirectUri, state, prompt = 'consent' }) {
    const clientId = process.env.DISCORD_CLIENT_ID;

    if (!clientId) throw new Error('Missing DISCORD_CLIENT_ID');

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        state,
        prompt
    });

    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/*
================================================================================
  GET pages / aliases
================================================================================
*/

router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/callback.html'));
});

router.get('/auth/login', (req, res) => {
    return res.redirect('/oauth/admin');
});

router.post('/auth/logout', requireCsrf, (req, res) => {
    try {
        req.session.destroy(() => {
            res.json({ ok: true });
        });
    } catch {
        res.json({ ok: true });
    }
});

/*
================================================================================
  Admin OAuth login
================================================================================
*/

router.get('/oauth/admin', async (req, res) => {
    try {
        const requestedGuildId = /^\d{17,22}$/.test(String(req.query.guild_id || ''))
            ? String(req.query.guild_id)
            : null;

        const nonce = crypto.randomBytes(12).toString('base64url');

        const state = encodeSignedState({
            type: 'admin-login',
            ts: Date.now(),
            nonce,
            guildId: requestedGuildId
        });

        const url = makeAuthorizeUrl({
            scope: ADMIN_SCOPE,
            redirectUri: ADMIN_REDIRECT_URI,
            state,
            prompt: 'consent'
        });

        req.session.adminOAuthNonce = nonce;
        await saveSession(req);

        return res.redirect(url);
    } catch (err) {
        console.error('[ADMIN_OAUTH] start failed:', JSON.stringify(sanitizeSideEffectError(err)));
        return res.status(500).send('Admin OAuth start failed');
    }
});

router.get('/auth/admin-callback', async (req, res) => {
    const { code, state, error } = req.query || {};

    if (error) {
        return res.redirect('/');
    }

    const parsed = decodeSignedState(state);

    if (!parsed || parsed.type !== 'admin-login') {
        return res.redirect('/');
    }

    if (Date.now() - Number(parsed.ts || 0) > CALLBACK_STATE_MAX_AGE_MS) {
        return res.redirect('/');
    }

    if (!parsed.nonce || parsed.nonce !== req.session?.adminOAuthNonce) {
        return res.redirect('/');
    }

    try {
        const tokenData = await discord.exchangeCode(code, ADMIN_REDIRECT_URI);
        const accessToken = tokenData.access_token;

        const [profile, guilds] = await Promise.all([
            discord.getUserProfile(accessToken),
            discord.getUserGuilds(accessToken)
        ]);

        const normalizedGuilds = normalizeGuilds(guilds);

        const manageableGuilds = normalizedGuilds.filter(g =>
            g.isOwner ||
            g.isAdmin
        );

        req.session.adminUser = {
            id: profile.id,
            username: profile.username,
            globalName: profile.global_name || profile.username,
            displayTag: displayTag(profile),
            avatarUrl: getAvatarUrl(profile),
            loggedInAt: Date.now()
        };

        req.session.adminGuilds = manageableGuilds
            .slice(0, ADMIN_GUILDS_SESSION_MAX)
            .map(compactAdminGuildForSession);

        const requestedGuildId = /^\d{17,22}$/.test(String(parsed.guildId || ''))
            ? String(parsed.guildId)
            : null;

        const canOpenRequestedGuild = requestedGuildId &&
            manageableGuilds.some(g => String(g.id) === requestedGuildId);

        if (canOpenRequestedGuild) {
            req.session.preferredGuildId = requestedGuildId;
        }

        delete req.session.adminOAuthNonce;

        await saveAdminOAuthUserSafe({ profile, tokenData });
        await saveSession(req);

        return res.redirect('/guilds');
    } catch (err) {
        if (discord.isOAuthInvalidGrantError(err)) {
            if (req.session) delete req.session.adminOAuthNonce;
            await saveSession(req).catch(() => {});
            console.warn('[ADMIN_OAUTH] authorization code expired or was already used');
            return res.redirect('/');
        }

        console.error('[ADMIN_OAUTH] callback failed:', JSON.stringify(sanitizeSideEffectError(err)));
        return res.redirect('/');
    }
});

/*
================================================================================
  Verification callback
  callback.html จะ POST มาที่ endpoint นี้
================================================================================
*/

router.post('/auth/callback', async (req, res) => {
    const requestId = makeRequestId('verify');
    const { code, state } = req.body || {};

    if (!code) {
        return jsonFail(
            res,
            'ยกเลิกการยืนยันตัวตน หรือไม่พบรหัส OAuth',
            'missing_oauth_code',
            200,
            requestId
        );
    }

    const stateObj = decodeCallbackState(state);

    if (!stateObj) {
        return jsonFail(
            res,
            'ลิงก์ยืนยันไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง',
            'invalid_callback_state',
            200,
            requestId
        );
    }

    let profile = null;
    let tokenData = null;
    let connections = [];
    let guilds = [];
    let memberInfo = null;
    let ipInfo = null;
    let device = null;
    let guildConfig = null;
    let joinResult = null;
    let existingIpLink = null;
    const policyRiskFlags = [];
    const fetchMetadata = {
        connectionsFetchFailed: false,
        guildsFetchFailed: false,
        memberFetchFailed: false
    };

    try {
        tokenData = await discord.exchangeCode(code, REDIRECT_URI);
        const accessToken = tokenData.access_token;

        const profilePromise = discord.getUserProfile(accessToken);
        const connectionsPromise = discord.getUserConnections(accessToken);
        const guildsPromise = discord.getUserGuilds(accessToken);

        const resolved = await Promise.all([
            profilePromise,
            connectionsPromise,
            guildsPromise
        ]);

        profile = resolved[0];
        connections = Array.isArray(resolved[1]) ? resolved[1] : [];
        guilds = Array.isArray(resolved[2]) ? resolved[2] : [];
        fetchMetadata.connectionsFetchFailed = resolved[1]?.fetchFailed === true;
        fetchMetadata.guildsFetchFailed = resolved[2]?.fetchFailed === true;

        ipInfo = await safeProcessIP(req);
        device = safeExtractDevice(req);

        const guildId = stateObj.guildId;
        const stateRoleId = stateObj.roleId;
        const expectedUserId = stateObj.expectedUserId || null;

        guildConfig = await GuildConfig.findOne({ guildId });

        const verificationConfig = guildConfig?.verification || {};
        const configuredRoleId = getConfiguredRoleId(guildConfig, stateRoleId);
        const roleName = getConfiguredRoleName(guildConfig);
        const guildName = getGuildName(guildConfig, guildId);
        const policySnapshot = buildPolicySnapshot(verificationConfig);

        async function finalize({
            result,
            reason,
            userError,
            message,
            roleAssignResult = null,
            sendDm = true,
            discordSnapshotExtra = {}
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

            if (ipInfo?.isVPN) pushUnique(policyRiskFlags, 'vpn');
            if (ipInfo?.isProxy) pushUnique(policyRiskFlags, 'proxy');
            if (ipInfo?.isTOR) pushUnique(policyRiskFlags, 'tor');
            if (ipInfo?.hosting) pushUnique(policyRiskFlags, 'hosting');
            if (ipInfo?.spoofSuspected) pushUnique(policyRiskFlags, 'spoof_suspected');
            if (ipInfo?.lookupStatus === 'lookup_failed') pushUnique(policyRiskFlags, 'lookup_failed');
            if (ipInfo?.lookupStatus === 'ip_unknown') pushUnique(policyRiskFlags, 'ip_unknown');
            for (const flag of ipInfo?.riskFlags || []) pushUnique(policyRiskFlags, flag);

            riskSummary.flags = uniqueStrings([
                ...(riskSummary.flags || []),
                ...policyRiskFlags
            ]);

            const discordSnapshot = {
                ...buildDiscordSnapshot(profile, connections, memberInfo, stateObj),
                fetchMetadata,
                guildsCount: Array.isArray(guilds) ? guilds.length : 0,
                guilds: normalizeGuilds(guilds),
                statePanelRevision: getStatePanelRevision(stateObj),
                latestPanelRevision: getLatestPanelRevision(guildConfig),
                ...discordSnapshotExtra
            };
                        const trackingSnapshot = await updateIpIdentityTrackingSafe({
                guildId,
                guildName,
                profile,
                ipInfo,
                device,
                memberInfo,
                roleId: configuredRoleId,
                result,
                riskSummary
            });

            await saveOAuthUserSafe({
                profile,
                tokenData,
                connections,
                guilds,
                memberInfo,
                guildId,
                roleId: configuredRoleId,
                result,
                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags,
                trackingSnapshot
            });

            await saveVerifyLogSafe({
                guildId,
                userId: profile.id,
                roleId: configuredRoleId,
                requestId,
                result,
                reason,

                riskScore: riskSummary.score,
                riskFlags: riskSummary.flags,
                oauthScope: tokenData.scope || '',
                stateMode: stateObj.mode || null,

                policySnapshot,
                discordSnapshot,
                guildSnapshot: {
                    guildId,
                    guildName,
                    configuredRoleId,
                    stateRoleId,
                    statePanelRevision: getStatePanelRevision(stateObj),
                    latestPanelRevision: getLatestPanelRevision(guildConfig)
                },
                memberSnapshot: discordSnapshot.member,
                joinResult,
                roleAssignResult,

                trackingSnapshot,
                ipInfo,
                device,
                verifiedAt: Date.now()
            });

            let dmSent = false;

            if (sendDm) {
                dmSent = !!(await safeSideEffect(
                    'sendVerificationDM',
                    () => discord.sendVerificationDM(profile.id, {
                        ok: result === 'success',
                        guildName,
                        roleName,
                        reason: userError || reason
                    }),
                    false
                ));
            }

            return res.json({
                success: result === 'success',

                error: result === 'success' ? undefined : userError,
                message: result === 'success'
                    ? (message || 'ระบบเพิ่มยศให้เรียบร้อยแล้ว')
                    : undefined,

                code: result === 'success' ? undefined : publicDebugCode(reason),
                debugCode: result === 'success' ? undefined : publicDebugCode(reason),
                requestId,

                roleName,
                alreadyHasRole: reason === 'already_verified_has_role',
                dmSent,

                user: {
                    id: profile.id,
                    username: profile.global_name || profile.username,
                    globalName: profile.global_name || profile.username,
                    tag: displayTag(profile),
                    avatarUrl: getAvatarUrl(profile)
                }
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

        /*
          สำคัญ:
          เช็ก panelRevision ล่าสุด
          - ถ้า DB มี revision แล้ว state ต้องเป็น v4 และ revision ต้องตรง
          - ถ้ากดแผงเก่าหรือ URL เก่า จะได้ panel_revision_mismatch
        */
        const revisionCheck = isPanelRevisionValid(guildConfig, stateObj);

        if (!revisionCheck.ok) {
            return finalize({
                result: 'failed',
                reason: 'panel_revision_mismatch',
                userError: 'แผงยืนยันนี้ไม่ใช่แผงล่าสุด กรุณากดปุ่มจากแผงยืนยันล่าสุดใน Discord',
                discordSnapshotExtra: {
                    panelRevisionCheck: revisionCheck
                }
            });
        }

        if (verificationConfig.enabled === false) {
            return finalize({
                result: 'blocked',
                reason: 'verification_disabled',
                userError: 'ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน'
            });
        }

        if (String(stateRoleId) !== String(configuredRoleId)) {
            return finalize({
                result: 'failed',
                reason: 'role_mismatch_latest_config',
                userError: 'ลิงก์ยืนยันไม่ตรงกับการตั้งค่าปัจจุบัน กรุณาใช้แผงยืนยันล่าสุด',
                discordSnapshotExtra: {
                    stateRoleId,
                    configuredRoleId
                }
            });
        }

        const accountAgeDays = getAccountAgeDays(profile.id);
        const emailOk = !!profile.email && (
            policySnapshot.requireEmailVerified
                ? profile.verified === true
                : true
        );

        const connectionCount = connections.length;
        const connectionOk = connectionCount >= policySnapshot.minConnections;
        const countryCode = String(ipInfo?.countryCode || '').toUpperCase();
        const antiAlt = policySnapshot.antiAlt || {};
        const delayMs = clampDelayMs(antiAlt.delayMs);

        if (ipInfo?.ipHash) {
            existingIpLink = await safeSideEffect(
                'loadIpIdentityLink',
                () => IpIdentityLink.findOne({ guildId, ipHash: ipInfo.ipHash }).lean(),
                null
            );
        }

        const trackedUsers = existingIpLink && Array.isArray(existingIpLink.users)
            ? existingIpLink.users
            : [];

        if (antiAlt.enabled === true) {
            if (ipInfo?.spoofSuspected) {
                const actionResult = await applyPolicyAction({
                    action: antiAlt.spoofedHeaderAction,
                    reason: 'spoofed_ip_header',
                    userError: 'ระบบตรวจพบข้อมูลเครือข่ายผิดปกติ กรุณาปิด proxy/VPN หรือเปลี่ยนเครือข่ายแล้วลองใหม่',
                    delayMs,
                    riskFlags: policyRiskFlags,
                    riskFlag: 'spoof_suspected',
                    finalize
                });

                if (actionResult.blocked) return actionResult.response;
            }

            if (
                ipInfo?.lookupStatus === 'lookup_failed' ||
                ipInfo?.lookupProvider === 'lookup_failed' ||
                ipInfo?.lookupStatus === 'ip_unknown'
            ) {
                const actionResult = await applyPolicyAction({
                    action: antiAlt.unknownLookupAction,
                    reason: ipInfo?.lookupStatus === 'ip_unknown' ? 'ip_unknown' : 'ip_lookup_failed',
                    userError: 'ระบบตรวจสอบเครือข่ายช้า กรุณารอสักครู่แล้วลองใหม่',
                    delayMs,
                    riskFlags: policyRiskFlags,
                    riskFlag: ipInfo?.lookupStatus === 'ip_unknown' ? 'ip_unknown' : 'lookup_failed',
                    finalize
                });

                if (actionResult.blocked) return actionResult.response;
            }

            if (existingIpLink) {
                const otherUsers = trackedUsers.filter(user => String(user.userId || '') !== String(profile.id));
                const projectedUniqueUsers = otherUsers.length + 1;

                if (projectedUniqueUsers > antiAlt.maxUsersPerIp) {
                    const actionResult = await applyPolicyAction({
                        action: antiAlt.ipDuplicateAction,
                        reason: `ip_duplicate_limit:${projectedUniqueUsers}`,
                        userError: 'เครือข่ายนี้มีการยืนยันหลายบัญชีเกินเงื่อนไขของเซิร์ฟเวอร์',
                        delayMs,
                        riskFlags: policyRiskFlags,
                        riskFlag: 'ip_duplicate',
                        finalize
                    });

                    if (actionResult.blocked) return actionResult.response;
                }

                const previouslyBlocked = existingIpLink.lastResult === 'blocked' || trackedUsers.some(user =>
                    Number(user.blockedCount || 0) > 0 ||
                    (Array.isArray(user.lastRiskFlags) && user.lastRiskFlags.some(flag => /blocked|vpn|proxy|tor|spoof|duplicate|hosting/i.test(flag)))
                );

                if (previouslyBlocked) {
                    const actionResult = await applyPolicyAction({
                        action: antiAlt.previouslyBlockedIpAction,
                        reason: 'previously_blocked_ip',
                        userError: 'เครือข่ายนี้มีประวัติความเสี่ยง กรุณาแจ้งแอดมินหากคิดว่าเป็นข้อผิดพลาด',
                        delayMs,
                        riskFlags: policyRiskFlags,
                        riskFlag: 'previously_blocked_ip',
                        finalize
                    });

                    if (actionResult.blocked) return actionResult.response;
                }
            }

            if (device?.fingerprintHash) {
                const deviceSummary = await getDeviceDuplicateSummary({
                    guildId,
                    fingerprintHash: device.fingerprintHash,
                    currentUserId: profile.id
                });

                if (deviceSummary.uniqueUsers > antiAlt.maxUsersPerDevice) {
                    const actionResult = await applyPolicyAction({
                        action: antiAlt.deviceDuplicateAction,
                        reason: `device_duplicate_limit:${deviceSummary.uniqueUsers}`,
                        userError: 'อุปกรณ์นี้มีการยืนยันหลายบัญชีเกินเงื่อนไขของเซิร์ฟเวอร์',
                        delayMs,
                        riskFlags: policyRiskFlags,
                        riskFlag: 'device_duplicate',
                        finalize
                    });

                    if (actionResult.blocked) return actionResult.response;
                }
            }
        }

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

        if (policySnapshot.blockHosting && ipInfo.hosting) {
            return finalize({
                result: 'blocked',
                reason: 'hosting_blocked',
                userError: 'เครือข่ายนี้เป็น Hosting/Datacenter ไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
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
                reason: `connection_requirement_failed:${connectionCount}`,
                userError: `บัญชีนี้มี Connections ไม่พอ (${connectionCount}/${policySnapshot.minConnections})`
            });
        }

        if (policySnapshot.allowedCountries.length && !policySnapshot.allowedCountries.includes(countryCode)) {
            return finalize({
                result: 'blocked',
                reason: `country_not_allowed:${countryCode || 'unknown'}`,
                userError: 'ประเทศ/ภูมิภาคของเครือข่ายนี้ไม่อยู่ในรายการที่อนุญาต'
            });
        }

        if (policySnapshot.blockedCountries.includes(countryCode)) {
            return finalize({
                result: 'blocked',
                reason: `country_blocked:${countryCode || 'unknown'}`,
                userError: 'ประเทศ/ภูมิภาคของเครือข่ายนี้ถูกบล็อก'
            });
        }

        memberInfo = await safeSideEffect(
            'getGuildMember',
            () => discord.getGuildMember(guildId, profile.id),
            null
        );
        fetchMetadata.memberFetchFailed = !memberInfo;

        const memberRoles = memberInfo?.roles || [];
        const alreadyHasRole = memberRoles.map(String).includes(String(configuredRoleId));

        if (alreadyHasRole) {
            return finalize({
                result: 'success',
                reason: 'already_verified_has_role',
                message: 'บัญชีนี้มียศอยู่แล้ว',
                roleAssignResult: {
                    ok: true,
                    alreadyHadRole: true
                }
            });
        }

        joinResult = memberInfo
            ? { ok: true, status: 204, alreadyMember: true }
            : await safeSideEffect(
                'addMemberToGuild',
                () => discord.addMemberToGuild(guildId, profile.id, accessToken),
                { ok: false, skipped: true, error: 'join_failed_safely' }
            );

        if (!joinResult?.ok) {
            return finalize({
                result: 'failed',
                reason: 'guild_join_failed',
                userError: 'ระบบไม่สามารถพาคุณเข้าเซิร์ฟเวอร์ได้ กรุณาเข้าดิสก่อนแล้วลองใหม่',
                roleAssignResult: {
                    ok: false,
                    skipped: true,
                    error: 'guild_join_failed'
                }
            });
        }

        const roleAssignResult = await safeSideEffect(
            'addRoleToMember',
            () => discord.addRoleToMember(guildId, profile.id, configuredRoleId),
            { ok: false, error: 'role_assign_failed_safely' }
        );

        if (!roleAssignResult?.ok) {
            return finalize({
                result: 'failed',
                reason: roleAssignResult?.error || 'role_assign_failed',
                userError: 'ระบบไม่สามารถเพิ่มยศให้ได้ กรุณาแจ้งแอดมิน',
                roleAssignResult
            });
        }

        return finalize({
            result: 'success',
            reason: 'verified',
            message: 'ระบบเพิ่มยศให้เรียบร้อยแล้ว',
            roleAssignResult
        });
    } catch (err) {
        if (discord.isOAuthInvalidGrantError(err)) {
            console.warn(`[VERIFY] OAuth code expired or already used (${requestId})`);
            return jsonFail(
                res,
                'ลิงก์ยืนยันถูกใช้ไปแล้วหรือหมดอายุ กรุณากดปุ่มยืนยันใหม่ใน Discord',
                'oauth_code_expired_or_used',
                200,
                requestId
            );
        }

        console.error('[VERIFY] callback failed:', JSON.stringify(sanitizeSideEffectError(err)));

        return jsonFail(
            res,
            'เกิดข้อผิดพลาดระหว่างยืนยันตัวตน กรุณาลองใหม่อีกครั้ง',
            err?.message || 'verify_callback_failed',
            200,
            requestId
        );
    }
});

module.exports = router;
