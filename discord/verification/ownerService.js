"use strict";

const GuildConfig = require("./models/GuildConfig");
const VerifyLog = require("./models/VerifyLog");
const OAuthUser = require("./models/OAuthUser");
const { decryptIP, decryptToken } = require("./utils/crypto");
const sensitiveAudit = require("./services/sensitiveAuditService");
const { serializeMemberDetail } = require("./serializers/memberDetailSerializer");
const verifiedMemberService = require("./services/verifiedMemberService");

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
    const result = await verifiedMemberService.listVerifiedMembers(guildId, {
        page: safePage,
        limit: safeLimit,
        includeLegacy: true,
        canViewSensitive: false
    });
    const members = result.members.map(member => ({
        ...member,
        connections: Number(member.connectionsCount || 0),
        guilds: Number(member.guildsCount || 0)
    }));
    return {
        success: true,
        members,
        page: safePage,
        limit: safeLimit,
        total: result.total,
        hasMore: result.hasMore
    };
}

function safeAuditError(err) {
    return {
        ok: false,
        code: err?.code ? String(err.code).slice(0, 80) : "audit_write_failed",
        message: err?.message ? String(err.message).slice(0, 160) : "audit_write_failed"
    };
}

async function auditRevealWrites({ guildId, userId, verifyLogId = null, actor, reason, now, action, route, scope }) {
    const writes = {
        verifyLog: { ok: false, skipped: false },
        guildConfig: { ok: false, skipped: false }
    };

    try {
        const update = {
            $push: {
                sensitiveAccessLog: sensitiveAudit.auditVerifyLogEntry({
                    action,
                    actor,
                    reason,
                    viewedAt: now
                })
            }
        };
        if (verifyLogId) {
            await VerifyLog.updateOne({ _id: verifyLogId }, update);
        } else {
            await VerifyLog.findOneAndUpdate(
                { ...baseFilter(guildId), userId },
                update,
                { sort: { verifiedAt: -1, createdAt: -1, _id: -1 } }
            );
        }
        writes.verifyLog = { ok: true, skipped: false };
    } catch (err) {
        writes.verifyLog = safeAuditError(err);
    }

    try {
        await GuildConfig.updateOne(
            { guildId },
            sensitiveAudit.auditGuildConfigUpdate({
                actor,
                route,
                scope,
                now
            })
        );
        writes.guildConfig = { ok: true, skipped: false };
    } catch (err) {
        writes.guildConfig = safeAuditError(err);
    }

    const ok = writes.verifyLog.ok === true || writes.guildConfig.ok === true;
    return {
        ok,
        status: ok ? "recorded" : "failed",
        failOpen: ok !== true,
        writes
    };
}

async function revealRawIp({ guildId, userId, reason, actor = "owner-dashboard" }) {
    const safeReason = sensitiveAudit.safeReason(reason);
    sensitiveAudit.checkRevealLimit({ actor, guildId, userId, action: "raw_ip" });

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
    const audit = await auditRevealWrites({
        guildId,
        userId,
        verifyLogId: log._id,
        actor,
        reason: safeReason,
        now,
        action: "owner_reveal_raw_ip",
        route: "/api/verify-owner/guild/:guildId/user/:userId/reveal-ip",
        scope: ["rawIp"]
    });

    return {
        success: true,
        guildId,
        userId,
        verifyLogId: String(log._id),
        rawIp,
        viewedAt: now,
        auditStatus: audit.status,
        audit,
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

async function getMemberDetail(guildId, userId, { canViewSensitive = true } = {}) {
    const [oauthUser, latestLog] = await Promise.all([
        OAuthUser.findOne({ "discord.userId": userId })
            .select({
                discord: 1,
                connections: 1,
                guilds: 1,
                lastMember: 1,
                lastVerify: 1,
                lastIpTracking: 1,
                snapshotMeta: 1,
                oauth: 1,
                adminOAuth: 1,
                createdAt: 1,
                updatedAt: 1
            })
            .lean(),
        VerifyLog.findOne({ ...baseFilter(guildId), userId })
            .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
            .lean()
    ]);

    if (!oauthUser && !latestLog) {
        const error = new Error("member detail not found");
        error.code = "member_not_found";
        throw error;
    }

    return serializeMemberDetail({
        guildId,
        userId,
        oauthUser,
        latestLog,
        canViewSensitive
    });
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

async function revealOAuthTokens({ guildId, userId, reason, actor = "owner-dashboard" }) {
    const safeReason = sensitiveAudit.safeReason(reason);
    sensitiveAudit.checkRevealLimit({ actor, guildId, userId, action: "raw_token" });

    const user = await OAuthUser.findOne({ "discord.userId": userId })
        .select("discord.userId oauth adminOAuth")
        .lean();

    if (!user?.discord?.userId) {
        const error = new Error("OAuth user not found");
        error.code = "member_not_found";
        throw error;
    }

    const now = Date.now();
    const audit = await auditRevealWrites({
        guildId,
        userId,
        actor,
        reason: safeReason,
        now,
        action: "owner_reveal_oauth_token",
        route: "/api/guild/:guildId/member/:userId/reveal-token",
        scope: ["oauthTokens"]
    });

    return {
        success: true,
        guildId,
        userId,
        viewedAt: now,
        auditStatus: audit.status,
        audit,
        oauth: revealTokenState(user.oauth || {}),
        adminOAuth: revealTokenState(user.adminOAuth || {})
    };
}

module.exports = {
    getOverview,
    getGuildStats,
    getGuildMembers,
    revealRawIp,
    getMemberDetail,
    revealOAuthTokens,
    emptyStats,
    safeRecent
};
