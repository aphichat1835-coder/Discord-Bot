/* eslint-disable complexity -- Legacy dashboard serializers keep stable response shapes; refactor separately. */
/*
================================================================================
  Owner Verification Dashboard Extension Routes

  Routes:
  - GET /api/guild/:guildId/overview
  - GET /api/guild/:guildId/risk

  Notes:
  - ใช้กับหน้า guild.html / guild-dashboard.js
  - แสดงข้อมูลละเอียดเท่าที่ระบบเก็บได้
  - Raw IP ไม่ออกจาก list/detail API; ใช้ owner reveal action ที่ audit แยกเท่านั้น
  - ยังไม่ใช่ Log Center เต็ม อันนั้นพักไว้ทำทีหลัง
================================================================================
*/

const router = require("express").Router();

const GuildConfig = require("../models/GuildConfig");
const VerifyLog = require("../models/VerifyLog");

const { normalizeVerificationConfig } = require("../utils/verifyMode");
const {
    normalizeSensitiveAccess,
    buildSensitiveAccessAuditUpdate
} = require("../utils/sensitiveAccess");
const { makeOAuthUserSummaryMap } = require("../utils/oauthUserSummary");
const verifiedMemberService = require("../services/verifiedMemberService");
const {
    buildVerifyLogCommon,
    buildVerifyLogParts,
    safePolicySnapshot,
    safeRoleResult
} = require("../utils/verificationSnapshots");

function requireAdmin(req, res, next) {
    if (req.verificationOwner !== true) {
        return res.status(401).json({
            success: false,
            error: "กรุณา Login ก่อน",
            code: "admin_login_required"
        });
    }

    next();
}

function getAdminGuilds(req) {
    return Array.isArray(req.verificationGuilds) ? req.verificationGuilds : [];
}

function getAdminId(req) {
    return req.verificationOwner === true ? "owner-dashboard" : "unauthorized";
}

async function recordSensitiveAccess(guildId, req, route) {
    try {
        const result = await GuildConfig.updateOne(
            { guildId },
            buildSensitiveAccessAuditUpdate({ actor: getAdminId(req), route })
        );
        if (Number(result?.matchedCount || result?.modifiedCount || 0) > 0) return;
        throw new Error("sensitive access audit target not found");
    } catch (cause) {
        const error = new Error("sensitive access audit could not be persisted");
        error.code = "audit_write_failed";
        error.cause = cause;
        throw error;
    }
}

function normalizeGuild(guild = {}) {
    const owner = !!guild.owner || !!guild.isOwner;
    const isAdmin = owner || guild.isAdmin === true;
    const canManageGuild = owner || guild.canManageGuild === true;
    const canManageRoles = owner || guild.canManageRoles === true;
    const canManage = owner || guild.canManage === true;
    return {
        id: String(guild.id || ""),
        name: String(guild.name || "Unknown Server"),
        icon: guild.icon || null,
        owner,
        permissions: String(guild.permissions || "0"),
        isAdmin,
        isOwner: owner,
        canManage,
        canManageGuild,
        canManageRoles
    };
}

function getGuildFromSession(req, guildId) {
    return getAdminGuilds(req)
        .map(normalizeGuild)
        .find(guild => guild.id === String(guildId) && (guild.canManage || guild.isAdmin || guild.isOwner || guild.owner));
}

function requireGuildAdmin(req, res, next) {
    const guildId = req.params.guildId || req.body?.guildId;
    const guild = getGuildFromSession(req, guildId);

    if (!guild) {
        return res.status(403).json({
            success: false,
            error: "ไม่มีสิทธิ์จัดการเซิร์ฟเวอร์นี้",
            code: "guild_admin_required"
        });
    }

    req.adminGuild = guild;
    next();
}

function safeServerError(res, err, message) {
    console.error("[GUILD-DASHBOARD]", err?.message || err);

    return res.status(err?.code === "audit_write_failed" ? 503 : 500).json({
        success: false,
        error: message || "เกิดข้อผิดพลาดภายในระบบ"
    });
}

function baseFilter(guildId) {
    return {
        guildId,
        deletedAt: { $exists: false }
    };
}

