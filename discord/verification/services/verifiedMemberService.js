"use strict";

const VerifyLog = require("../models/VerifyLog");
const OAuthUser = require("../models/OAuthUser");
const { buildVerifyLogCommon, buildVerifyLogParts } = require("../utils/verificationSnapshots");

const MEMBER_SCAN_MAX = Math.max(
    100,
    Number(process.env.VERIFIED_MEMBER_SCAN_MAX || 5000) || 5000
);

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function successLogFilter(guildId, query = {}) {
    const filter = {
        guildId,
        result: "success",
        deletedAt: { $exists: false }
    };
    if (query.q) {
        const escaped = escapeRegex(query.q);
        const text = { $regex: escaped, $options: "i" };
        filter.$or = [
            { userId: String(query.q) },
            { "discordSnapshot.username": text },
            { "discordSnapshot.globalName": text },
            { "discordSnapshot.email": text }
        ];
    }
    return filter;
}

function fromLog(log = {}, canViewSensitive = false) {
    const parts = buildVerifyLogParts(log, canViewSensitive);
    const common = buildVerifyLogCommon(parts, { canViewSensitive, defaultResult: "success" });
    return {
        ...common,
        logId: log._id ? String(log._id) : null,
        source: "verify_log",
        legacy: false,
        status: "verified",
        verifiedAt: log.verifiedAt || log.createdAt || null,
        createdAt: log.createdAt || log.verifiedAt || null
    };
}

function legacySensitiveFields(discord = {}, connections = [], guilds = [], canViewSensitive = false) {
    if (!canViewSensitive) {
        return {
            email: null,
            emailVerified: null,
            accountAgeDays: null,
            accountCreatedAt: null,
            badgeFlags: [],
            connections: [],
            guilds: []
        };
    }

    return {
        email: discord.email || null,
        emailVerified: discord.emailVerified === true,
        accountAgeDays: discord.accountAgeDays || null,
        accountCreatedAt: discord.accountCreatedAt || null,
        badgeFlags: Array.isArray(discord.badgeFlags) ? discord.badgeFlags : [],
        connections,
        guilds
    };
}

function legacyCounts(user = {}, connections = [], guilds = []) {
    return {
        connectionsCount: Number(user.connectionsCount ?? connections.length ?? 0),
        guildsCount: Number(user.guildsCount ?? guilds.length ?? 0)
    };
}

function legacyMemberFields(user = {}) {
    const member = user.lastMember || null;
    return {
        member,
        memberSnapshot: member,
        memberRoles: Array.isArray(member?.roles) ? member.roles : [],
        joinedAt: member?.joinedAt || null
    };
}

function legacyVerificationFields(user = {}) {
    return {
        riskScore: Number(user.lastVerify?.riskScore || 0),
        riskFlags: Array.isArray(user.lastVerify?.riskFlags) ? user.lastVerify.riskFlags : [],
        verifiedAt: user.lastVerify?.verifiedAt || user.updatedAt || null,
        createdAt: user.createdAt || null
    };
}

function fromOAuthUser(user = {}, canViewSensitive = false) {
    const discord = user.discord || {};
    const connections = Array.isArray(user.connections) ? user.connections : [];
    const guilds = Array.isArray(user.guilds) ? user.guilds : [];
    const sensitive = legacySensitiveFields(discord, connections, guilds, canViewSensitive);
    return {
        logId: null,
        guildId: user.lastVerify?.guildId || null,
        userId: discord.userId || null,
        roleId: user.lastVerify?.roleId || null,
        source: "oauth_user_last_verify",
        legacy: true,
        status: "legacy_verified",
        result: user.lastVerify?.result || "success",
        username: discord.username || "Unknown",
        globalName: discord.globalName || null,
        tag: discord.displayTag || null,
        avatarUrl: discord.avatarUrl || null,
        email: sensitive.email,
        emailVerified: sensitive.emailVerified,
        accountAgeDays: sensitive.accountAgeDays,
        accountCreatedAt: sensitive.accountCreatedAt,
        badgeFlags: sensitive.badgeFlags,
        ...legacyCounts(user, connections, guilds),
        connections: sensitive.connections,
        guilds: sensitive.guilds,
        ...legacyMemberFields(user),
        ...legacyVerificationFields(user),
        sensitiveRedacted: canViewSensitive !== true,
        canSyncRole: false,
        reason: "legacy_oauth_user_last_verify"
    };
}

