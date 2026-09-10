/* eslint-disable complexity -- OAuth flow is behavior-sensitive; refactor separately. */
const router = require('express').Router();
const path = require('path');
const crypto = require('node:crypto');

const discord = require('../utils/discordAPI');
const { processIP, extractDevice, applyHistoricalLocationContext } = require('../utils/ipUtils');
const {
    normalizeVerificationConfig,
    normalizeRuleAction,
    normalizeSecurityRules,
    clampNumber
} = require('../utils/verifyMode');
const { decodeCallbackState } = require('../utils/state');
const { normalizeGuildPermissions } = require('../utils/guildPermissions');
const { shouldStoreOAuthTokens } = require('../utils/oauthTokenLifecycle');
const snapshotBudget = require('../services/snapshotBudget');
const snapshotStore = require('../services/oauthSnapshotStore');
const ipIdentityHistory = require('../services/ipIdentityHistoryService');
const {
    snapshotMutationLocks: oauthSnapshotLocks,
    withSnapshotMutationLock: withOAuthSnapshotLock
} = require('../services/snapshotMutationLock');
const { resolvePublicBaseUrl } = require('../../core/publicUrl');

const OAuthUser = require('../models/OAuthUser');
const GuildConfig = require('../models/GuildConfig');
const VerifyLog = require('../models/VerifyLog');
const IpIdentityLink = require('../models/IpIdentityLink');
const VerificationRecovery = require('../models/VerificationRecovery');
const VerificationStateNonce = require('../models/VerificationStateNonce');
const { evaluateCriticalPersistence, coordinatePersistenceFailure } = require('../services/verificationPersistence');
const { consumeVerificationState, nonceHash } = require('../services/verificationStateNonce');
const { readFiniteInteger } = require('../../core/numbers');

const BASE_URL = resolvePublicBaseUrl(process.env, 'http://localhost:3000');

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const DEVICE_DUPLICATE_LOOKUP_MAX = readFiniteInteger(
    process.env.DEVICE_DUPLICATE_LOOKUP_MAX,
    { fallback: 200, min: 20, max: 2000 }
);
const DAY_MS = 24 * 60 * 60 * 1000;

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

const USER_BADGE_FLAGS = Object.freeze([
    [2 ** 0, 'STAFF'],
    [2 ** 1, 'PARTNER'],
    [2 ** 2, 'HYPESQUAD'],
    [2 ** 3, 'BUG_HUNTER_LEVEL_1'],
    [2 ** 6, 'HYPESQUAD_BRAVERY'],
    [2 ** 7, 'HYPESQUAD_BRILLIANCE'],
    [2 ** 8, 'HYPESQUAD_BALANCE'],
    [2 ** 9, 'PREMIUM_EARLY_SUPPORTER'],
    [2 ** 10, 'TEAM_PSEUDO_USER'],
    [2 ** 14, 'BUG_HUNTER_LEVEL_2'],
    [2 ** 16, 'VERIFIED_BOT'],
    [2 ** 17, 'VERIFIED_DEVELOPER'],
    [2 ** 18, 'CERTIFIED_MODERATOR'],
    [2 ** 19, 'BOT_HTTP_INTERACTIONS']
]);

function decodeUserBadgeFlags(profile = {}) {
    const flags = Number(profile.public_flags ?? profile.flags ?? 0) || 0;
    return USER_BADGE_FLAGS
        .filter(([bit]) => (flags & bit) === bit)
        .map(([, label]) => label);
}

function getAccountAgeDays(userId) {
    const createdAt = getAccountCreatedAt(userId);

    if (!createdAt) return 0;

    return Math.floor((Date.now() - createdAt) / DAY_MS);
}

function getAvatarUrl(profile) {
    if (!profile?.avatar) {
        let fallback = Number(profile?.discriminator || 0) % 5;
        if (!profile?.discriminator || profile.discriminator === "0") {
            try {
                fallback = Number((BigInt(profile.id) >> 22n) % 6n);
            } catch {
                fallback = 0;
            }
        }
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
    const securityRules = normalizeSecurityRules(normalized.securityRules || {});

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
        securityRules
    };
}

const MODERATION_PRIORITY = Object.freeze({ allow: 0, deny_role: 1, timeout: 2, kick: 3, ban: 4 });

function makeRuleViolation(key, rule, reason, userError) {
    if (!rule?.enabled) return null;
    return {
        key,
        action: normalizeRuleAction(rule.action, 'allow'),
        timeoutMinutes: clampNumber(rule.timeoutMinutes, 1, 40320, 60),
        reason,
        userError
    };
}

function strongestRuleViolation(violations = []) {
    return violations
        .filter(Boolean)
        .sort((a, b) => (MODERATION_PRIORITY[b.action] || 0) - (MODERATION_PRIORITY[a.action] || 0))[0] || null;
}

async function executeRuleViolation({ violation, guildId, userId, memberInfo }) {
    if (!violation || violation.action === 'allow') return { blocked: false, action: 'allow' };
    if (violation.action === 'deny_role') {
        return { blocked: true, ok: true, action: 'deny_role', status: 'role_denied' };
    }
    if ((violation.action === 'timeout' || violation.action === 'kick') && !memberInfo) {
        return {
            blocked: true,
            ok: true,
            action: 'deny_role',
            requestedAction: violation.action,
            status: 'member_absent_role_denied'
        };
    }
    const result = await discord.moderateVerificationMember(guildId, userId, violation.action, {
        timeoutMinutes: violation.timeoutMinutes,
        reason: `Verification policy: ${violation.reason}`
    });
    return {
        blocked: true,
        ok: result?.ok === true,
        action: violation.action,
        status: result?.ok === true ? 'applied' : 'failed',
        discordStatus: Number(result?.status || 0) || null,
        error: result?.ok === true ? null : 'verification_moderation_failed'
    };
}

function pushUnique(list, value) {
    if (!value) return;
    if (!list.includes(value)) list.push(value);
}

function uniqueStrings(values = []) {
    return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
}

function buildFindings({ ageDays, policy, ipInfo, connections, emailOk }) {
    const findings = [];

    if (ageDays < policy.minAccountAgeDays) {
        findings.push('new_account');
    }

    if (ipInfo?.isVPN || ipInfo?.isProxy || ipInfo?.isTOR || ipInfo?.hosting) {
        findings.push('network_anonymizer_or_hosting');
    }

    if (!connections?.length) {
        findings.push('no_connections');
    }

    if (!emailOk) {
        findings.push('email_missing_or_unverified');
    }

    const countryCode = String(ipInfo?.countryCode || '').toUpperCase();

    if (policy.allowedCountries.length && !policy.allowedCountries.includes(countryCode)) {
        findings.push('country_not_allowed');
    }

    if (policy.blockedCountries.includes(countryCode)) {
        findings.push('country_blocked');
    }

    return findings;
}

function safeString(value, maxLen = 0) {
    if (value === undefined || value === null) return '';

    const cleaned = String(value)
        .replace(/[\u0000-\u001F\u007F]/g, '');
    const max = Number(maxLen || 0);
    return Number.isFinite(max) && max > 0 ? cleaned.slice(0, max) : cleaned;
}

function safeNullableString(value, maxLen = 0) {
    const v = safeString(value, maxLen);
    return v || null;
}

function safeNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function safeSnowflakeStrict(value, label = "discord_id") {
    const text = String(value || "").trim();
    if (/^\d{17,22}$/.test(text)) return text;
    const err = new Error(`invalid ${label}`);
    err.code = "invalid_snowflake";
    throw err;
}

function safeIpHashStrict(value) {
    const text = String(value || "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    const err = new Error("invalid ip_hash");
    err.code = "invalid_ip_hash";
    throw err;
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
        if (!json) return {};

        const parsed = JSON.parse(json);
        return Object.prototype.toString.call(parsed) === '[object Object]' ? parsed : {};
    } catch {
        return {};
    }
}

function sanitizeDiscordPayload(value) {
    if (value === undefined || value === null) return value ?? null;
    const blockedKeys = new Set([
        "accesstoken",
        "refreshtoken",
        "authorization",
        "clientsecret",
        "bottoken",
        "token"
    ]);
    try {
        const json = JSON.stringify(value, (key, item) => {
            const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            const tokenShaped = normalizedKey.endsWith("token") ||
                normalizedKey.endsWith("secret") ||
                normalizedKey.endsWith("credential") ||
                normalizedKey.endsWith("apikey");
            if (blockedKeys.has(normalizedKey) || tokenShaped) {
                return "[stored-encrypted-separately]";
            }
            return typeof item === "string" ? safeString(item) : item;
        });
        return json ? JSON.parse(json) : null;
    } catch {
        return null;
    }
}

function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function memberFetchQualityStatus(fetchMetadata = {}, memberInfo = null) {
    if (!fetchMetadata.memberFetchAttempted) return "not_attempted";
    if (fetchMetadata.memberFetchFailed === true) return "failed";
    return memberInfo ? "success" : "failed";
}

function memberStoredCount(previous, memberInfo, failed) {
    if (failed) return previous.storedCount ?? null;
    if (memberInfo) return 1;
    return previous.storedCount ?? null;
}