function safeLog(log, options = {}) {
    const canViewSensitive = options.canViewSensitive === true;
    const parts = buildVerifyLogParts(log, canViewSensitive);
    const { raw: obj, ipInfo, discord, member, tracking } = parts;
    const roleAssignResult = safeRoleResult(obj.roleAssignResult || {});
    const joinResult = safeRoleResult(obj.joinResult || {});
    const common = buildVerifyLogCommon(parts, {
        canViewSensitive,
        defaultResult: ""
    });

    return {
        ...common,
        id: String(obj._id || obj.id || ""),
        _id: String(obj._id || obj.id || ""),
        requestId: obj.requestId || "",

        result: common.result,
        joinResult,
        roleAssignResult,
        roleAssignmentResult: obj.roleAssignResult?.ok === true
            ? "success"
            : obj.roleAssignResult?.error
                ? "failed"
                : obj.roleAssignResult || null,
        roleResult: obj.roleAssignResult?.ok === true
            ? "success"
            : obj.roleAssignResult?.status || "",

        policyResult: obj.result || "",
        verifiedAt: obj.verifiedAt || null,
        createdAt: obj.createdAt || obj.verifiedAt || null,

        debug: {
            reason: obj.reason || "",
            result: obj.result || "",
            stateMode: obj.stateMode || "",
            riskScore: Number(obj.riskScore || ipInfo.riskScore || 0),
            riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags : [],
            policy: safePolicySnapshot(obj.policySnapshot || {}),
            discord,
            member,
            tracking,
            roleAssignResult,
            joinResult
        }
    };
}

function serializeConfig(doc) {
    const raw = doc?.toObject ? doc.toObject() : doc || {};
    const security = raw.security || {};

    return {
        guildId: raw.guildId || "",
        guildName: raw.guildName || "",
        verification: normalizeVerificationConfig(raw.verification || {}),
        security: {
            ...security,
            sensitiveDataAccess: normalizeSensitiveAccess(security)
        },
        setupBy: raw.setupBy || null,
        createdAt: raw.createdAt || null,
        updatedAt: raw.updatedAt || null
    };
}