function legacyVerifiedAggregation(guildId, scanLimit = MEMBER_SCAN_MAX) {
    return [
        {
            $match: {
                "lastVerify.guildId": guildId,
                "lastVerify.result": "success",
                $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }]
            }
        },
        { $sort: { "lastVerify.verifiedAt": -1, updatedAt: -1, _id: -1 } },
        { $limit: scanLimit },
        {
            $project: {
                discord: 1,
                lastMember: 1,
                lastVerify: 1,
                lastIpTracking: 1,
                snapshotMeta: 1,
                createdAt: 1,
                updatedAt: 1,
                connectionsCount: {
                    $ifNull: ["$snapshotMeta.connections.storedCount", { $size: { $ifNull: ["$connections", []] } }]
                },
                guildsCount: {
                    $ifNull: ["$snapshotMeta.guilds.storedCount", { $size: { $ifNull: ["$guilds", []] } }]
                }
            }
        }
    ];
}

function listSafeMember(member = {}) {
    const { connections: _connections, guilds: _guilds, ...summary } = member;
    return {
        ...summary,
        detailsAvailable: true,
        sensitiveRedacted: true
    };
}

function chooseSensitiveArray(primaryValue, fallbackValue, canViewSensitive = false) {
    if (!canViewSensitive) return [];
    if (Array.isArray(primaryValue) && primaryValue.length) return primaryValue;
    return Array.isArray(fallbackValue) ? fallbackValue : [];
}

function mergeMembers(primary, fallback, canViewSensitive = false) {
    if (!primary) return fallback;
    if (!fallback) return primary;
    const mergedConnections = chooseSensitiveArray(primary.connections, fallback.connections, canViewSensitive);
    const mergedGuilds = chooseSensitiveArray(primary.guilds, fallback.guilds, canViewSensitive);
    return {
        ...fallback,
        ...primary,
        source: "merged",
        legacy: fallback.legacy === true && primary.legacy !== false,
        status: primary.status || fallback.status || "verified",
        connectionsCount: primary.connectionsCount ?? fallback.connectionsCount,
        guildsCount: primary.guildsCount ?? fallback.guildsCount,
        connections: mergedConnections,
        guilds: mergedGuilds,
        email: canViewSensitive ? (primary.email ?? fallback.email ?? null) : null,
        badgeFlags: canViewSensitive ? (primary.badgeFlags || fallback.badgeFlags || []) : [],
        sensitiveRedacted: canViewSensitive !== true
    };
}

async function listVerifiedMembers(guildId, { page = 0, limit = 25, q = "", includeLegacy = true, canViewSensitive = false } = {}) {
    const safePage = Math.max(0, Number.parseInt(page, 10) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
    const requestedWindow = (safePage + 1) * safeLimit;
    const scanLimit = Math.min(MEMBER_SCAN_MAX, Math.max(safeLimit * 3, requestedWindow * 3));
    const logFilter = successLogFilter(guildId, { q });
    const [logs, legacyUsers] = await Promise.all([
        VerifyLog.find(logFilter)
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .limit(scanLimit)
            .lean(),
        includeLegacy
            ? OAuthUser.aggregate(legacyVerifiedAggregation(guildId, scanLimit))
            : []
    ]);

    const map = new Map();
    for (const user of legacyUsers) {
        const member = fromOAuthUser(user, canViewSensitive);
        if (member.userId) map.set(member.userId, member);
    }
    for (const log of logs) {
        const member = fromLog(log, canViewSensitive);
        if (!member.userId) continue;
        map.set(member.userId, mergeMembers(member, map.get(member.userId), canViewSensitive));
    }
    let members = [...map.values()].sort((a, b) => Number(b.verifiedAt || 0) - Number(a.verifiedAt || 0));
    if (q) {
        const needle = String(q).toLowerCase();
        members = members.filter(item => [
            item.userId,
            item.username,
            item.globalName,
            item.email,
            item.tag
        ].some(value => String(value || "").toLowerCase().includes(needle)));
    }
    const truncated = logs.length >= scanLimit || legacyUsers.length >= scanLimit;
    const total = members.length;
    members = members
        .slice(safePage * safeLimit, safePage * safeLimit + safeLimit)
        .map(listSafeMember);
    return {
        members,
        total,
        totalApproximate: truncated,
        truncated,
        scanLimit,
        page: safePage,
        limit: safeLimit,
        hasMore: (safePage + 1) * safeLimit < total || truncated
    };
}

module.exports = {
    listVerifiedMembers,
    _test: {
        fromLog,
        fromOAuthUser,
        mergeMembers,
        legacyVerifiedAggregation,
        escapeRegex,
        legacySensitiveFields,
        legacyCounts,
        legacyMemberFields,
        legacyVerificationFields,
        chooseSensitiveArray,
        listSafeMember
    }
};
