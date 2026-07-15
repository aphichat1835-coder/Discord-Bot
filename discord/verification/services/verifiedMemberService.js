"use strict";

const VerifyLog = require("../models/VerifyLog");
const OAuthUser = require("../models/OAuthUser");
const { buildVerifyLogCommon, buildVerifyLogParts } = require("../utils/verificationSnapshots");

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

function listSafeMember(member = {}) {
    const summary = { ...member };
    delete summary.connections;
    delete summary.guilds;
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

function chooseArray(primaryValue, fallbackValue) {
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
        badgeFlags: canViewSensitive ? chooseArray(primary.badgeFlags, fallback.badgeFlags) : [],
        sensitiveRedacted: canViewSensitive !== true
    };
}

function hasMoreMembers(pageLength, limit, withinKnownTotal, truncated) {
    return pageLength === limit && (withinKnownTotal || truncated);
}

function latestLogMemberStages(guildId) {
    return [
        { $match: successLogFilter(guildId) },
        {
            $project: {
                guildId: 1,
                userId: 1,
                roleId: 1,
                result: 1,
                reason: 1,
                riskScore: 1,
                riskFlags: 1,
                oauthScope: 1,
                stateMode: 1,
                ipInfo: 1,
                device: 1,
                trackingSnapshot: 1,
                policySnapshot: 1,
                verifiedAt: 1,
                createdAt: 1,
                discordSnapshot: {
                    $mergeObjects: [
                        { $ifNull: ["$discordSnapshot", {}] },
                        { connections: [], guilds: [], member: null, memberSnapshot: null }
                    ]
                },
                memberSnapshot: {
                    $mergeObjects: [
                        { $ifNull: ["$memberSnapshot", { $ifNull: ["$discordSnapshot.member", {}] }] },
                        { roles: [] }
                    ]
                }
            }
        },
        { $sort: { verifiedAt: -1, createdAt: -1, _id: -1 } },
        {
            $group: {
                _id: "$userId",
                log: { $first: "$$ROOT" },
                verifiedAt: { $first: { $ifNull: ["$verifiedAt", "$createdAt"] } }
            }
        },
        {
            $project: {
                _id: 0,
                userId: "$_id",
                log: 1,
                oauth: { $literal: null },
                verifiedAt: 1
            }
        }
    ];
}

function legacyMemberUnionStage(guildId) {
    return {
        $unionWith: {
            coll: OAuthUser.collection.name,
            pipeline: [
                    {
                        $match: {
                            "lastVerify.guildId": guildId,
                            "lastVerify.result": "success",
                            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }]
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            userId: "$discord.userId",
                            oauth: {
                                discord: "$discord",
                                lastMember: "$lastMember",
                                lastVerify: "$lastVerify",
                                lastIpTracking: "$lastIpTracking",
                                snapshotMeta: "$snapshotMeta",
                                createdAt: "$createdAt",
                                updatedAt: "$updatedAt",
                                connectionsCount: {
                                    $ifNull: [
                                        "$snapshotMeta.connections.storedCount",
                                        { $size: { $ifNull: ["$connections", []] } }
                                    ]
                                },
                                guildsCount: {
                                    $ifNull: [
                                        "$snapshotMeta.guilds.storedCount",
                                        { $size: { $ifNull: ["$guilds", []] } }
                                    ]
                                }
                            },
                            log: { $literal: null },
                            verifiedAt: { $ifNull: ["$lastVerify.verifiedAt", "$updatedAt"] }
                        }
                    }
            ]
        }
    };
}

function deduplicatedMemberStages() {
    return [
        {
            $group: {
                _id: "$userId",
                verifiedAt: { $max: "$verifiedAt" },
                logs: { $push: "$log" },
                oauthUsers: { $push: "$oauth" }
            }
        },
        {
            $project: {
                _id: 0,
                userId: "$_id",
                verifiedAt: 1,
                log: {
                    $arrayElemAt: [{ $filter: { input: "$logs", as: "item", cond: { $ne: ["$$item", null] } } }, 0]
                },
                oauth: {
                    $arrayElemAt: [{ $filter: { input: "$oauthUsers", as: "item", cond: { $ne: ["$$item", null] } } }, 0]
                }
            }
        }
    ];
}

function memberSearchStage(q) {
    if (!q) return null;
    const text = { $regex: escapeRegex(q), $options: "i" };
    return {
        $match: {
            $or: [
                { userId: String(q) },
                { "oauth.discord.username": text },
                { "oauth.discord.globalName": text },
                { "oauth.discord.displayTag": text },
                { "log.discordSnapshot.username": text },
                { "log.discordSnapshot.globalName": text }
            ]
        }
    };
}

function verifiedMemberAggregation(guildId, { page, limit, q = "", includeLegacy = true } = {}) {
    const skip = page * limit;
    const pipeline = latestLogMemberStages(guildId);
    if (includeLegacy) pipeline.push(legacyMemberUnionStage(guildId));
    pipeline.push(...deduplicatedMemberStages());
    const searchStage = memberSearchStage(q);
    if (searchStage) pipeline.push(searchStage);
    pipeline.push(
        { $sort: { verifiedAt: -1, userId: 1 } },
        {
            $facet: {
                metadata: [{ $count: "total" }],
                rows: [{ $skip: skip }, { $limit: limit }]
            }
        }
    );
    return pipeline;
}

async function listVerifiedMembers(guildId, { page = 0, limit = 25, q = "", includeLegacy = true, canViewSensitive = false } = {}) {
    const safePage = Math.max(0, Number.parseInt(page, 10) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
    const safeQuery = String(q || "").trim().slice(0, 120);
    const aggregate = VerifyLog.aggregate(verifiedMemberAggregation(guildId, {
        page: safePage,
        limit: safeLimit,
        q: safeQuery,
        includeLegacy
    })).allowDiskUse(true);
    const [result = {}] = await aggregate;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const total = Number(result.metadata?.[0]?.total || 0);
    const pageMembers = rows.map(row => {
        const primary = row.log ? fromLog(row.log, canViewSensitive) : null;
        const fallback = row.oauth ? fromOAuthUser(row.oauth, canViewSensitive) : null;
        return listSafeMember(mergeMembers(primary, fallback, canViewSensitive));
    });
    return {
        members: pageMembers,
        total,
        totalApproximate: false,
        truncated: false,
        scanLimit: null,
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
        chooseArray,
        escapeRegex,
        legacySensitiveFields,
        legacyCounts,
        legacyMemberFields,
        legacyVerificationFields,
        chooseSensitiveArray,
        listSafeMember,
        hasMoreMembers,
        verifiedMemberAggregation
    }
};
