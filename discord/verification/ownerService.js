"use strict";

const GuildConfig = require("./models/GuildConfig");
const VerifyLog = require("./models/VerifyLog");
const OAuthUser = require("./models/OAuthUser");
const { decryptIP } = require("./utils/crypto");
const oauthTokenManager = require("../core/oauthTokenManager");
const { serializeMemberDetail } = require("./serializers/memberDetailSerializer");
const verifiedMemberService = require("./services/verifiedMemberService");
const snapshotStore = require("./services/oauthSnapshotStore");
const ipIdentityHistory = require("./services/ipIdentityHistoryService");
const discordAPI = require("./utils/discordAPI");
const { readFiniteInteger } = require("../core/numbers");

const OVERVIEW_MAX = readFiniteInteger(process.env.INTERNAL_OVERVIEW_GUILDS_MAX, { fallback: 500, min: 50, max: 5000 });
const OAUTH_RECOVERY_SCAN_MAX = readFiniteInteger(process.env.OAUTH_RECOVERY_SCAN_MAX, { fallback: 1000, min: 100, max: 5000 });
const REQUIRED_USER_SCOPES = Object.freeze([
    "identify", "email", "connections", "guilds", "guilds.members.read", "guilds.join"
]);
const SNOWFLAKE_RE = /^\d{17,22}$/;

function requireSnowflake(value, field = "Discord ID") {
    const normalized = String(value || "").trim();
    if (SNOWFLAKE_RE.test(normalized)) return normalized;
    const error = new Error(`${field} is invalid`);
    error.code = "invalid_snowflake";
    throw error;
}

function baseFilter(guildId) {
    return { guildId, deletedAt: { $exists: false } };
}

function scopedGuildUserQuery(query, guildId, userId) {
    return query
        .where("guildId").equals(guildId)
        .where("userId").equals(userId)
        .where("deletedAt").exists(false);
}

function scopedOAuthUserQuery(query, guildId, userId, requireLegacyAssociation = false) {
    const scoped = query
        .where("discord.userId").equals(userId)
        .where("deletedAt").exists(false);
    if (!requireLegacyAssociation) return scoped;
    return scoped
        .where("lastVerify.guildId").equals(guildId)
        .where("lastVerify.result").equals("success");
}

