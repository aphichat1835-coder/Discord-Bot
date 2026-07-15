"use strict";

const {
    safeDevice,
    safeDiscordSnapshot,
    safeIpInfo,
    safeMemberSnapshot,
    safeTrackingSnapshot,
    buildVerifyLogCommon,
    buildVerifyLogParts
} = require("../utils/verificationSnapshots");

function tokenStatus(token = {}) {
    return {
        hasAccessToken: !!token.encryptedAccessToken,
        hasRefreshToken: !!token.encryptedRefreshToken,
        scope: token.scope || "",
        tokenType: token.tokenType || "",
        expiresAt: token.expiresAt || null,
        lastRefreshAt: token.lastRefreshAt || null,
        refreshFailCount: Number(token.refreshFailCount || 0),
        lastRefreshError: token.lastRefreshError || null,
        revokedAt: token.revokedAt || null
    };
}

function oauthUserDiscord(user = {}, canViewSensitive = false) {
    const discord = user.discord || {};
    return safeDiscordSnapshot({
        ...discord,
        connections: Array.isArray(user.connections) ? user.connections : [],
        guilds: Array.isArray(user.guilds) ? user.guilds : []
    }, canViewSensitive);
}

function latestLogSummary(log = {}, canViewSensitive = false) {
    if (!log) return null;
    const parts = buildVerifyLogParts(log, canViewSensitive);
    return {
        ...buildVerifyLogCommon(parts, { canViewSensitive, defaultResult: log.result || "" }),
        joinResult: log.joinResult || null,
        roleAssignResult: log.roleAssignResult || null,
        requestId: log.requestId || "",
        verifiedAt: log.verifiedAt || log.createdAt || null,
        createdAt: log.createdAt || log.verifiedAt || null
    };
}

function buildIdentity({ oauth, log, userId, oauthDiscord, logDiscord }) {
    return {
        ...logDiscord,
        ...oauthDiscord,
        userId: oauth.discord?.userId || log?.userId || userId || null,
        username: oauth.discord?.username || logDiscord.username || "",
        discriminator: oauth.discord?.discriminator || logDiscord.discriminator || null,
        globalName: oauth.discord?.globalName || logDiscord.globalName || null,
        displayTag: oauth.discord?.displayTag || logDiscord.displayTag || null
    };
}

function buildAccount(identity = {}) {
    return {
        email: identity.email ?? null,
        emailVerified: identity.emailVerified === true,
        locale: identity.locale || "",
        mfaEnabled: identity.mfaEnabled === true,
        premiumType: identity.premiumType ?? 0,
        flags: identity.flags ?? 0,
        publicFlags: identity.publicFlags ?? 0,
        badgeFlags: Array.isArray(identity.badgeFlags) ? identity.badgeFlags : [],
        accountCreatedAt: identity.accountCreatedAt ?? null,
        accountAgeDays: identity.accountAgeDays ?? null
    };
}

function buildSource(oauth = {}, log = null) {
    return {
        hasOAuthUser: !!oauth.discord?.userId,
        hasVerifyLog: !!log,
        latestLogId: log?._id ? String(log._id) : null
    };
}

function buildTracking(log = null, oauth = {}) {
    return {
        ...safeTrackingSnapshot(log?.trackingSnapshot),
        ...oauth.lastIpTracking
    };
}

function buildVerification(oauth = {}, logSummary = null) {
    return {
        latest: logSummary,
        lastVerify: oauth.lastVerify || null,
        snapshotMeta: oauth.snapshotMeta || null
    };
}

function buildOAuthTokenStatuses(oauth = {}, canViewSensitive = false) {
    if (!canViewSensitive) return { oauth: null, adminOAuth: null };
    return {
        oauth: tokenStatus(oauth.oauth || {}),
        adminOAuth: tokenStatus(oauth.adminOAuth || {})
    };
}

function resolveTargetMember(oauth = {}, log = null) {
    if (oauth.snapshotRefs?.member?.complete === true && oauth.lastMember) {
        return oauth.lastMember;
    }
    if (log) {
        return log.memberSnapshot || log.discordSnapshot?.member || {};
    }
    return oauth.lastMember || {};
}

function buildRawSnapshots(oauth = {}, targetMember = {}, canViewSensitive = false) {
    if (!canViewSensitive) return null;
    return {
        profile: oauth.profileSnapshotRaw || oauth.discord?.profileSnapshot || null,
        member: targetMember.snapshot || null
    };
}

function serializeMemberDetail({ guildId, userId, oauthUser = null, latestLog = null, canViewSensitive = false } = {}) {
    const oauth = oauthUser?.toObject ? oauthUser.toObject() : oauthUser || {};
    const log = latestLog?.toObject ? latestLog.toObject() : latestLog || null;
    const oauthDiscord = oauthUserDiscord(oauth, canViewSensitive);
    const logSummary = latestLogSummary(log, canViewSensitive);
    const logDiscord = log ? safeDiscordSnapshot(log.discordSnapshot || {}, canViewSensitive) : {};
    const identity = buildIdentity({ oauth, log, userId, oauthDiscord, logDiscord });
    const targetMember = resolveTargetMember(oauth, log);

    return {
        success: true,
        guildId,
        userId: identity.userId,
        sensitiveRedacted: canViewSensitive !== true,
        source: buildSource(oauth, log),
        identity,
        account: buildAccount(identity),
        guilds: Array.isArray(oauthDiscord.guilds) ? oauthDiscord.guilds : [],
        connections: Array.isArray(oauthDiscord.connections) ? oauthDiscord.connections : [],
        targetMember: safeMemberSnapshot(targetMember),
        device: log ? safeDevice(log.device || {}) : {},
        network: log ? safeIpInfo(log.ipInfo || {}) : {},
        tracking: buildTracking(log, oauth),
        verification: buildVerification(oauth, logSummary),
        oauthTokens: buildOAuthTokenStatuses(oauth, canViewSensitive),
        rawSnapshots: buildRawSnapshots(oauth, targetMember, canViewSensitive)
    };
}

module.exports = {
    serializeMemberDetail,
    tokenStatus,
    _test: {
        buildIdentity,
        buildAccount,
        buildSource,
        buildTracking,
        buildVerification,
        buildOAuthTokenStatuses,
        resolveTargetMember,
        buildRawSnapshots
    }
};