function recordPostRoleMemberFetch(fetchMetadata = {}, refreshedMember = null) {
    fetchMetadata.memberFetchSource = "discord_bot_api";
    fetchMetadata.memberFetchStatus = refreshedMember ? 200 : null;
    fetchMetadata.memberFetchFailed = !refreshedMember;
    fetchMetadata.memberFailureReason = refreshedMember
        ? null
        : "discord_bot_member_refresh_failed";
    return refreshedMember;
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
                    ? connection.integrations.map(integration =>
                        sanitizeDiscordPayload(safePlainObject(integration)) || {}
                    )
                    : [],

                metadata: sanitizeDiscordPayload(safePlainObject(connection.metadata)) || {},

                /*
                  ห้ามเก็บ raw object เต็มก้อนจาก Discord ลง DB/log
                  เพราะเวลา Mongoose error มันอาจพ่นข้อมูล connections ทั้งชุดออก log
                */
                raw: sanitizeDiscordPayload(connection) || compactConnectionRaw(connection)
            };
        })
        .filter(Boolean);
}
function compactDiscordProfile(profile = {}) {
    return {
        id: safeNullableString(profile.id, 40),
        username: safeNullableString(profile.username, 120),
        discriminator: safeNullableString(profile.discriminator, 20),
        globalName: safeNullableString(profile.global_name ?? profile.globalName, 120),
        avatar: safeNullableString(profile.avatar, 120),
        banner: safeNullableString(profile.banner, 120),
        accentColor: safeNumberOrNull(profile.accent_color ?? profile.accentColor),
        locale: safeNullableString(profile.locale, 40),
        verified: profile.verified === true,
        emailVerified: Object.hasOwn(profile, 'verified') ? profile.verified === true : null,
        mfaEnabled: Object.hasOwn(profile, 'mfa_enabled') ? profile.mfa_enabled === true : null,
        premiumType: Object.hasOwn(profile, 'premium_type') ? safeNumberOrNull(profile.premium_type) : null,
        flags: safeNumberOrNull(profile.flags) || 0,
        publicFlags: safeNumberOrNull(profile.public_flags) || 0,
        badgeFlags: decodeUserBadgeFlags(profile)
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
            ? g.features.map(feature => safeNullableString(feature, 120)).filter(Boolean)
            : []
    };
}

function compactMemberInfo(member = {}) {
    const roles = Array.isArray(member.roles)
        ? member.roles.map(String)
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
    return (Array.isArray(guilds) ? guilds : []).map(g => {
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
                ? g.features.map(feature => safeNullableString(feature, 120)).filter(Boolean)
                : [],
            approximateMemberCount: g.approximate_member_count || null,
            approximatePresenceCount: g.approximate_presence_count || null,
            snapshot: sanitizeDiscordPayload(g) || compactUserGuild(g)
        };
    });
}

function buildOAuthDiscordUpdate(profile, profileUserId, accountCreatedAt, accountAgeDays) {
    return {
        userId: profileUserId,
        username: safeNullableString(profile.username, 80),
        discriminator: safeNullableString(profile.discriminator, 8),
        globalName: safeNullableString(profile.global_name ?? profile.globalName, 120),
        displayTag: safeNullableString(displayTag(profile), 160),

        avatarHash: safeNullableString(profile.avatar, 120),
        avatarUrl: safeNullableString(getAvatarUrl(profile), 512),
        bannerHash: safeNullableString(profile.banner, 120),
        bannerUrl: safeNullableString(getBannerUrl(profile), 512),
        accentColor: safeNumberOrNull(profile.accent_color),

        email: safeNullableString(profile.email, 320),
        emailVerified: Object.hasOwn(profile, 'verified') ? profile.verified === true : null,
        locale: safeNullableString(profile.locale, 32),
        mfaEnabled: Object.hasOwn(profile, 'mfa_enabled') ? profile.mfa_enabled === true : null,
        premiumType: Object.hasOwn(profile, 'premium_type') ? safeNumberOrNull(profile.premium_type) : null,

        flags: safeNumberOrNull(profile.flags) ?? 0,
        publicFlags: safeNumberOrNull(profile.public_flags) ?? 0,
        badgeFlags: decodeUserBadgeFlags(profile),

        accountCreatedAt,
        accountAgeDays,

        profileSnapshot: compactDiscordProfile(profile)
    };
}

function snapshotMetaForList(previousMeta, key, fetchMetadata, sourceList, storedList, nowMs) {
    const previous = objectOrEmpty(previousMeta[key]);
    const failedKey = `${key}FetchFailed`;
    const statusKey = `${key}FetchStatus`;
    const reasonKey = `${key}FailureReason`;
    const failed = fetchMetadata[failedKey] === true;

    return {
        ...previous,
        status: failed ? "failed" : "success",
        fetchedAt: failed ? (previous.fetchedAt || null) : nowMs,
        attemptedAt: nowMs,
        returnedCount: Array.isArray(sourceList) ? sourceList.length : 0,
        storedCount: failed ? (previous.storedCount ?? null) : storedList.length,
        truncated: false,
        failureReason: failed
            ? (fetchMetadata[reasonKey] || `discord_http_${fetchMetadata[statusKey] || "unknown"}`)
            : null,
        source: "discord_oauth"
    };
}

function snapshotMetaForMember(previousMeta, fetchMetadata, memberInfo, nowMs) {
    const previous = objectOrEmpty(previousMeta.member);
    const attempted = fetchMetadata.memberFetchAttempted === true;
    const failed = fetchMetadata.memberFetchFailed === true;

    return {
        ...previous,
        status: memberFetchQualityStatus(fetchMetadata, memberInfo),
        fetchedAt: memberInfo && !failed ? nowMs : (previous.fetchedAt || null),
        attemptedAt: attempted ? nowMs : (previous.attemptedAt || null),
        returnedCount: memberInfo ? 1 : 0,
        storedCount: memberStoredCount(previous, memberInfo, failed),
        truncated: false,
        failureReason: failed || (attempted && !memberInfo)
            ? (fetchMetadata.memberFailureReason || `discord_http_${fetchMetadata.memberFetchStatus || "unknown"}`)
            : null,
        source: fetchMetadata.memberFetchSource || "discord_oauth"
    };
}

function buildSnapshotMetaUpdate(previousMeta, fetchMetadata, snapshots, memberInfo, nowMs) {
    return {
        ...previousMeta,
        version: 2,
        updatedAt: nowMs,
        profile: {
            status: "success",
            fetchedAt: nowMs,
            source: "discord_oauth"
        },
        connections: snapshotMetaForList(
            previousMeta,
            "connections",
            fetchMetadata,
            snapshots.connectionsSource,
            snapshots.connectionsStored,
            nowMs
        ),
        guilds: snapshotMetaForList(
            previousMeta,
            "guilds",
            fetchMetadata,
            snapshots.guildsSource,
            snapshots.guildsStored,
            nowMs
        ),
        member: snapshotMetaForMember(previousMeta, fetchMetadata, memberInfo, nowMs)
    };
}

function buildLastMemberUpdate({ guildId, profileUserId, memberInfo }) {
    if (!memberInfo) return null;

    return {
        guildId,
        nick: memberInfo.nick || null,
        roles: Array.isArray(memberInfo.roles) ? memberInfo.roles.map(String) : [],
        roleCount: (memberInfo.roles || []).length,
        joinedAt: memberInfo.joined_at || null,
        pending: !!memberInfo.pending,
        avatar: memberInfo.avatar || null,
        avatarUrl: getMemberAvatarUrl(profileUserId, guildId, memberInfo.avatar),
        flags: memberInfo.flags || 0,
        communicationDisabledUntil: memberInfo.communication_disabled_until || null,
        snapshot: sanitizeDiscordPayload(memberInfo) || compactMemberInfo(memberInfo)
    };
}

function applySnapshotBudgetGuard(updateSet) {
    const bytes = snapshotStore.documentSetBytes(updateSet);
    if (!snapshotStore.isDocumentSetSafe(updateSet)) {
        const err = new Error("oauth_user_update exceeds MongoDB-safe document size");
        err.code = "snapshot_document_too_large";
        err.bytes = bytes;
        err.maxBytes = snapshotStore.DOCUMENT_WRITE_MAX_BYTES;
        throw err;
    }
    return {
        ok: true,
        bytes,
        maxBytes: snapshotStore.DOCUMENT_WRITE_MAX_BYTES,
        truncated: false
    };
}

function applyStoredSnapshotMeta(snapshotMeta, kind, ref) {
    if (!ref) return snapshotMeta;
    const previous = objectOrEmpty(snapshotMeta[kind]);
    return {
        ...snapshotMeta,
        [kind]: {
            ...previous,
            status: ref.complete ? "success" : "failed",
            returnedCount: ref.returnedCount,
            storedCount: ref.storedCount,
            complete: ref.complete === true && ref.returnedCount === ref.storedCount,
            chunkCount: ref.chunkCount,
            ...(Number.isFinite(Number(ref.roleReturnedCount)) ? {
                roleReturnedCount: Number(ref.roleReturnedCount),
                roleStoredCount: Number(ref.roleStoredCount || 0),
                roleChunkCount: Number(ref.roleChunkCount || 0)
            } : {}),
            snapshotVersion: ref.version,
            failureReason: ref.failureReason || null,
            source: ref.source || previous.source || "discord_oauth",
            fetchedAt: ref.capturedAt || previous.fetchedAt || null,
            updatedAt: ref.capturedAt || Date.now()
        }
    };
}

function preserveFailedMemberAttempt(snapshotMeta, previousMeta, fetchMetadata, nowMs) {
    if (fetchMetadata.memberFetchFailed !== true) return snapshotMeta;
    const previous = objectOrEmpty(previousMeta.member);
    return {
        ...snapshotMeta,
        member: {
            ...objectOrEmpty(snapshotMeta.member),
            status: "failed",
            fetchedAt: previous.fetchedAt || null,
            attemptedAt: nowMs,
            failureReason: fetchMetadata.memberFailureReason ||
                `discord_http_${fetchMetadata.memberFetchStatus || "unknown"}`
        }
    };
}