async function buildStats(guildId) {
    const filter = baseFilter(guildId);

    const [
        total,
        success,
        blocked,
        failed,
        vpn,
        proxy,
        tor,
        hosting,
        mobile,
        highRisk,
        lookupFailed
    ] = await Promise.all([
        VerifyLog.countDocuments(filter),
        VerifyLog.countDocuments({ ...filter, result: "success" }),
        VerifyLog.countDocuments({ ...filter, result: "blocked" }),
        VerifyLog.countDocuments({ ...filter, result: "failed" }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isVPN": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isProxy": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isTOR": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.hosting": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.mobile": true }),
        VerifyLog.countDocuments({ ...filter, riskScore: { $gte: 70 } }),
        VerifyLog.countDocuments({
            ...filter,
            "ipInfo.lookupStatus": { $in: ["lookup_failed", "ip_unknown"] }
        })
    ]);

    return {
        total,
        success,
        blocked,
        failed,
        vpn,
        proxy,
        tor,
        hosting,
        mobile,
        highRisk,
        lookupFailed,
        pendingReveal: 0,
        successRate: total ? Math.round((success / total) * 100) : 0
    };
}

async function topDistribution(guildId, labelExpression, limit = 12) {
    return VerifyLog.aggregate([
        { $match: baseFilter(guildId) },
        { $project: { label: labelExpression } },
        { $group: { _id: { $ifNull: ["$label", "unknown"] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, label: "$_id", count: 1 } }
    ]);
}

async function buildRiskSummary(guildId) {
    const [countries, isps, devices, reasons, recentLogs] = await Promise.all([
        topDistribution(guildId, {
            $ifNull: ["$ipInfo.countryCode", { $ifNull: ["$ipInfo.country", "unknown"] }]
        }),
        topDistribution(guildId, { $ifNull: ["$ipInfo.isp", "unknown"] }),
        topDistribution(guildId, {
            $concat: [
                { $ifNull: ["$device.browser", "unknown"] },
                " / ",
                { $ifNull: ["$device.os", "unknown"] }
            ]
        }),
        topDistribution(guildId, { $ifNull: ["$reason", { $ifNull: ["$result", "unknown"] }] }),
        VerifyLog.find({
            ...baseFilter(guildId),
            $or: [{ riskScore: { $gte: 35 } }, { result: { $ne: "success" } }]
        })
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .limit(20)
        .lean()
    ]);

    return {
        countries,
        isps,
        devices,
        reasons,
        recentRiskLogs: recentLogs.map(safeLog),
        sampled: false
    };
}

async function buildRecentMembers(guildId, limit = 8, options = {}) {
    const canViewSensitive = options.canViewSensitive === true;
    const legacyResult = await verifiedMemberService.listVerifiedMembers(guildId, {
        page: 0,
        limit,
        includeLegacy: true,
        canViewSensitive
    });
    if (legacyResult.members.length) {
        return legacyResult.members.map(member => ({
            ...member,
            connections: canViewSensitive ? Number(member.connectionsCount || 0) : 0,
            guilds: canViewSensitive ? Number(member.guildsCount || 0) : 0,
            member: member.memberSnapshot || member.member || null,
            country: member.country || member.ipInfo?.country || null,
            countryCode: member.countryCode || member.ipInfo?.countryCode || null,
            city: member.city || member.ipInfo?.city || null,
            isp: member.isp || member.ipInfo?.isp || null,
            isVPN: !!(member.isVPN || member.isProxy || member.isTOR),
            riskScore: Number(member.riskScore || 0),
            riskFlags: Array.isArray(member.riskFlags) ? member.riskFlags : [],
            verifiedAt: member.verifiedAt || member.createdAt || null
        }));
    }

    const logs = await VerifyLog.find({
        ...baseFilter(guildId),
        result: "success"
    })
        .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
        .limit(limit)
        .lean();

    const userIds = [...new Set(logs.map(log => log.userId).filter(Boolean))];

    const userMap = await makeOAuthUserSummaryMap(userIds);

    return logs.map(log => {
        const safe = safeLog(log, { canViewSensitive });
        const user = userMap[log.userId];
        const connectionsCount = Number(user?.connectionsCount ?? safe.connectionsCount ?? 0);
        const guildsCount = Number(user?.guildsCount ?? safe.guildsCount ?? 0);

        return {
            ...safe,

            logId: String(log._id || ""),
            userId: log.userId,

            username: user?.discord?.username || safe.username || "Unknown",
            globalName: user?.discord?.globalName || safe.globalName || null,
            avatarUrl: user?.discord?.avatarUrl || safe.user?.avatarUrl || null,
            avatarHash: user?.discord?.avatarHash || safe.user?.avatarHash || null,

            accountAgeDays: user?.discord?.accountAgeDays ?? safe.accountAgeDays ?? null,
            accountCreatedAt: user?.discord?.accountCreatedAt || safe.accountCreatedAt || null,
            email: canViewSensitive ? (user?.discord?.email || safe.email || null) : null,
            emailVerified: user?.discord?.emailVerified === true || safe.emailVerified === true,
            premiumType: user?.discord?.premiumType || safe.user?.premiumType || 0,

            connections: canViewSensitive ? connectionsCount : 0,
            connectionsCount,

            guilds: canViewSensitive ? guildsCount : 0,
            guildsCount,

            member: safe.memberSnapshot,

            country: safe.country,
            countryCode: safe.countryCode,
            city: safe.city,
            isp: safe.isp,

            isVPN: !!(safe.isVPN || safe.isProxy || safe.isTOR),
            riskScore: Number(safe.riskScore || 0),
            riskFlags: Array.isArray(safe.riskFlags) ? safe.riskFlags : [],
            device: safe.device,
            network: safe.trackingSnapshot,
            verifiedAt: safe.verifiedAt || null
        };
    });
}

router.get("/api/guild/:guildId/overview", requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const [config, stats, riskSummary, recentLogs] = await Promise.all([
            GuildConfig.findOne({ guildId }).lean(),
            buildStats(guildId),
            buildRiskSummary(guildId),
            VerifyLog.find(baseFilter(guildId))
                .sort({ verifiedAt: -1, createdAt: -1, _id: -1 })
                .limit(8)
                .lean()
        ]);
        const canViewSensitive = req.verificationOwner === true;
        if (canViewSensitive) {
            await recordSensitiveAccess(guildId, req, "/api/guild/:guildId/overview");
        }
        const recentMembers = await buildRecentMembers(guildId, 8, { canViewSensitive });

        res.json({
            success: true,
            guild: req.adminGuild,
            config: config ? serializeConfig(config) : null,
            sensitiveDataAccess: normalizeSensitiveAccess(config?.security || {}),
            stats,
            riskSummary,
            recentLogs: recentLogs.map(log => safeLog(log, { canViewSensitive })),
            recentMembers
        });
    } catch (err) {
        return safeServerError(res, err, "โหลดภาพรวมเซิร์ฟเวอร์ไม่สำเร็จ");
    }
});

router.get("/api/guild/:guildId/risk", requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        res.json({
            success: true,
            guild: req.adminGuild,
            risk: await buildRiskSummary(guildId)
        });
    } catch (err) {
        return safeServerError(res, err, "โหลดข้อมูลความเสี่ยงไม่สำเร็จ");
    }
});

router._test = {
    safeLog,
    recordSensitiveAccess,
    safeServerError,
    topDistribution,
    buildRiskSummary
};

module.exports = router;