function memberNotFoundError() {
    const error = new Error("member detail not found");
    error.code = "member_not_found";
    return error;
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

function extractLogIpInfo(ipInfo = {}) {
    return {
        country: ipInfo.country ?? null,
        countryCode: ipInfo.countryCode ?? null,
        city: ipInfo.city ?? null,
        isp: ipInfo.isp ?? null,
        isVPN: Boolean(ipInfo.isVPN),
        isProxy: Boolean(ipInfo.isProxy),
        isTOR: Boolean(ipInfo.isTOR),
        hosting: Boolean(ipInfo.hosting)
    };
}

function extractLogDevice(device = {}) {
    return {
        browser: device.browser ?? null,
        os: device.os ?? null,
        platform: device.platform ?? null
    };
}

function safeRecent(log) {
    const ip = extractLogIpInfo(log.ipInfo || {});
    const dev = extractLogDevice(log.device || {});
    return {
        id: String(log._id ?? ""),
        requestId: log.requestId ?? "",
        userId: log.userId,
        roleId: log.roleId ?? null,
        result: log.result,
        reason: log.reason ?? "",
        findings: Array.isArray(log.findings) ? log.findings : [],
        roleResult: log.roleAssignResult ?? null,
        ...ip,
        ...dev,
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
        canViewSensitive: true
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

async function getMemberDetail(guildId, userId, { canViewSensitive = false } = {}) {
    const safeGuildId = requireSnowflake(guildId, "Guild ID");
    const safeUserId = requireSnowflake(userId, "User ID");
    const latestLog = await scopedGuildUserQuery(VerifyLog.findOne(), safeGuildId, safeUserId)
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .lean();
    const [oauthUser, historyLogs] = await Promise.all([
        scopedOAuthUserQuery(OAuthUser.findOne(), safeGuildId, safeUserId, !latestLog)
            .select({
                discord: 1,
                connections: 1,
                guilds: 1,
                lastMember: 1,
                lastVerify: 1,
                lastIpTracking: 1,
                snapshotMeta: 1,
                snapshotRefs: 1,
                createdAt: 1,
                updatedAt: 1
            })
            .lean(),
        scopedGuildUserQuery(VerifyLog.find(), safeGuildId, safeUserId)
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .limit(100)
            .lean()
    ]);

    if (!oauthUser && !latestLog) throw memberNotFoundError();

    const tokenStatuses = canViewSensitive
        ? await oauthTokenManager.getOwnerTokenMetadata(safeUserId)
        : null;

    let hydratedOAuthUser = oauthUser;
    const snapshotRefs = {
        ...((oauthUser?.snapshotRefs && typeof oauthUser.snapshotRefs === "object") ? oauthUser.snapshotRefs : {}),
        ...((latestLog?.snapshotRef && typeof latestLog.snapshotRef === "object") ? latestLog.snapshotRef : {})
    };
    if (Object.keys(snapshotRefs).length) {
        const chunks = await snapshotStore.loadOAuthSnapshots({
            userId: oauthUser?.discord?.userId || latestLog?.userId || userId,
            refs: snapshotRefs,
            guildId: safeGuildId
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
        guildId: safeGuildId,
        userId: safeUserId,
        oauthUser: hydratedOAuthUser,
        latestLog,
        canViewSensitive,
        tokenStatuses
      }),
      history: historyLogs.map(safeRecent),
      historyTruncated: historyLogs.length >= 100
    };
}

function tokenRecoveryReasons(token = {}, now = Date.now(), ...args) {
    return oauthTokenManager.tokenRecoveryReasons(token, now, ...args);
}

function recoveryReasonLabel(reason) {
    return oauthTokenManager.recoveryReasonLabel(reason);
}

async function getOAuthRecoveryCenter(guildId) {
    const safeGuildId = requireSnowflake(guildId, "Guild ID");
    const [config, recipients] = await Promise.all([
        GuildConfig.findOne({ guildId: safeGuildId }).select("verification.roleId").lean(),
        VerifyLog.aggregate([
            { $match: { ...baseFilter(safeGuildId), result: "success" } },
            { $sort: { verifiedAt: -1, createdAt: -1, _id: -1 } },
            { $group: { _id: "$userId", roleId: { $first: "$roleId" }, verifiedAt: { $first: "$verifiedAt" } } },
            { $limit: OAUTH_RECOVERY_SCAN_MAX }
        ])
    ]);
    const userIds = recipients.map(item => String(item._id || "")).filter(Boolean);
    const [recoveryMap, oauthUsers] = await Promise.all([
        oauthTokenManager.getRecoveryStatuses(userIds),
        userIds.length ? OAuthUser.find({
            "discord.userId": { $in: userIds },
            $or: [
                { deletedAt: { $exists: false } },
                { deletedAt: null }
            ]
        })
            .select("discord.userId discord.username discord.globalName discord.displayTag discord.avatarUrl")
            .lean() : []
    ]);
    const userMap = new Map(oauthUsers.map(item => [String(item.discord?.userId || ""), item]));
    const defaultRoleId = config?.verification?.roleId || null;
    const members = [];
    for (const recipient of recipients) {
        const userId = String(recipient._id || "");
        const recovery = recoveryMap.get(userId);
        if (!recovery || !recovery.reasons || !recovery.reasons.length) continue;
        const oauthUser = userMap.get(userId);
        members.push({
            userId,
            username: oauthUser?.discord?.username || null,
            globalName: oauthUser?.discord?.globalName || null,
            displayTag: oauthUser?.discord?.displayTag || null,
            avatarUrl: oauthUser?.discord?.avatarUrl || null,
            roleId: recipient.roleId || defaultRoleId,
            lastVerifiedAt: recipient.verifiedAt || null,
            reasons: recovery.reasons,
            reasonLabels: recovery.reasonLabels
        });
    }
    return {
        success: true,
        guildId: safeGuildId,
        configuredRoleId: defaultRoleId,
        scanned: recipients.length,
        scanMax: OAUTH_RECOVERY_SCAN_MAX,
        truncated: recipients.length >= OAUTH_RECOVERY_SCAN_MAX,
        count: members.length,
        members
    };
}

async function revokeRecoveryMemberRole({ guildId, userId }) {
    const safeGuildId = requireSnowflake(guildId, "Guild ID");
    const safeUserId = requireSnowflake(userId, "User ID");
    const center = await getOAuthRecoveryCenter(safeGuildId);
    const member = center.members.find(item => item.userId === safeUserId);
    if (!member) {
        const error = new Error("OAuth recovery not required");
        error.code = "oauth_recovery_not_required";
        throw error;
    }
    if (!member.roleId) {
        const error = new Error("Verification role is unavailable");
        error.code = "verification_role_missing";
        throw error;
    }
    const result = await discordAPI.removeRoleFromMember(safeGuildId, member.userId, member.roleId);
    return { success: result.ok === true, member, result };
}

async function revokeAllRecoveryRoles({ guildId, expectedCount, concurrency = 3 }) {
    const safeGuildId = requireSnowflake(guildId, "Guild ID");
    const center = await getOAuthRecoveryCenter(safeGuildId);
    if (Number(expectedCount) !== center.count) {
        const error = new Error("OAuth recovery count changed");
        error.code = "oauth_recovery_confirmation_mismatch";
        error.currentCount = center.count;
        throw error;
    }
    const queue = [...center.members];
    const results = [];
    const workerCount = Math.max(1, Math.min(5, Number(concurrency || 3) || 3));
    async function worker() {
        while (queue.length) {
            const member = queue.shift();
            if (!member?.roleId) {
                results.push({ userId: member?.userId || null, ok: false, code: "verification_role_missing" });
                continue;
            }
            const result = await discordAPI.removeRoleFromMember(safeGuildId, member.userId, member.roleId);
            results.push({ userId: member.userId, roleId: member.roleId, ok: result.ok === true, status: result.status, error: result.error || null });
        }
    }
    await Promise.all(Array.from({ length: Math.min(workerCount, Math.max(1, queue.length)) }, worker));
    return {
        success: true,
        count: center.count,
        removed: results.filter(item => item.ok).length,
        failed: results.filter(item => !item.ok).length,
        truncated: center.truncated,
        results
    };
}

function extractLocationConfidence(link, lastInfo) {
    return {
        accuracyRadiusKm: link.accuracyRadiusKm ?? lastInfo.accuracyRadiusKm ?? null,
        locationConfidence: link.locationConfidence || lastInfo.locationConfidence || "unknown",
        locationConfidenceScore: link.locationConfidenceScore ?? lastInfo.locationConfidenceScore ?? null
    };
}

function ownerIpLocation(link = {}) {
    const lastInfo = link.lastIpInfo || {};
    const confidence = extractLocationConfidence(link, lastInfo);
    return {
        country: link.lastCountry ?? null,
        countryCode: link.lastCountryCode ?? null,
        region: link.lastRegion ?? null,
        city: link.lastCity ?? null,
        timezone: link.lastTimezone ?? null,
        isp: link.lastIsp ?? null,
        org: link.lastOrg ?? null,
        as: link.lastAs ?? null,
        asname: link.lastAsname ?? null,
        ...confidence
    };
}

function ownerIpSignals(link = {}) {
    return {
        isVPN: link.isVPN === true,
        isProxy: link.isProxy === true,
        isTOR: link.isTOR === true,
        hosting: link.hosting === true,
        mobile: link.mobile === true,
        anycast: link.anycast === true,
        networkType: link.networkType || link.lastIpInfo?.networkType || null
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

async function getOwnerFullMemberDetail({ guildId, userId }) {
    const safeGuildId = requireSnowflake(guildId, "Guild ID");
    const safeUserId = requireSnowflake(userId, "User ID");
    const detail = await getMemberDetail(safeGuildId, safeUserId, { canViewSensitive: true });
    const [tokenStates, log, identityLink] = await Promise.all([
        oauthTokenManager.getOwnerTokenState(safeUserId),
        scopedGuildUserQuery(VerifyLog.findOne(), safeGuildId, safeUserId)
            .where("ipInfo.encryptedRawIp").exists(true).ne("")
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 }),
        ipIdentityHistory.findLinkForUser(safeGuildId, safeUserId)
    ]);
    const history = identityLink?.ipHash
        ? await ipIdentityHistory.loadInitialHistory({ guildId: safeGuildId, ipHash: identityLink.ipHash })
        : null;
    return {
        ...detail,
        sensitive: {
            rawIp: decryptIP(log?.ipInfo?.encryptedRawIp || identityLink?.encryptedRawIp || ""),
            oauth: tokenStates.oauth,
            adminOAuth: tokenStates.adminOAuth,
            ipIdentity: ownerIpIdentityDetail(identityLink, history)
        }
    };
}

module.exports = {
    getOverview,
    getGuildStats,
    getGuildMembers,
    getMemberDetail,
    getOAuthRecoveryCenter,
    revokeRecoveryMemberRole,
    revokeAllRecoveryRoles,
    getOwnerFullMemberDetail,
    getOwnerIpHistoryPage,
    ownerIpIdentityDetail,
    emptyStats,
    safeRecent,
    tokenRecoveryReasons
};