function isCompleteSnapshotSet(stored = {}) {
    if (stored.complete === true) return true;
    if (stored.complete === false) return false;
    const presentKinds = ["profile", "guilds", "connections", "member"]
        .filter(kind => stored[kind]);
    return presentKinds.length > 0 && presentKinds.every(kind =>
        stored[kind]?.complete === true &&
        stored[kind].returnedCount === stored[kind].storedCount
    );
}

function mergeCompleteSnapshotRefs(previousRefs = {}, stored = {}) {
    const next = { ...objectOrEmpty(previousRefs) };
    if (!isCompleteSnapshotSet(stored)) return next;
    const expectedKinds = Array.isArray(stored.expectedKinds)
        ? stored.expectedKinds
        : ["profile", "guilds", "connections", "member"].filter(kind => stored[kind]);
    for (const kind of expectedKinds) {
        if (stored[kind]?.complete === true &&
            stored[kind].returnedCount === stored[kind].storedCount) {
            next[kind] = stored[kind];
        }
    }
    next.snapshotSet = {
        version: stored.version || null,
        complete: true,
        expectedKinds,
        activatedAt: Date.now()
    };
    return next;
}

function applyForcedOAuthTokenStorage(updateSet, tokenData) {
    if (typeof discord.prepareTokenStorage !== 'function') {
        const error = new Error('OAuth token storage is unavailable');
        error.code = 'oauth_token_storage_unavailable';
        throw error;
    }
    updateSet.oauth = discord.prepareTokenStorage(tokenData);
}

function buildMemberSnapshot(memberInfo, profileId, guildId) {
    if (!memberInfo) return null;
    return {
        guildId,
        nick: memberInfo.nick || null,
        roles: memberInfo.roles || [],
        roleCount: (memberInfo.roles || []).length,
        joinedAt: memberInfo.joined_at || null,
        pending: !!memberInfo.pending,
        avatar: memberInfo.avatar || null,
        avatarUrl: getMemberAvatarUrl(profileId, guildId, memberInfo.avatar),
        flags: memberInfo.flags || 0,
        communicationDisabledUntil: memberInfo.communication_disabled_until || null,
        snapshot: compactMemberInfo(memberInfo)
    };
}

