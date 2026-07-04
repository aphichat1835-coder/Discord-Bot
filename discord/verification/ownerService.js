"use strict";

const GuildConfig = require("./models/GuildConfig");
const VerifyLog = require("./models/VerifyLog");
const { decryptIP } = require("./utils/crypto");
const { makeOAuthUserSummaryMap } = require("./utils/oauthUserSummary");

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
        highRisk: 0,
        lookupFailed: 0,
        panelRevisionMismatch: 0,
        lastAt: null
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
        highRisk: { $sum: { $cond: [{ $gte: ["$riskScore", 70] }, 1, 0] } },
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
        riskScore: Number(log.riskScore || log.ipInfo?.riskScore || 0),
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
    return {
        success: true,
        config,
        stats: counts[0] || emptyStats(),
        recent: recent.map(safeRecent)
    };
}

async function getGuildMembers(guildId, { page = 0, limit = 20 } = {}) {
    const safePage = Math.max(0, Number.parseInt(page, 10) || 0);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { ...baseFilter(guildId), result: "success" };
    const [total, logs] = await Promise.all([
        VerifyLog.countDocuments(filter),
        VerifyLog.find(filter)
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .skip(safePage * safeLimit)
            .limit(safeLimit)
            .lean()
    ]);
    const userIds = [...new Set(logs.map(log => log.userId).filter(Boolean))];
    const userMap = await makeOAuthUserSummaryMap(userIds);
    const members = logs.map(log => {
        const user = userMap[log.userId] || {};
        return {
            logId: String(log._id || ""),
            requestId: log.requestId || "",
            userId: log.userId,
            roleId: log.roleId || null,
            username: user.discord?.username || log.discordSnapshot?.username || "Unknown",
            globalName: user.discord?.globalName || log.discordSnapshot?.globalName || null,
            tag: user.discord?.displayTag || log.discordSnapshot?.displayTag || null,
            avatarUrl: user.discord?.avatarUrl || log.discordSnapshot?.avatarUrl || null,
            email: user.discord?.email || log.discordSnapshot?.email || null,
            emailVerified: user.discord?.emailVerified === true || log.discordSnapshot?.emailVerified === true,
            accountAgeDays: user.discord?.accountAgeDays || log.discordSnapshot?.accountAgeDays || null,
            badgeFlags: user.discord?.badgeFlags || [],
            connections: Number(user.connectionsCount || 0),
            guilds: Number(user.guildsCount || 0),
            member: log.memberSnapshot || log.discordSnapshot?.member || null,
            country: log.ipInfo?.country || null,
            countryCode: log.ipInfo?.countryCode || null,
            city: log.ipInfo?.city || null,
            isp: log.ipInfo?.isp || null,
            isVPN: !!log.ipInfo?.isVPN,
            isProxy: !!log.ipInfo?.isProxy,
            isTOR: !!log.ipInfo?.isTOR,
            hosting: !!log.ipInfo?.hosting,
            riskScore: Number(log.riskScore || log.ipInfo?.riskScore || 0),
            riskFlags: Array.isArray(log.riskFlags) ? log.riskFlags : [],
            device: log.device || null,
            verifiedAt: log.verifiedAt || log.createdAt || null
        };
    });
    return {
        success: true,
        members,
        page: safePage,
        limit: safeLimit,
        total,
        hasMore: (safePage + 1) * safeLimit < total
    };
}

async function revealRawIp({ guildId, userId, reason, actor = "owner-dashboard" }) {
    const safeReason = String(reason || "").trim();
    if (!safeReason) {
        const error = new Error("reason is required");
        error.code = "reason_required";
        throw error;
    }
    if (safeReason.length > 500) {
        const error = new Error("reason must be 500 characters or fewer");
        error.code = "reason_too_long";
        throw error;
    }

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

    const now = Date.now();
    const rawIp = decryptIP(log.ipInfo.encryptedRawIp);
    if (!rawIp) {
        const error = new Error("encrypted IP could not be decrypted");
        error.code = "ip_decrypt_failed";
        throw error;
    }
    await VerifyLog.updateOne(
        { _id: log._id },
        {
            $push: {
                sensitiveAccessLog: {
                    action: "owner_reveal_raw_ip",
                    actor,
                    reason: safeReason,
                    viewedAt: now
                }
            }
        }
    );

    return {
        success: true,
        guildId,
        userId,
        verifyLogId: String(log._id),
        rawIp,
        viewedAt: now,
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

module.exports = {
    getOverview,
    getGuildStats,
    getGuildMembers,
    revealRawIp,
    emptyStats,
    safeRecent
};
