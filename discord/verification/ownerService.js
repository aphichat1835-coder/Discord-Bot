"use strict";

const GuildConfig = require("./models/GuildConfig");
const VerifyLog = require("./models/VerifyLog");
const OAuthUser = require("./models/OAuthUser");
const { decryptIP, decryptToken } = require("./utils/crypto");
const { serializeMemberDetail } = require("./serializers/memberDetailSerializer");
const verifiedMemberService = require("./services/verifiedMemberService");
const snapshotStore = require("./services/oauthSnapshotStore");
const ipIdentityHistory = require("./services/ipIdentityHistoryService");

const OVERVIEW_MAX = Math.max(
    50,
    Number(process.env.INTERNAL_OVERVIEW_GUILDS_MAX || 500) || 500
);

function baseFilter(guildId) {
    return { guildId, deletedAt: { $exists: false } };
}

function emptyStats() {
    return {
        total: 0,
        success: 0,
        blocked: 0,
        failed: 0,
        vpn: 0,
        proxy: 0,
        tor: 0,
        hosting: 0,
        reviewRequired: 0,
        lookupFailed: 0,
        panelRevisionMismatch: 0,
        lastAt: null,
        pendingReveal: 0,
        successRate: 0
    };
}

function statsGroup() {
    return {
        _id: "$guildId",
        total: { $sum: 1 },
        success: { $sum: { $cond: [{ $eq: ["$result", "success"] }, 1, 0] } },
        blocked: { $sum: { $cond: [{ $eq: ["$result", "blocked"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$result", "failed"] }, 1, 0] } },
        vpn: { $sum: { $cond: [{ $eq: ["$ipInfo.isVPN", true] }, 1, 0] } },
        proxy: { $sum: { $cond: [{ $eq: ["$ipInfo.isProxy", true] }, 1, 0] } },
        tor: { $sum: { $cond: [{ $eq: ["$ipInfo.isTOR", true] }, 1, 0] } },
        hosting: { $sum: { $cond: [{ $eq: ["$ipInfo.hosting", true] }, 1, 0] } },
        reviewRequired: {
            $sum: {
                $cond: [
                    { $gt: [{ $size: { $ifNull: ["$findings", []] } }, 0] },
                    1,
                    0
                ]
            }
        },
        lookupFailed: {
            $sum: {
                $cond: [
                    { $in: ["$ipInfo.lookupStatus", ["lookup_failed", "ip_unknown"]] },
                    1,
                    0
                ]
            }
        },
        panelRevisionMismatch: {
            $sum: { $cond: [{ $eq: ["$reason", "panel_revision_mismatch"] }, 1, 0] }
        },
        lastAt: { $max: "$verifiedAt" }
    };
}

function safeRecent(log) {
    return {
        id: String(log._id || ""),
        requestId: log.requestId || "",
        userId: log.userId,
        roleId: log.roleId || null,
        result: log.result,
        reason: log.reason || "",
        findings: Array.isArray(log.findings) ? log.findings : [],
        roleResult: log.roleAssignResult || null,
        country: log.ipInfo?.country || null,
        countryCode: log.ipInfo?.countryCode || null,
        city: log.ipInfo?.city || null,
        isp: log.ipInfo?.isp || null,
        isVPN: !!log.ipInfo?.isVPN,
        isProxy: !!log.ipInfo?.isProxy,
        isTOR: !!log.ipInfo?.isTOR,
        hosting: !!log.ipInfo?.hosting,
        browser: log.device?.browser || null,
        os: log.device?.os || null,
        platform: log.device?.platform || null,
        verifiedAt: log.verifiedAt || log.createdAt || null
    };
}

async function getOverview({ enabled = "all" } = {}) {
    const showAll = String(enabled).toLowerCase() === "all";
    const configs = await GuildConfig.find(showAll ? {} : { "verification.enabled": true })
        .select("guildId guildName updatedAt verification security")
        .sort({ updatedAt: -1, _id: -1 })
        .limit(OVERVIEW_MAX)
        .lean();
    const guildIds = configs.map(item => item.guildId);
    const stats = guildIds.length
        ? await VerifyLog.aggregate([
            { $match: { guildId: { $in: guildIds }, deletedAt: { $exists: false } } },
            { $group: statsGroup() }
        ])
        : [];
    const statsMap = Object.fromEntries(stats.map(item => [item._id, item]));
    const guilds = configs.map(config => ({
        guildId: config.guildId,
        guildName: config.guildName || "Unknown",
        verification: config.verification || {},
        security: config.security || {},
        stats: statsMap[config.guildId] || emptyStats()
    }));
    return {
        success: true,
        guilds,
        total: guilds.length,
        truncated: guilds.length >= OVERVIEW_MAX,
        maxGuilds: OVERVIEW_MAX,
        showAll
    };
}

async function getGuildStats(guildId) {
    const filter = baseFilter(guildId);
    const [config, counts, recent] = await Promise.all([
        GuildConfig.findOne({ guildId }).lean(),
        VerifyLog.aggregate([
            { $match: filter },
            { $group: { ...statsGroup(), _id: null } }
        ]),
        VerifyLog.find(filter)
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .limit(10)
            .lean()
    ]);
    const stats = counts[0] || emptyStats();
    stats.successRate = stats.total > 0
        ? Math.round((Number(stats.success || 0) / Number(stats.total)) * 100)
        : 0;
    stats.pendingReveal = Number(stats.pendingReveal || 0);
    return {
        success: true,
        config,
        stats,
        recent: recent.map(safeRecent)
    };
}

async function getGuildMembers(guildId, { page = 0, limit = 20, q = "" } = {}) {
    const safePage = Math.max(0, Number.parseInt(page, 10) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const result = await verifiedMemberService.listVerifiedMembers(guildId, {
        page: safePage,
        limit: safeLimit,
        q: String(q || "").trim().slice(0, 120),
        includeLegacy: true,
        canViewSensitive: false
    });
    const members = result.members.map(member => ({ ...member, detailsAvailable: true }));
    return {
        success: true,
        members,
        page: safePage,
        limit: safeLimit,
        total: result.total,
        totalApproximate: result.totalApproximate === true,
        truncated: result.truncated === true,
        scanLimit: result.scanLimit,
        hasMore: result.hasMore
    };
}

async function revealRawIp({ guildId, userId }) {

    const log = await VerifyLog.findOne({
        ...baseFilter(guildId),
        userId,
        "ipInfo.encryptedRawIp": { $exists: true, $ne: "" }
    }).sort({ verifiedAt: -1, createdAt: -1, _id: -1 });
    if (!log?.ipInfo?.encryptedRawIp) {
        const error = new Error("encrypted IP not found");
        error.code = "ip_not_found";
        throw error;
    }

    const rawIp = decryptIP(log.ipInfo.encryptedRawIp);
    if (!rawIp) {
        const error = new Error("encrypted IP could not be decrypted");
        error.code = "ip_decrypt_failed";
        throw error;
    }
    return {
        success: true,
        guildId,
        userId,
        verifyLogId: String(log._id),
        rawIp,
        ipInfo: {
            country: log.ipInfo.country || null,
            countryCode: log.ipInfo.countryCode || null,
            city: log.ipInfo.city || null,
            isp: log.ipInfo.isp || null,
            isVPN: !!log.ipInfo.isVPN,
            isProxy: !!log.ipInfo.isProxy,
            isTOR: !!log.ipInfo.isTOR,
            hosting: !!log.ipInfo.hosting
        }
    };
}

async function getMemberDetail(guildId, userId, { canViewSensitive = false } = {}) {
    const [oauthUser, latestLog, historyLogs] = await Promise.all([
        OAuthUser.findOne({ "discord.userId": userId })
            .select({
                discord: 1,
                connections: 1,
                guilds: 1,
                lastMember: 1,
                lastVerify: 1,
                lastIpTracking: 1,
                snapshotMeta: 1,
                snapshotRefs: 1,
                oauth: 1,
                adminOAuth: 1,
                createdAt: 1,
                updatedAt: 1
            })
            .lean(),
        VerifyLog.findOne({ ...baseFilter(guildId), userId })
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .lean(),
        VerifyLog.find({ ...baseFilter(guildId), userId })
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .limit(100)
            .lean()
    ]);

    if (!oauthUser && !latestLog) {
        const error = new Error("member detail not found");
        error.code = "member_not_found";
        throw error;
    }

    let hydratedOAuthUser = oauthUser;
    const snapshotRefs = {
        ...((oauthUser?.snapshotRefs && typeof oauthUser.snapshotRefs === "object") ? oauthUser.snapshotRefs : {}),
        ...((latestLog?.snapshotRef && typeof latestLog.snapshotRef === "object") ? latestLog.snapshotRef : {})
    };
    if (Object.keys(snapshotRefs).length) {
        const chunks = await snapshotStore.loadOAuthSnapshots({
            userId: oauthUser?.discord?.userId || latestLog?.userId || userId,
            refs: snapshotRefs,
            guildId
        });
        hydratedOAuthUser = {
            ...oauthUser,
            snapshotRefs,
            profileSnapshotRaw: chunks.profile || oauthUser?.profileSnapshotRaw,
            connections: Array.isArray(chunks.connections) ? chunks.connections : oauthUser?.connections,
            guilds: Array.isArray(chunks.guilds) ? chunks.guilds : oauthUser?.guilds,
            lastMember: chunks.member || oauthUser?.lastMember
        };
    }

    return {
      ...serializeMemberDetail({
        guildId,
        userId,
        oauthUser: hydratedOAuthUser,
        latestLog,
        canViewSensitive
      }),
      history: historyLogs.map(safeRecent),
      historyTruncated: historyLogs.length >= 100
    };
}

function revealTokenState(token = {}) {
    return {
        accessToken: token.encryptedAccessToken ? decryptToken(token.encryptedAccessToken) : null,
        refreshToken: token.encryptedRefreshToken ? decryptToken(token.encryptedRefreshToken) : null,
        scope: token.scope || "",
        tokenType: token.tokenType || "",
        expiresAt: token.expiresAt || null,
        lastRefreshAt: token.lastRefreshAt || null,
        refreshFailCount: Number(token.refreshFailCount || 0),
        revokedAt: token.revokedAt || null
    };
}

function ownerIpLocation(link = {}) {
    return {
        country: link.lastCountry || null,
        countryCode: link.lastCountryCode || null,
        region: link.lastRegion || null,
        city: link.lastCity || null,
        timezone: link.lastTimezone || null,
        isp: link.lastIsp || null,
        org: link.lastOrg || null,
        as: link.lastAs || null,
        asname: link.lastAsname || null
    };
}

function ownerIpSignals(link = {}) {
    return {
        isVPN: link.isVPN === true,
        isProxy: link.isProxy === true,
        isTOR: link.isTOR === true,
        hosting: link.hosting === true,
        mobile: link.mobile === true
    };
}

function ownerIpSummary(link = {}) {
    return {
        firstSeenAt: link.firstSeenAt || null,
        lastSeenAt: link.lastSeenAt || null,
        totalVerifications: Number(link.totalVerifications || 0),
        uniqueUsers: Number(link.uniqueUsers || 0),
        lastResult: link.lastResult || null,
        lastRoleId: link.lastRoleId || null,
        lastIpInfo: link.lastIpInfo || null,
        lastDevice: link.lastDevice || null
    };
}

function ownerIpIdentityDetail(link = null, history = null) {
    if (!link) return null;
    const users = history?.users?.items || (Array.isArray(link.users) ? link.users : []);
    const devices = history?.devices?.items ||
        (Array.isArray(link.deviceFingerprints) ? link.deviceFingerprints : []);
    const roles = history?.roles?.items ||
        (Array.isArray(link.roleSnapshots) ? link.roleSnapshots : []);
    return {
        ...ownerIpSummary(link),
        location: ownerIpLocation(link),
        signals: ownerIpSignals(link),
        lastFindings: Array.isArray(link.lastFindings) ? link.lastFindings : [],
        users,
        deviceFingerprints: devices,
        roleSnapshots: roles,
        pagination: history ? {
            users: { ...history.users, items: undefined },
            devices: { ...history.devices, items: undefined },
            roles: { ...history.roles, items: undefined }
        } : null,
        canonicalHistory: !!history
    };
}

async function getOwnerIpHistoryPage({ guildId, userId, kind, page, limit }) {
    const link = await ipIdentityHistory.findLinkForUser(guildId, userId);
    if (!link?.ipHash) {
        const error = new Error("IP identity history not found");
        error.code = "ip_history_not_found";
        throw error;
    }
    const result = await ipIdentityHistory.loadHistoryPage({
        guildId,
        ipHash: link.ipHash,
        kind,
        page,
        limit
    });
    return { success: true, guildId, userId, ...result };
}

async function revealOAuthTokens({ guildId, userId }) {
    const user = await OAuthUser.findOne({ "discord.userId": userId })
        .select("discord.userId oauth adminOAuth")
        .lean();

    if (!user?.discord?.userId) {
        const error = new Error("OAuth user not found");
        error.code = "member_not_found";
        throw error;
    }

    return {
        success: true,
        guildId,
        userId,
        oauth: revealTokenState(user.oauth || {}),
        adminOAuth: revealTokenState(user.adminOAuth || {})
    };
}

async function getOwnerFullMemberDetail({ guildId, userId }) {
    const [detail, user, log, identityLink] = await Promise.all([
        getMemberDetail(guildId, userId, { canViewSensitive: true }),
        OAuthUser.findOne({ "discord.userId": userId })
            .select("discord.userId oauth adminOAuth")
            .lean(),
        VerifyLog.findOne({
            ...baseFilter(guildId),
            userId,
            "ipInfo.encryptedRawIp": { $exists: true, $ne: "" }
        }).sort({ verifiedAt: -1, createdAt: -1, _id: -1 }),
        ipIdentityHistory.findLinkForUser(guildId, userId)
    ]);
    const history = identityLink?.ipHash
        ? await ipIdentityHistory.loadInitialHistory({ guildId, ipHash: identityLink.ipHash })
        : null;
    return {
        ...detail,
        sensitive: {
            rawIp: decryptIP(log?.ipInfo?.encryptedRawIp || identityLink?.encryptedRawIp || ""),
            oauth: revealTokenState(user?.oauth || {}),
            adminOAuth: revealTokenState(user?.adminOAuth || {}),
            ipIdentity: ownerIpIdentityDetail(identityLink, history)
        }
    };
}

module.exports = {
    getOverview,
    getGuildStats,
    getGuildMembers,
    revealRawIp,
    getMemberDetail,
    revealOAuthTokens,
    getOwnerFullMemberDetail,
    getOwnerIpHistoryPage,
    ownerIpIdentityDetail,
    emptyStats,
    safeRecent
};