function buildDiscordSnapshot(profile, connections, memberInfo, stateObj, extra = {}) {
    return {
        userId: profile.id,
        username: profile.username,
        discriminator: profile.discriminator || null,
        globalName: profile.global_name ?? profile.globalName ?? null,
        displayTag: displayTag(profile),

        avatarHash: profile.avatar || null,
        avatarUrl: getAvatarUrl(profile),
        bannerHash: profile.banner || null,
        bannerUrl: getBannerUrl(profile),
        accentColor: profile.accent_color ?? null,

        email: profile.email || null,
        emailVerified: Object.hasOwn(profile, 'verified') ? profile.verified === true : null,
        locale: profile.locale || null,
        mfaEnabled: Object.hasOwn(profile, 'mfa_enabled') ? profile.mfa_enabled === true : null,
        premiumType: Object.hasOwn(profile, 'premium_type') ? profile.premium_type : null,
        flags: profile.flags || 0,
        publicFlags: profile.public_flags || 0,
        badgeFlags: decodeUserBadgeFlags(profile),

        accountCreatedAt: getAccountCreatedAt(profile.id),
        accountAgeDays: getAccountAgeDays(profile.id),

        connectionsCount: Array.isArray(connections) ? connections.length : 0,
        connections: normalizeConnections(connections),

        guildsCount: 0,
        callbackStateMode: stateObj?.mode || null,
        panelRevision: stateObj?.panelRevision || null,

        member: buildMemberSnapshot(memberInfo, profile.id, stateObj.guildId),
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

async function finalizeCriticalPersistenceFailure({
    requestId,
    guildId,
    userId,
    roleId,
    result,
    roleAssignResult,
    persistence,
    sendDm,
    removeRole,
    saveRecovery,
    sendFailureDm,
    coordinate = coordinatePersistenceFailure,
    runSideEffect = safeSideEffect
}) {
    const recovery = await coordinate({
        requestId,
        guildId,
        userId,
        roleId,
        result,
        roleAssignResult,
        persistence,
        removeRole,
        saveRecovery
    });

    if (!recovery.recoveryPersisted) {
        console.error("[VERIFY] recovery record persistence failed:", JSON.stringify({
            code: "verification_recovery_persistence_failed",
            requestId
        }));
    }

    let dmSent = false;
    if (sendDm && typeof sendFailureDm === "function") {
        dmSent = !!(await runSideEffect(
            "sendVerificationPersistenceFailureDM",
            sendFailureDm,
            false
        ));
    }

    return {
        statusCode: 503,
        body: {
            ...recovery.response,
            recoveryRequired: true,
            rollbackAttempted: recovery.rollbackAttempted,
            rollbackSucceeded: recovery.rollbackSucceeded,
            dmSent
        }
    };
}

function minimalVerifyLog(payload, budgetErr) {
    const dataQuality = objectOrEmpty(payload.dataQuality);
    return {
        guildId: payload.guildId,
        userId: payload.userId,
        roleId: payload.roleId,
        requestId: safeNullableString(payload.requestId, 160),
        result: payload.result,
        reason: safeNullableString(payload.reason, 500),
        findings: Array.isArray(payload.findings)
            ? payload.findings.map(flag => safeString(flag, 80))
            : [],
        oauthScope: safeNullableString(payload.oauthScope, 500),
        stateMode: safeNullableString(payload.stateMode, 80),
        verifiedAt: safeNumberOrNull(payload.verifiedAt) ?? Date.now(),
        snapshotVersion: payload.snapshotVersion || payload.snapshotRef?.version || null,
        snapshotRef: payload.snapshotRef || null,
        dataQuality: {
            ...dataQuality,
            budget: snapshotBudget.failureMeta(budgetErr, "verify_log_core")
        }
    };
}

function absoluteMinimumVerifyLog(payload, budgetErr) {
    return {
        guildId: safeString(payload.guildId, 32),
        userId: safeString(payload.userId, 32),
        roleId: safeNullableString(payload.roleId, 32),
        requestId: safeNullableString(payload.requestId, 160),
        result: safeString(payload.result || "error", 80),
        reason: "verify_log_payload_too_large",
        verifiedAt: safeNumberOrNull(payload.verifiedAt) ?? Date.now(),
        dataQuality: {
            budget: snapshotBudget.failureMeta(budgetErr, "verify_log_absolute_minimum")
        }
    };
}

function fitVerifyLogBudget(doc, payload) {
    try {
        snapshotBudget.assertSnapshotBudget(doc, { label: "verify_log" });
        return doc;
    } catch (budgetErr) {
        const minimal = minimalVerifyLog(payload, budgetErr);
        try {
            snapshotBudget.assertSnapshotBudget(minimal, { label: "verify_log_minimal" });
            return minimal;
        } catch (minimalBudgetErr) {
            return absoluteMinimumVerifyLog(payload, minimalBudgetErr);
        }
    }
}

async function saveVerifyLogSafe(payload) {
    return safeSideEffect('saveVerifyLog', async () => {
        const discordSnapshot = objectOrEmpty(payload.discordSnapshot);
        const discordCore = { ...discordSnapshot };
        delete discordCore.connections;
        delete discordCore.guilds;
        delete discordCore.member;
        let doc = {
            ...payload,
            ...(payload.trackingSnapshot ? {
                ipHistoryMigrationVersion: 1,
                ipHistoryMigratedAt: Date.now()
            } : {}),
            snapshotVersion: payload.snapshotVersion || payload.snapshotRef?.version || null,
            snapshotRef: payload.snapshotRef || null,
            discordSnapshot: {
                ...discordCore,
                connectionsCount: Array.isArray(discordSnapshot.connections)
                    ? discordSnapshot.connections.length
                    : Number(discordSnapshot.connectionsCount || 0),
                guildsCount: Array.isArray(discordSnapshot.guilds)
                    ? discordSnapshot.guilds.length
                    : Number(discordSnapshot.guildsCount || 0),
                snapshotRef: payload.snapshotRef || null
            }
        };
        doc = fitVerifyLogBudget(doc, payload);
        await VerifyLog.create(doc);
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
    findings
}) {
    return safeSideEffect('updateIpIdentityTracking', async () => {
        if (!guildId || !profile?.id || !ipInfo?.ipHash) return null;

        const nowMs = Date.now();
        const safeGuildId = safeSnowflakeStrict(guildId, 'guild_id');
        const safeProfileId = safeSnowflakeStrict(profile.id, 'discord_user_id');
        const safeIpHash = safeIpHashStrict(ipInfo.ipHash);

        const existing = await IpIdentityLink.findOne()
            .where('guildId').equals(safeGuildId)
            .where('ipHash').equals(safeIpHash);
        if (existing) await ipIdentityHistory.ensureLegacyLinkMigrated(existing, { now: nowMs });

        const history = await ipIdentityHistory.recordIpIdentityHistory({
            guildId: safeGuildId,
            ipHash: safeIpHash,
            profile: {
                ...profile,
                id: safeProfileId,
                displayTag: displayTag(profile),
                avatarUrl: getAvatarUrl(profile)
            },
            ipInfo,
            device,
            memberInfo,
            roleId,
            result,
            findings,
            now: nowMs
        });

        const setFields = {
            guildName: guildName || existing?.guildName || safeGuildId,
            lastSeenAt: nowMs,
            lastResult: result,
            lastRoleId: roleId,
            lastFindings: Array.isArray(findings) ? findings : [],
            lastCountry: ipInfo.country,
            lastCountryCode: ipInfo.countryCode,
            lastRegion: ipInfo.region,
            lastCity: ipInfo.city,
            lastTimezone: ipInfo.timezone,
            lastIsp: ipInfo.isp,
            lastOrg: ipInfo.org,
            lastAs: ipInfo.as,
            lastAsname: ipInfo.asname,
            isVPN: !!ipInfo.isVPN,
            isProxy: !!ipInfo.isProxy,
            isTOR: !!ipInfo.isTOR,
            hosting: !!ipInfo.hosting,
            mobile: !!ipInfo.mobile,
            anycast: !!ipInfo.anycast,
            networkType: ipInfo.networkType || null,
            locationConfidence: ipInfo.locationConfidence || 'unknown',
            locationConfidenceScore: ipInfo.locationConfidenceScore ?? null,
            accuracyRadiusKm: ipInfo.accuracyRadiusKm ?? null,
            lastIpInfo: ipInfo,
            lastDevice: device,
            uniqueUsers: Number(history?.uniqueUsers || existing?.uniqueUsers || 0),
            updatedAt: nowMs
        };
        if (ipInfo.encryptedRawIp) setFields.encryptedRawIp = ipInfo.encryptedRawIp;
        const doc = await IpIdentityLink.findOneAndUpdate(
            { guildId: safeGuildId, ipHash: safeIpHash },
            {
                $setOnInsert: {
                    guildId: safeGuildId,
                    ipHash: safeIpHash,
                    firstSeenAt: nowMs,
                    users: [],
                    deviceFingerprints: [],
                    roleSnapshots: [],
                    createdAt: nowMs
                },
                $inc: { totalVerifications: 1 },
                $min: { firstSeenAt: nowMs },
                $set: setFields,
                $unset: { deletedAt: 1, deletionReason: 1 }
            },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        );

        return {
            ipHash: doc.ipHash,
            firstSeenAt: doc.firstSeenAt,
            lastSeenAt: doc.lastSeenAt,
            totalVerifications: doc.totalVerifications,
            uniqueUsers: doc.uniqueUsers
        };
    }, null);
}

async function loadOAuthSnapshotState(profileUserId) {
    return OAuthUser.findOne()
        .where("discord.userId")
        .equals(profileUserId)
        .select("snapshotMeta snapshotRefs")
        .lean();
}

function activeSnapshotVersion(state) {
    const activationVersion = state?.snapshotMeta?.activation?.snapshotVersion;
    if (activationVersion) return activationVersion;
    const versions = Object.values(state?.snapshotRefs || {})
        .map(ref => ref?.version)
        .filter(Boolean);
    return versions.length && versions.every(version => version === versions[0])
        ? versions[0]
        : null;
}

function stagedSnapshotRefs(storedSnapshots) {
    const expectedKinds = Array.isArray(storedSnapshots?.expectedKinds)
        ? storedSnapshots.expectedKinds
        : ["profile", "guilds", "connections", "member"].filter(kind => storedSnapshots?.[kind]);
    return Object.fromEntries(expectedKinds
        .filter(kind => storedSnapshots?.[kind])
        .map(kind => [kind, storedSnapshots[kind]]));
}

function rollbackStoredSnapshots(userId, storedSnapshots) {
    return snapshotStore.rollbackSnapshotVersion({
        userId,
        version: storedSnapshots.version,
        refs: stagedSnapshotRefs(storedSnapshots)
    });
}

async function verifyStagedSnapshots({ profileUserId, storedSnapshots, fetchMetadata, memberInfo, guildId }) {
    if (!isCompleteSnapshotSet(storedSnapshots)) {
        const activeState = await loadOAuthSnapshotState(profileUserId).catch(() => null);
        return {
            ok: false,
            fallback: {
                saved: false,
                snapshotVersion: activeSnapshotVersion(activeState),
                attemptedSnapshotVersion: storedSnapshots.version,
                snapshotRefs: activeState?.snapshotRefs || null,
                snapshotWrites: storedSnapshots
            }
        };
    }

    const stagedRefs = stagedSnapshotRefs(storedSnapshots);
    const reconstructed = await snapshotStore.loadOAuthSnapshots({
        userId: profileUserId,
        refs: stagedRefs,
        guildId
    }).catch(() => null);
    const reconstructionComplete = Boolean(
        reconstructed?.profile &&
        (fetchMetadata.connectionsFetchFailed || Array.isArray(reconstructed.connections)) &&
        (fetchMetadata.guildsFetchFailed || Array.isArray(reconstructed.guilds)) &&
        (!memberInfo || reconstructed.member)
    );
    if (!reconstructionComplete) {
        const rollback = await rollbackStoredSnapshots(profileUserId, storedSnapshots);
        return {
            ok: false,
            fallback: {
                saved: false,
                code: "snapshot_reconstruction_failed",
                snapshotVersion: null,
                attemptedSnapshotVersion: storedSnapshots.version,
                snapshotRefs: null,
                snapshotWrites: storedSnapshots,
                rollback
            }
        };
    }
    return { ok: true, stagedRefs };
}

function assembleActivatedSnapshotMeta({
    previousMeta,
    fetchMetadata,
    connections,
    connectionSnapshot,
    guilds,
    guildSnapshot,
    memberInfo,
    nowMs,
    storedSnapshots,
    safeAttemptStartedAt
}) {
    let snapshotMeta = buildSnapshotMetaUpdate(
        previousMeta,
        fetchMetadata,
        {
            connectionsSource: connections,
            connectionsStored: connectionSnapshot,
            guildsSource: guilds,
            guildsStored: guildSnapshot
        },
        memberInfo,
        nowMs
    );
    snapshotMeta = applyStoredSnapshotMeta(snapshotMeta, "connections", storedSnapshots.connections);
    snapshotMeta = applyStoredSnapshotMeta(snapshotMeta, "guilds", storedSnapshots.guilds);
    snapshotMeta = applyStoredSnapshotMeta(snapshotMeta, "member", storedSnapshots.member);
    snapshotMeta = applyStoredSnapshotMeta(snapshotMeta, "profile", storedSnapshots.profile);
    snapshotMeta = preserveFailedMemberAttempt(snapshotMeta, previousMeta, fetchMetadata, nowMs);
    return {
        ...snapshotMeta,
        activation: {
            attemptStartedAt: safeAttemptStartedAt,
            snapshotVersion: storedSnapshots.version,
            activatedAt: nowMs
        }
    };
}

async function commitOAuthUserActivation({
    profileUserId,
    updateSet,
    safeAttemptStartedAt,
    nowMs,
    existing,
    storedSnapshots
}) {
    try {
        applySnapshotBudgetGuard(updateSet);
        const activationFilter = {
            'discord.userId': profileUserId,
            $or: [
                { 'snapshotMeta.activation.attemptStartedAt': { $exists: false } },
                { 'snapshotMeta.activation.attemptStartedAt': { $lte: safeAttemptStartedAt } }
            ]
        };
        const activated = await OAuthUser.findOneAndUpdate(
            activationFilter,
            {
                $set: updateSet,
                $setOnInsert: { createdAt: nowMs }
            },
            {
                upsert: !existing,
                returnDocument: "after"
            }
        );
        if (!activated) {
            const stale = new Error("A newer OAuth snapshot attempt is already active");
            stale.code = "snapshot_activation_stale";
            throw stale;
        }
        return { ok: true, activated };
    } catch (err) {
        const duplicateDiscordUser = Number(err?.code) === 11000 && (
            err?.keyPattern?.["discord.userId"] || err?.keyValue?.["discord.userId"]
        );
        if (duplicateDiscordUser) err.code = "snapshot_activation_stale";
        const rollback = await rollbackStoredSnapshots(profileUserId, storedSnapshots);
        console.error("[VERIFY] saveOAuthUser core failed:", JSON.stringify(sanitizeSideEffectError(err)));
        const active = err?.code === "snapshot_activation_stale"
            ? await loadOAuthSnapshotState(profileUserId).catch(() => null)
            : null;
        return {
            ok: false,
            fallback: {
                saved: false,
                code: err?.code || "oauth_user_write_failed",
                snapshotVersion: activeSnapshotVersion(active || existing),
                attemptedSnapshotVersion: storedSnapshots.version,
                snapshotRefs: active?.snapshotRefs || existing?.snapshotRefs || null,
                snapshotWrites: storedSnapshots,
                rollback
            }
        };
    }
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
    findings,
    trackingSnapshot,
    fetchMetadata = {},
    attemptStartedAt = Date.now()
}) {
    return safeSideEffect('saveOAuthUser', async () => {
        const profileUserId = safeSnowflakeStrict(profile.id, "discord_user_id");
        return withOAuthSnapshotLock(profileUserId, async () => {
            const nowMs = Date.now();
            const safeAttemptStartedAt = Math.max(0, Number(attemptStartedAt) || nowMs);
            const accountCreatedAt = getAccountCreatedAt(profileUserId);
            const accountAgeDays = getAccountAgeDays(profileUserId);
            const connectionSnapshot = normalizeConnections(connections);
            const guildSnapshot = normalizeGuilds(guilds);
            const lastMember = buildLastMemberUpdate({ guildId, profileUserId, memberInfo });
            const storedSnapshots = await snapshotStore.storeOAuthSnapshots({
                userId: profileUserId,
                guildId,
                profile: sanitizeDiscordPayload(profile),
                guilds: guildSnapshot,
                connections: connectionSnapshot,
                member: lastMember,
                fetchMetadata,
                now: nowMs
            });

            const stagedResult = await verifyStagedSnapshots({
                profileUserId,
                storedSnapshots,
                fetchMetadata,
                memberInfo,
                guildId
            });
            if (!stagedResult.ok) {
                return stagedResult.fallback;
            }

            // Read after staging completes so optional-fetch preservation and ref
            // merging use the freshest active state available before activation.
            let existing;
            try {
                existing = await loadOAuthSnapshotState(profileUserId);
            } catch (err) {
                const rollback = await rollbackStoredSnapshots(profileUserId, storedSnapshots);
                console.error("[VERIFY] active snapshot read failed:", JSON.stringify(sanitizeSideEffectError(err)));
                return {
                    saved: false,
                    code: err?.code || "snapshot_active_read_failed",
                    snapshotVersion: null,
                    attemptedSnapshotVersion: storedSnapshots.version,
                    snapshotRefs: null,
                    snapshotWrites: storedSnapshots,
                    rollback
                };
            }
            const previousMeta = existing?.snapshotMeta || {};
            const snapshotMeta = assembleActivatedSnapshotMeta({
                previousMeta,
                fetchMetadata,
                connections,
                connectionSnapshot,
                guilds,
                guildSnapshot,
                memberInfo,
                nowMs,
                storedSnapshots,
                safeAttemptStartedAt
            });
            const snapshotRefs = mergeCompleteSnapshotRefs(existing?.snapshotRefs, storedSnapshots);

            const updateSet = {
                discord: buildOAuthDiscordUpdate(profile, profileUserId, accountCreatedAt, accountAgeDays),
                lastVerify: {
                    guildId,
                    roleId,
                    result,
                    attemptStartedAt: safeAttemptStartedAt,
                    verifiedAt: nowMs,
                    findings: findings || []
                },
                lastIpTracking: trackingSnapshot || null,
                snapshotMeta,
                snapshotRefs,
                updatedAt: nowMs
            };

            applyForcedOAuthTokenStorage(updateSet, tokenData);

            const commitResult = await commitOAuthUserActivation({
                profileUserId,
                updateSet,
                safeAttemptStartedAt,
                nowMs,
                existing,
                storedSnapshots
            });
            if (!commitResult.ok) {
                return commitResult.fallback;
            }

            return {
                saved: true,
                snapshotVersion: storedSnapshots.version,
                snapshotRefs: commitResult.activated?.snapshotRefs || snapshotRefs,
                snapshotWrites: storedSnapshots
            };
        });
    }, {
        saved: false,
        code: 'save_oauth_user_failed_safely',
        snapshotVersion: null,
        attemptedSnapshotVersion: null,
        snapshotRefs: null,
        snapshotWrites: null
    });
}

function addMatchingFingerprintUsers(userIds, list, hashField, targetHash) {
    for (const item of list || []) {
        if (String(item?.[hashField] || '') === targetHash && item?.userId) {
            userIds.add(String(item.userId));
        }
    }
}

function collectMatchingDeviceUserIds(links, fingerprintHash) {
    const userIds = new Set();
    const targetHash = String(fingerprintHash || '');
    if (!targetHash) return userIds;

    for (const link of links || []) {
        addMatchingFingerprintUsers(userIds, link.deviceFingerprints, 'fingerprintHash', targetHash);
        addMatchingFingerprintUsers(userIds, link.users, 'lastDeviceFingerprintHash', targetHash);
    }
    return userIds;
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

        const userIds = collectMatchingDeviceUserIds(links, fingerprintHash);
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
        anycast: false,
        networkType: null,

        findings: ['lookup_failed'],

        lookupProvider: 'fallback',
        lookupStatus: 'lookup_failed',
        lookupMessage: 'processIP failed safely',
        lookupProviders: [],
        lookupFallbackUsed: false,
        lookupConsensusUsed: false,
        lookupProviderCount: 0,
        accuracyRadiusKm: null,
        locationAccuracy: null,
        locationConfidence: 'unknown',
        locationConfidenceScore: null,
        locationConfidenceReasons: ['lookup_failed'],
        providerAgreement: null,
        providerEvidence: [],
        browserTimezone: null,
        browserTimezoneMatches: null,
        historyConsistency: null,
        securitySignalsAvailable: false,
        lookupRaw: null,

        ipSource: 'unknown',
        headerIps: {
            cfConnectingIpHash: null,
            trueClientIpHash: null,
            xRealIpHash: null,
            xClientIpHash: null,
            xForwardedForFirstHash: null,
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

function safeExtractDevice(req, extractor = extractDevice) {
    try {
        return { ...extractor(req), extractionStatus: "success", extractionFailureReason: null };
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
            fingerprintHash: null,
            extractionStatus: "failed",
            extractionFailureReason: "browser_payload_extraction_failed"
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

router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/callback.html'));
});

function collectPolicyFindings(ipInfo, policyFindings = []) {
    const findings = [...policyFindings];
    if (ipInfo?.isVPN) pushUnique(findings, 'vpn');
    if (ipInfo?.isProxy) pushUnique(findings, 'proxy');
    if (ipInfo?.isTOR) pushUnique(findings, 'tor');
    if (ipInfo?.hosting) pushUnique(findings, 'hosting');
    if (ipInfo?.spoofSuspected) pushUnique(findings, 'spoof_suspected');
    if (ipInfo?.lookupStatus === 'lookup_failed') pushUnique(findings, 'lookup_failed');
    if (ipInfo?.lookupStatus === 'ip_unknown') pushUnique(findings, 'ip_unknown');
    for (const finding of ipInfo?.findings || []) pushUnique(findings, finding);
    return findings;
}

function resolveFinalPersistenceStatus(result, reason, userError, oauthPersistence) {
    const persistenceIncomplete = result === 'success' && oauthPersistence?.saved !== true;
    return {
        persistenceIncomplete,
        finalResult: persistenceIncomplete ? 'failed' : result,
        finalReason: persistenceIncomplete ? 'verification_persistence_failed' : reason,
        finalUserError: persistenceIncomplete
            ? 'เพิ่มยศใน Discord แล้ว แต่บันทึกข้อมูลยืนยันไม่สมบูรณ์ กรุณาแจ้งแอดมินเพื่อตรวจสอบ'
            : userError
    };
}

function buildProfileQuality(profileWrite) {
    const isComplete = profileWrite?.complete === true;
    return {
        status: isComplete ? "success" : "failed",
        attemptedAt: Date.now(),
        fetchedAt: Date.now(),
        returnedCount: 1,
        storedCount: Number(profileWrite?.storedCount || 0),
        complete: isComplete,
        chunkCount: Number(profileWrite?.chunkCount || 0),
        snapshotVersion: profileWrite?.version || null,
        truncated: false,
        failureReason: profileWrite?.failureReason || null,
        source: "discord_oauth"
    };
}

function buildConnectionsQuality(fetchMetadata, connections, connectionsWrite) {
    const isFailed = fetchMetadata.connectionsFetchFailed;
    const isComplete = !isFailed && connectionsWrite?.complete === true;
    return {
        status: isComplete ? "success" : "failed",
        attemptedAt: Date.now(),
        fetchedAt: isFailed ? null : Date.now(),
        returnedCount: Array.isArray(connections) ? connections.length : 0,
        storedCount: isFailed ? null : Number(connectionsWrite?.storedCount || 0),
        complete: connectionsWrite?.complete === true,
        chunkCount: Number(connectionsWrite?.chunkCount || 0),
        snapshotVersion: connectionsWrite?.version || null,
        truncated: false,
        failureReason: isFailed
            ? (fetchMetadata.connectionsFailureReason || `discord_http_${fetchMetadata.connectionsFetchStatus || "unknown"}`)
            : (connectionsWrite?.failureReason || null),
        source: "discord_oauth"
    };
}

function buildGuildsQuality(fetchMetadata, guilds, guildsWrite) {
    const isFailed = fetchMetadata.guildsFetchFailed;
    const isComplete = !isFailed && guildsWrite?.complete === true;
    return {
        status: isComplete ? "success" : "failed",
        attemptedAt: Date.now(),
        fetchedAt: isFailed ? null : Date.now(),
        returnedCount: Array.isArray(guilds) ? guilds.length : 0,
        storedCount: isFailed ? null : Number(guildsWrite?.storedCount || 0),
        complete: guildsWrite?.complete === true,
        chunkCount: Number(guildsWrite?.chunkCount || 0),
        snapshotVersion: guildsWrite?.version || null,
        truncated: false,
        failureReason: isFailed
            ? (fetchMetadata.guildsFailureReason || `discord_http_${fetchMetadata.guildsFetchStatus || "unknown"}`)
            : (guildsWrite?.failureReason || null),
        source: "discord_oauth"
    };
}

function resolveMemberQualityStatus(fetchMetadata, memberInfo, memberWrite) {
    if (memberInfo && fetchMetadata.memberFetchFailed !== true) {
        return {
            status: memberWrite?.complete ? "success" : "failed",
            failureReason: memberWrite?.failureReason || null
        };
    }
    const failureReason = fetchMetadata.memberFetchAttempted && !memberInfo
        ? (fetchMetadata.memberFailureReason || `discord_http_${fetchMetadata.memberFetchStatus || "unknown"}`)
        : null;
    return {
        status: memberFetchQualityStatus(fetchMetadata, memberInfo),
        failureReason
    };
}

function buildMemberQuality(fetchMetadata, memberInfo, memberWrite) {
    const { status, failureReason } = resolveMemberQualityStatus(fetchMetadata, memberInfo, memberWrite);
    return {
        status,
        attemptedAt: fetchMetadata.memberFetchAttempted ? Date.now() : null,
        fetchedAt: memberInfo ? Date.now() : null,
        returnedCount: memberInfo ? 1 : 0,
        storedCount: memberInfo ? Number(memberWrite?.storedCount || 0) : null,
        complete: memberWrite?.complete === true,
        roleReturnedCount: Number(memberWrite?.roleReturnedCount || 0),
        roleStoredCount: Number(memberWrite?.roleStoredCount || 0),
        roleChunkCount: Number(memberWrite?.roleChunkCount || 0),
        snapshotVersion: memberWrite?.version || null,
        truncated: false,
        failureReason,
        source: fetchMetadata.memberFetchSource || "discord_oauth"
    };
}

function buildDeviceQuality(device) {
    const isFailed = device?.extractionStatus === "failed";
    return {
        status: isFailed ? "failed" : "success",
        attemptedAt: Date.now(),
        fetchedAt: isFailed ? null : Date.now(),
        returnedCount: isFailed ? 0 : 1,
        storedCount: isFailed ? 0 : 1,
        truncated: false,
        failureReason: device?.extractionFailureReason || null,
        source: "browser"
    };
}

function buildNetworkQuality(ipInfo) {
    const isOk = ["success", "lookup_ok", "ok"].includes(ipInfo?.lookupStatus);
    return {
        status: ipInfo?.lookupStatus || "unknown",
        attemptedAt: Date.now(),
        fetchedAt: ipInfo?.lookupAt || null,
        returnedCount: ipInfo ? 1 : 0,
        storedCount: ipInfo ? 1 : 0,
        truncated: false,
        failureReason: isOk ? null : `ip_lookup_${ipInfo?.lookupStatus || "unavailable"}`,
        source: "request_ip_lookup"
    };
}

function buildVerificationDataQuality({
    oauthPersistence,
    fetchMetadata,
    connections,
    guilds,
    memberInfo,
    device,
    ipInfo
}) {
    return {
        version: 2,
        capturedAt: Date.now(),
        profile: buildProfileQuality(oauthPersistence?.snapshotWrites?.profile),
        connections: buildConnectionsQuality(fetchMetadata, connections, oauthPersistence?.snapshotWrites?.connections),
        guilds: buildGuildsQuality(fetchMetadata, guilds, oauthPersistence?.snapshotWrites?.guilds),
        member: buildMemberQuality(fetchMetadata, memberInfo, oauthPersistence?.snapshotWrites?.member),
        device: buildDeviceQuality(device),
        network: buildNetworkQuality(ipInfo)
    };
}

function checkCallbackPreconditions({
    expectedUserId,
    profile,
    guildConfig,
    configuredRoleId,
    stateObj,
    stateRoleId,
    verificationConfig
}) {
    if (expectedUserId && profile.id !== expectedUserId) {
        return {
            result: 'failed',
            reason: 'oauth_user_mismatch',
            userError: 'บัญชี Discord ไม่ตรงกับผู้ที่กดปุ่มยืนยัน',
            discordSnapshotExtra: { expectedUserId, actualUserId: profile.id }
        };
    }
    if (!guildConfig || !configuredRoleId) {
        return {
            result: 'failed',
            reason: 'guild_config_missing_role',
            userError: 'ระบบยังไม่ได้ตั้งค่า Role ID กรุณาแจ้งแอดมิน'
        };
    }
    const revisionCheck = isPanelRevisionValid(guildConfig, stateObj);
    if (!revisionCheck.ok) {
        return {
            result: 'failed',
            reason: 'panel_revision_mismatch',
            userError: 'แผงยืนยันนี้ไม่ใช่แผงล่าสุด กรุณากดปุ่มจากแผงยืนยันล่าสุดใน Discord',
            discordSnapshotExtra: { panelRevisionCheck: revisionCheck }
        };
    }
    if (verificationConfig.enabled === false) {
        return {
            result: 'blocked',
            reason: 'verification_disabled',
            userError: 'ระบบยืนยันตัวตนของเซิร์ฟเวอร์นี้ยังไม่เปิดใช้งาน'
        };
    }
    if (String(stateRoleId) !== String(configuredRoleId)) {
        return {
            result: 'failed',
            reason: 'role_mismatch_latest_config',
            userError: 'ลิงก์ยืนยันไม่ตรงกับการตั้งค่าปัจจุบัน กรุณาใช้แผงยืนยันล่าสุด',
            discordSnapshotExtra: { stateRoleId, configuredRoleId }
        };
    }
    return null;
}

function checkAccountEligibilityRequirements({
    accountAgeDays,
    policySnapshot,
    emailOk,
    connectionOk,
    connectionCount
}) {
    if (accountAgeDays < policySnapshot.minAccountAgeDays) {
        return {
            result: 'blocked',
            reason: `new_account:${accountAgeDays}`,
            userError: `บัญชีอายุน้อยเกินไป (${accountAgeDays} วัน ต้องการ ${policySnapshot.minAccountAgeDays} วัน)`
        };
    }
    if (policySnapshot.requireEmail && !emailOk) {
        return {
            result: 'blocked',
            reason: 'email_requirement_failed',
            userError: 'บัญชีนี้ไม่มี Email หรือ Email ยังไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์'
        };
    }
    if (policySnapshot.requireConnections && !connectionOk) {
        return {
            result: 'blocked',
            reason: `connection_requirement_failed:${connectionCount}`,
            userError: `บัญชีนี้มี Connections ไม่พอ (${connectionCount}/${policySnapshot.minConnections})`
        };
    }
    return null;
}

function checkCountryPolicy(policySnapshot, countryCode) {
    if (policySnapshot.allowedCountries.length && !policySnapshot.allowedCountries.includes(countryCode)) {
        return {
            result: 'blocked',
            reason: `country_not_allowed:${countryCode || 'unknown'}`,
            userError: 'ประเทศ/ภูมิภาคของเครือข่ายนี้ไม่อยู่ในรายการที่อนุญาต'
        };
    }
    if (policySnapshot.blockedCountries.includes(countryCode)) {
        return {
            result: 'blocked',
            reason: `country_blocked:${countryCode || 'unknown'}`,
            userError: 'ประเทศ/ภูมิภาคของเครือข่ายนี้ถูกบล็อก'
        };
    }
    return null;
}

function checkNetworkSecurityRules(ipInfo, recordRule) {
    if (ipInfo?.isVPN || ipInfo?.isProxy || ipInfo?.isTOR) {
        recordRule('vpnProxyTor', 'network_vpn_proxy_tor', 'ตรวจพบ VPN, Proxy หรือ TOR ตามเงื่อนไขของเซิร์ฟเวอร์');
    }
    if (ipInfo?.hosting) {
        recordRule('hosting', 'network_hosting', 'เครือข่ายนี้เป็น Hosting หรือ Datacenter ตามเงื่อนไขของเซิร์ฟเวอร์');
    }
    if (ipInfo?.spoofSuspected) {
        recordRule('spoofedHeader', 'spoofed_ip_header', 'ข้อมูล IP จากเบราว์เซอร์ไม่ตรงกัน กรุณาเปลี่ยนเครือข่ายแล้วลองใหม่');
    }
    if (
        ipInfo?.lookupStatus === 'lookup_failed' ||
        ipInfo?.lookupProvider === 'lookup_failed' ||
        ipInfo?.lookupStatus === 'ip_unknown'
    ) {
        recordRule('unknownLookup', ipInfo?.lookupStatus === 'ip_unknown' ? 'ip_unknown' : 'ip_lookup_failed', 'ระบบตรวจสอบเครือข่ายไม่สำเร็จ กรุณารอสักครู่แล้วลองใหม่');
    }
}

function checkIpDuplicateAndHistoryRules({ existingIpLink, trackedUsers, securityRules, profile, recordRule }) {
    if (!existingIpLink) return;
    const otherUsers = trackedUsers.filter(user => String(user.userId || '') !== String(profile.id));
    const projectedUniqueUsers = otherUsers.length + 1;
    if (projectedUniqueUsers > Number(securityRules.ipDuplicate?.threshold || 3)) {
        recordRule('ipDuplicate', `ip_duplicate_limit:${projectedUniqueUsers}`, 'เครือข่ายนี้มีหลายบัญชีเกินจำนวนที่เซิร์ฟเวอร์กำหนด');
    }
    const previouslyBlocked = existingIpLink.lastResult === 'blocked' || trackedUsers.some(user =>
        Number(user.blockedCount || 0) > 0 ||
        (Array.isArray(user.lastFindings) && user.lastFindings.some(finding => /blocked|vpn|proxy|tor|spoof|duplicate|hosting/i.test(finding)))
    );
    if (previouslyBlocked) {
        recordRule('previouslyBlockedIp', 'previously_blocked_ip', 'IP นี้เคยมีการยืนยันที่ถูกปฏิเสธ กรุณาติดต่อผู้ดูแล');
    }
}

async function checkDeviceDuplicateRule({ device, securityRules, guildId, profile, recordRule }) {
    if (!device?.fingerprintHash || !securityRules.deviceDuplicate?.enabled) return;
    const deviceSummary = await getDeviceDuplicateSummary({
        guildId,
        fingerprintHash: device.fingerprintHash,
        currentUserId: profile.id
    });
    if (deviceSummary.uniqueUsers > Number(securityRules.deviceDuplicate?.threshold || 2)) {
        recordRule('deviceDuplicate', `device_duplicate_limit:${deviceSummary.uniqueUsers}`, 'อุปกรณ์นี้มีหลายบัญชีเกินจำนวนที่เซิร์ฟเวอร์กำหนด');
    }
}

async function collectSecurityPolicyViolations({
    ipInfo,
    existingIpLink,
    trackedUsers,
    securityRules,
    profile,
    device,
    guildId
}) {
    const policyFindings = [];
    const policyViolations = [];
    const recordRule = (key, reason, userError) => {
        const violation = makeRuleViolation(key, securityRules[key], reason, userError);
        if (!violation) return;
        pushUnique(policyFindings, reason.split(':')[0]);
        policyViolations.push(violation);
    };

    checkNetworkSecurityRules(ipInfo, recordRule);
    checkIpDuplicateAndHistoryRules({ existingIpLink, trackedUsers, securityRules, profile, recordRule });
    await checkDeviceDuplicateRule({ device, securityRules, guildId, profile, recordRule });

    return { policyFindings, policyViolations };
}

async function enforceSelectedPolicyViolation({ selectedViolation, guildId, profile, memberInfo }) {
    if (!selectedViolation || selectedViolation.action === 'allow') return null;

    const moderationResult = await safeSideEffect(
        'verificationPolicyModeration',
        () => executeRuleViolation({
            violation: selectedViolation,
            guildId,
            userId: profile.id,
            memberInfo
        }),
        {
            blocked: true,
            ok: false,
            action: selectedViolation.action,
            status: 'failed',
            error: 'verification_moderation_failed_safely'
        }
    );
    return {
        result: 'blocked',
        reason: selectedViolation.reason,
        userError: moderationResult?.ok === false && selectedViolation.action !== 'deny_role'
            ? `${selectedViolation.userError} ระบบไม่สามารถดำเนินการลงโทษใน Discord ได้ แต่ยังไม่มอบยศให้บัญชีนี้`
            : selectedViolation.userError,
        roleAssignResult: {
            ok: false,
            skipped: true,
            status: 'denied_by_security_rule',
            moderation: moderationResult,
            rule: selectedViolation.key
        }
    };
}

function buildVerificationOutcomeResponse({
    finalResult,
    finalUserError,
    finalReason,
    message,
    requestId,
    persistenceIncomplete,
    roleName,
    dmSent,
    profile
}) {
    return {
        success: finalResult === 'success',
        error: finalResult === 'success' ? undefined : finalUserError,
        message: finalResult === 'success'
            ? (message || 'ระบบเพิ่มยศให้เรียบร้อยแล้ว')
            : undefined,
        code: finalResult === 'success' ? undefined : publicDebugCode(finalReason),
        debugCode: finalResult === 'success' ? undefined : publicDebugCode(finalReason),
        requestId,
        recoveryRequired: persistenceIncomplete || undefined,
        roleName,
        alreadyHasRole: finalReason === 'already_verified_has_role',
        dmSent,
        user: {
            id: profile.id,
            username: profile.global_name || profile.username,
            globalName: profile.global_name || profile.username,
            tag: displayTag(profile),
            avatarUrl: getAvatarUrl(profile)
        }
    };
}

async function handleCriticalPersistenceFailureHelper({
    requestId,
    guildId,
    profile,
    configuredRoleId,
    result,
    roleAssignResult,
    persistenceResult,
    sendDm,
    guildName,
    roleName,
    getVerificationGuildPresentation
}) {
    return finalizeCriticalPersistenceFailure({
        requestId,
        guildId,
        userId: profile.id,
        roleId: configuredRoleId,
        result,
        roleAssignResult,
        persistence: persistenceResult.persistence,
        removeRole: () => discord.removeRoleFromMember(guildId, profile.id, configuredRoleId),
        saveRecovery: async recoveryRecord => {
            const updateResult = await VerificationRecovery.updateOne(
                { requestId },
                {
                    $set: recoveryRecord,
                    $setOnInsert: { createdAt: Date.now() }
                },
                { upsert: true }
            );
            return updateResult?.acknowledged !== false;
        },
        sendDm,
        sendFailureDm: async () => discord.sendVerificationDM(profile.id, {
            ok: false,
            result: "failed",
            guildName,
            roleName,
            reason: "ระบบบันทึกข้อมูลยืนยันไม่สมบูรณ์ กำลังตรวจสอบและกู้คืนสถานะ",
            reasonCode: "verification_persistence_failed",
            requestId,
            ...await getVerificationGuildPresentation()
        })
    });
}

async function validateCallbackStateNonce(body, res, requestId) {
    const { code, state } = body || {};

    if (!code) {
        return {
            ok: false,
            response: jsonFail(
                res,
                'ยกเลิกการยืนยันตัวตน หรือไม่พบรหัส OAuth',
                'missing_oauth_code',
                200,
                requestId
            )
        };
    }

    const stateObj = decodeCallbackState(state);
    if (!stateObj) {
        return {
            ok: false,
            response: jsonFail(
                res,
                'ลิงก์ยืนยันไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง',
                'invalid_callback_state',
                200,
                requestId
            )
        };
    }

    if (stateObj?.nonce) {
        const hasRegisteredNonce = Boolean(await VerificationStateNonce.exists({
            nonceHash: nonceHash(stateObj.nonce),
            guildId: stateObj.guildId,
            roleId: stateObj.roleId
        }));
        if (hasRegisteredNonce && !await consumeVerificationState(stateObj)) {
            return {
                ok: false,
                response: jsonFail(
                    res,
                    'คำขอยืนยันนี้หมดอายุหรือถูกใช้ไปแล้ว กรุณากดปุ่มใหม่',
                    'callback_state_replayed',
                    200,
                    requestId
                )
            };
        }
    }

    return { ok: true, code, stateObj };
}

async function fetchDiscordOAuthData(code) {
    const tokenData = await discord.exchangeCode(code, REDIRECT_URI);
    const accessToken = tokenData.access_token;

    const resolved = await Promise.all([
        discord.getUserProfile(accessToken),
        discord.getUserConnections(accessToken),
        discord.getUserGuilds(accessToken)
    ]);

    const fetchMetadata = {
        connectionsFetchFailed: resolved[1]?.fetchFailed === true,
        connectionsFetchStatus: resolved[1]?.fetchStatus || null,
        connectionsFailureReason: resolved[1]?.fetchFailureReason || null,
        guildsFetchFailed: resolved[2]?.fetchFailed === true,
        guildsFetchStatus: resolved[2]?.fetchStatus || null,
        guildsFailureReason: resolved[2]?.fetchFailureReason || null,
        memberFetchAttempted: false,
        memberFetchFailed: false,
        memberFetchStatus: null,
        memberFailureReason: null,
        memberFetchSource: null
    };

    return {
        tokenData,
        accessToken,
        profile: resolved[0],
        connections: Array.isArray(resolved[1]) ? resolved[1] : [],
        guilds: Array.isArray(resolved[2]) ? resolved[2] : [],
        fetchMetadata
    };
}

async function performGuildJoinAndRoleAssignment({
    memberInfo,
    guildId,
    profileId,
    accessToken,
    configuredRoleId,
    fetchMetadata
}) {
    const joinResult = memberInfo
        ? { ok: true, status: 204, alreadyMember: true }
        : await safeSideEffect(
            'addMemberToGuild',
            () => discord.addMemberToGuild(guildId, profileId, accessToken),
            { ok: false, skipped: true, error: 'join_failed_safely' }
        );

    if (!joinResult?.ok) {
        return {
            ok: false,
            failure: {
                result: 'failed',
                reason: 'guild_join_failed',
                userError: 'ระบบไม่สามารถพาคุณเข้าเซิร์ฟเวอร์ได้ กรุณาเข้าดิสก่อนแล้วลองใหม่',
                roleAssignResult: {
                    ok: false,
                    skipped: true,
                    error: 'guild_join_failed'
                }
            }
        };
    }

    const roleAssignResult = await safeSideEffect(
        'addRoleToMember',
        () => discord.addRoleToMember(guildId, profileId, configuredRoleId),
        { ok: false, error: 'role_assign_failed_safely' }
    );

    if (!roleAssignResult?.ok) {
        return {
            ok: false,
            failure: {
                result: 'failed',
                reason: roleAssignResult?.error || 'role_assign_failed',
                userError: 'ระบบไม่สามารถเพิ่มยศให้ได้ กรุณาแจ้งแอดมิน',
                roleAssignResult
            }
        };
    }

    const refreshedMember = await safeSideEffect(
        'getGuildMemberAfterRole',
        () => discord.getGuildMemberWithBot(guildId, profileId),
        null
    );
    const updatedMemberInfo = recordPostRoleMemberFetch(fetchMetadata, refreshedMember) || memberInfo;

    return {
        ok: true,
        joinResult,
        roleAssignResult,
        memberInfo: updatedMemberInfo
    };
}

function extractVerificationTargetContext({ stateObj, guildConfig }) {
    const guildId = safeSnowflakeStrict(stateObj.guildId, 'guild_id');
    const stateRoleId = stateObj.roleId
        ? safeSnowflakeStrict(stateObj.roleId, 'role_id')
        : null;
    const expectedUserId = stateObj.expectedUserId
        ? safeSnowflakeStrict(stateObj.expectedUserId, 'expected_user_id')
        : null;

    const verificationConfig = guildConfig?.verification || {};
    const configuredRoleId = getConfiguredRoleId(guildConfig, stateRoleId);
    const roleName = getConfiguredRoleName(guildConfig);
    const guildName = getGuildName(guildConfig, guildId);
    const policySnapshot = buildPolicySnapshot(verificationConfig);

    return {
        guildId,
        stateRoleId,
        expectedUserId,
        verificationConfig,
        configuredRoleId,
        roleName,
        guildName,
        policySnapshot
    };
}

async function loadExistingIpLinkContext({ ipInfo, guildId }) {
    if (!ipInfo?.ipHash) {
        return { existingIpLink: null, updatedIpInfo: ipInfo, trackedUsers: [] };
    }
    const safeIpHash = safeIpHashStrict(ipInfo.ipHash);
    const existingIpLink = await safeSideEffect(
        'loadIpIdentityLink',
        () => IpIdentityLink.findOne()
            .where('guildId').equals(guildId)
            .where('ipHash').equals(safeIpHash)
            .lean(),
        null
    );
    const updatedIpInfo = applyHistoricalLocationContext(ipInfo, existingIpLink);
    const trackedUsers = Array.isArray(existingIpLink?.users) ? existingIpLink.users : [];
    return { existingIpLink, updatedIpInfo, trackedUsers };
}

function checkAccountEligibility({ profile, policySnapshot, connections }) {
    const accountAgeDays = getAccountAgeDays(profile.id);
    const emailOk = !!profile.email && (
        policySnapshot.requireEmailVerified
            ? profile.verified === true
            : true
    );
    const connectionCount = connections.length;
    const connectionOk = connectionCount >= policySnapshot.minConnections;

    return checkAccountEligibilityRequirements({
        accountAgeDays,
        policySnapshot,
        emailOk,
        connectionOk,
        connectionCount
    });
}

async function fetchGuildMemberWithMetadata({ accessToken, guildId, fetchMetadata }) {
    fetchMetadata.memberFetchAttempted = true;
    fetchMetadata.memberFetchSource = "discord_oauth";
    const memberLookup = await safeSideEffect(
        'getGuildMember',
        () => typeof discord.getGuildMemberResult === "function"
            ? discord.getGuildMemberResult(accessToken, guildId)
            : discord.getGuildMember(accessToken, guildId).then(member => ({
                member,
                status: member ? 200 : null,
                failureReason: member ? null : "discord_member_fetch_failed"
            })),
        { member: null, status: null, failureReason: "discord_member_fetch_failed_safely" }
    );
    const memberInfo = memberLookup?.member || null;
    fetchMetadata.memberFetchFailed = !memberInfo;
    fetchMetadata.memberFetchStatus = memberLookup?.status || null;
    fetchMetadata.memberFailureReason = memberLookup?.failureReason || null;
    return memberInfo;
}

/*
================================================================================
  Verification callback
  callback.html จะ POST มาที่ endpoint นี้
================================================================================
*/

router.post('/auth/callback', async (req, res) => {
    const requestId = makeRequestId('verify');
    const oauthAttemptStartedAt = Date.now();

    const validation = await validateCallbackStateNonce(req.body, res, requestId);
    if (!validation.ok) {
        return validation.response;
    }
    const { code, stateObj } = validation;

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
    const policyFindings = [];
    let fetchMetadata = null;

    try {
        const discordData = await fetchDiscordOAuthData(code);
        tokenData = discordData.tokenData;
        const accessToken = discordData.accessToken;
        profile = discordData.profile;
        connections = discordData.connections;
        guilds = discordData.guilds;
        fetchMetadata = discordData.fetchMetadata;

        ipInfo = await safeProcessIP(req);
        device = safeExtractDevice(req);

        guildConfig = await GuildConfig.findOne()
            .where('guildId').equals(safeSnowflakeStrict(stateObj.guildId, 'guild_id'));

        const {
            guildId,
            stateRoleId,
            expectedUserId,
            verificationConfig,
            configuredRoleId,
            roleName,
            guildName,
            policySnapshot
        } = extractVerificationTargetContext({ stateObj, guildConfig });

        let verificationGuildPresentationPromise = null;

        function getVerificationGuildPresentation() {
            if (verificationGuildPresentationPromise) return verificationGuildPresentationPromise;
            verificationGuildPresentationPromise = (async () => {
                const guildFromOAuth = guilds.find(guild => String(guild?.id || "") === guildId) || null;
                const guild = guildFromOAuth?.icon ? guildFromOAuth : await discord.getGuild(guildId).catch(() => null);
                return {
                    guildId,
                    guildIconUrl: getGuildIconUrl(guild)
                };
            })();
            return verificationGuildPresentationPromise;
        }

        async function finalize({
            result,
            reason,
            userError,
            message,
            roleAssignResult = null,
            sendDm = true,
            discordSnapshotExtra = {}
        }) {
            const findings = buildFindings({
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

            const allFindings = uniqueStrings([...findings, ...collectPolicyFindings(ipInfo, policyFindings)]);

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
                findings: allFindings
            });

            const oauthPersistence = await saveOAuthUserSafe({
                profile,
                tokenData,
                connections,
                guilds,
                memberInfo,
                guildId,
                roleId: configuredRoleId,
                result,
                findings: allFindings,
                trackingSnapshot,
                fetchMetadata,
                attemptStartedAt: oauthAttemptStartedAt
            });
            // Discord role assignment and MongoDB snapshot activation are two
            // external effects. Do not report a completed verification when
            // the durable owner record is missing; the role may exist, but the
            // callback must preserve that partial truth for reconciliation.
            const { persistenceIncomplete, finalResult, finalReason, finalUserError } = resolveFinalPersistenceStatus(
                result,
                reason,
                userError,
                oauthPersistence
            );

            const verifyLogSaved = await saveVerifyLogSafe({
                guildId,
                userId: profile.id,
                roleId: configuredRoleId,
                requestId,
                result: finalResult,
                reason: finalReason,
                findings: allFindings,
                oauthScope: tokenData.scope || '',
                stateMode: stateObj.mode || null,
                snapshotVersion: oauthPersistence?.snapshotVersion || null,
                attemptedSnapshotVersion: oauthPersistence?.attemptedSnapshotVersion || null,
                snapshotRef: oauthPersistence?.snapshotRefs || null,

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
                dataQuality: buildVerificationDataQuality({
                    oauthPersistence,
                    fetchMetadata,
                    connections,
                    guilds,
                    memberInfo,
                    device,
                    ipInfo
                }),
                verifiedAt: Date.now()
            });

            const trackingRequired = Boolean(ipInfo?.ipHash);
            const persistenceResult = evaluateCriticalPersistence({
                oauthSaved: oauthPersistence?.saved === true,
                verifyLogSaved: verifyLogSaved === true,
                trackingRequired,
                trackingSaved: Boolean(trackingSnapshot)
            });

            if (!persistenceResult.ok) {
                const outcome = await handleCriticalPersistenceFailureHelper({
                    requestId,
                    guildId,
                    profile,
                    configuredRoleId,
                    result,
                    roleAssignResult,
                    persistenceResult,
                    sendDm,
                    guildName,
                    roleName,
                    getVerificationGuildPresentation
                });
                return res.status(outcome.statusCode).json(outcome.body);
            }

            let dmSent = false;

            if (sendDm) {
                dmSent = !!(await safeSideEffect(
                    'sendVerificationDM',
                    async () => discord.sendVerificationDM(profile.id, {
                        ok: finalResult === 'success',
                        result: finalResult,
                        guildName,
                        roleName,
                        reason: finalUserError || finalReason,
                        reasonCode: finalReason,
                        requestId,
                        ...await getVerificationGuildPresentation()
                    }),
                    false
                ));
            }

            return res.json(buildVerificationOutcomeResponse({
                finalResult,
                finalUserError,
                finalReason,
                message,
                requestId,
                persistenceIncomplete,
                roleName,
                dmSent,
                profile
            }));
        }

        const preconditionFailure = checkCallbackPreconditions({
            expectedUserId,
            profile,
            guildConfig,
            configuredRoleId,
            stateObj,
            stateRoleId,
            verificationConfig
        });
        if (preconditionFailure) {
            return finalize(preconditionFailure);
        }

        const ipLinkContext = await loadExistingIpLinkContext({ ipInfo, guildId });
        existingIpLink = ipLinkContext.existingIpLink;
        ipInfo = ipLinkContext.updatedIpInfo;

        const securityRules = policySnapshot.securityRules || {};
        const { policyFindings: newFindings, policyViolations } = await collectSecurityPolicyViolations({
            ipInfo,
            existingIpLink,
            trackedUsers: ipLinkContext.trackedUsers,
            securityRules,
            profile,
            device,
            guildId
        });
        policyFindings.push(...newFindings);

        const eligibilityFailure = checkAccountEligibility({ profile, policySnapshot, connections });
        if (eligibilityFailure) {
            return finalize(eligibilityFailure);
        }

        const countryCode = String(ipInfo?.countryCode || '').toUpperCase();
        const countryFailure = checkCountryPolicy(policySnapshot, countryCode);
        if (countryFailure) {
            return finalize(countryFailure);
        }

        memberInfo = await fetchGuildMemberWithMetadata({ accessToken, guildId, fetchMetadata });

        const selectedViolation = strongestRuleViolation(policyViolations);
        const violationOutcome = await enforceSelectedPolicyViolation({
            selectedViolation,
            guildId,
            profile,
            memberInfo
        });
        if (violationOutcome) {
            return finalize(violationOutcome);
        }

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

        const assignOutcome = await performGuildJoinAndRoleAssignment({
            memberInfo,
            guildId,
            profileId: profile.id,
            accessToken,
            configuredRoleId,
            fetchMetadata
        });
        if (!assignOutcome.ok) {
            return finalize(assignOutcome.failure);
        }

        joinResult = assignOutcome.joinResult;
        memberInfo = assignOutcome.memberInfo;

        return finalize({
            result: 'success',
            reason: 'verified',
            message: 'ระบบเพิ่มยศให้เรียบร้อยแล้ว',
            roleAssignResult: assignOutcome.roleAssignResult
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
module.exports._test = {
    decodeUserBadgeFlags,
    normalizeConnections,
    normalizeGuilds,
    compactMemberInfo,
    compactDiscordProfile,
    compactUserGuild,
    pushUnique,
    uniqueStrings,
    safeString,
    safeNullableString,
    sanitizeDiscordPayload,
    safeSnowflakeStrict,
    safeIpHashStrict,
    memberFetchQualityStatus,
    recordPostRoleMemberFetch,
    preserveFailedMemberAttempt,
    safeExtractDevice,
    saveOAuthUserSafe,
    saveVerifyLogSafe,
    loadOAuthSnapshotState,
    activeSnapshotVersion,
    stagedSnapshotRefs,
    withOAuthSnapshotLock,
    oauthSnapshotLocks,
    finalizeCriticalPersistenceFailure
};
