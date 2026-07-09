"use strict";

const VerifyLog = require("../models/VerifyLog");
const OAuthUser = require("../models/OAuthUser");
const { buildVerifyLogCommon, buildVerifyLogParts } = require("../utils/verificationSnapshots");

function successLogFilter(guildId, query = {}) {
    const filter = {
        guildId,
        result: "success",
        deletedAt: { $exists: false }
    };
    if (query.q) {
        const escaped = String(query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function fromOAuthUser(user = {}, canViewSensitive = false) {
    const discord = user.discord || {};
    const connections = Array.isArray(user.connections) ? user.connections : [];
    const guilds = Array.isArray(user.guilds) ? user.guilds : [];
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
        email: canViewSensitive ? (discord.email || null) : null,
        emailVerified: canViewSensitive ? discord.emailVerified === true : null,
        accountAgeDays: canViewSensitive ? (discord.accountAgeDays || null) : null,
        accountCreatedAt: canViewSensitive ? (discord.accountCreatedAt || null) : null,
        badgeFlags: canViewSensitive && Array.isArray(discord.badgeFlags) ? discord.badgeFlags : [],
        connectionsCount: Number(user.connectionsCount ?? connections.length ?? 0),
        guildsCount: Number(user.guildsCount ?? guilds.length ?? 0),
        connections: canViewSensitive ? connections : [],
        guilds: canViewSensitive ? guilds : [],
        member: user.lastMember || null,
        memberSnapshot: user.lastMember || null,
        memberRoles: Array.isArray(user.lastMember?.roles) ? user.lastMember.roles : [],
        joinedAt: user.lastMember?.joinedAt || null,
        riskScore: Number(user.lastVerify?.riskScore || 0),
        riskFlags: Array.isArray(user.lastVerify?.riskFlags) ? user.lastVerify.riskFlags : [],
        verifiedAt: user.lastVerify?.verifiedAt || user.updatedAt || null,
        createdAt: user.createdAt || null,
        sensitiveRedacted: canViewSensitive !== true,
        canSyncRole: false,
        reason: "legacy_oauth_user_last_verify"
    };
}

function legacyVerifiedAggregation(guildId) {
    return [
        {
            $match: {
                "lastVerify.guildId": guildId,
                "lastVerify.result": "success",
                $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }]
            }
        },
        { $sort: { "lastVerify.verifiedAt": -1, updatedAt: -1, _id: -1 } },
        {
            $project: {
                discord: 1,
                lastMember: 1,
                lastVerify: 1,
                lastIpTracking: 1,
                snapshotMeta: 1,
                createdAt: 1,
                updatedAt: 1,
                connectionsCount: { $size: { $ifNull: ["$connections", []] } },
                guildsCount: { $size: { $ifNull: ["$guilds", []] } }
            }
        }
    ];
}

function mergeMembers(primary, fallback, canViewSensitive = false) {
    if (!primary) return fallback;
    if (!fallback) return primary;
    const mergedConnections = canViewSensitive
        ? (primary.connections?.length ? primary.connections : fallback.connections)
        : [];
    const mergedGuilds = canViewSensitive
        ? (primary.guilds?.length ? primary.guilds : fallback.guilds)
        : [];
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
    const logFilter = successLogFilter(guildId, { q });
    const [logs, legacyUsers] = await Promise.all([
        VerifyLog.find(logFilter).sort({ verifiedAt: -1, createdAt: -1, _id: -1 }).lean(),
        includeLegacy
            ? OAuthUser.aggregate(legacyVerifiedAggregation(guildId))
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
    const total = members.length;
    members = members.slice(safePage * safeLimit, safePage * safeLimit + safeLimit);
    return {
        members,
        total,
        page: safePage,
        limit: safeLimit,
        hasMore: (safePage + 1) * safeLimit < total
    };
}

module.exports = {
    listVerifiedMembers,
    _test: {
        fromLog,
        fromOAuthUser,
        mergeMembers,
        legacyVerifiedAggregation
    }
};
