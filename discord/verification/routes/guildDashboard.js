"use strict";

/*
  Owner verification overview.
  This route exposes factual verification counts only; it does not calculate
  scores or maintain a separate classification subsystem.
*/

const router = require("express").Router();
const GuildConfig = require("../models/GuildConfig");
const VerifyLog = require("../models/VerifyLog");
const { normalizeVerificationConfig } = require("../utils/verifyMode");

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

function normalizeGuild(guild = {}) {
    const owner = guild.owner === true || guild.isOwner === true;
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
    const guilds = Array.isArray(req.verificationGuilds) ? req.verificationGuilds : [];
    return guilds
        .map(normalizeGuild)
        .find(guild => guild.id === String(guildId) && (
            guild.canManage || guild.isAdmin || guild.isOwner || guild.owner
        ));
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
    return res.status(500).json({
        success: false,
        error: message || "เกิดข้อผิดพลาดภายในระบบ"
    });
}

function baseFilter(guildId) {
    return { guildId, deletedAt: { $exists: false } };
}

function serializeConfig(doc) {
    const raw = doc?.toObject ? doc.toObject() : doc || {};
    const security = { ...(raw.security || {}) };
    delete security.sensitiveDataAccess;
    delete security.ipRevealRequiresOwnerApproval;
    return {
        guildId: raw.guildId || "",
        guildName: raw.guildName || "",
        verification: normalizeVerificationConfig(raw.verification || {}),
        security,
        setupBy: raw.setupBy || null,
        createdAt: raw.createdAt || null,
        updatedAt: raw.updatedAt || null
    };
}

async function buildStats(guildId) {
    const filter = baseFilter(guildId);
    const reviewFilter = {
        ...filter,
        $or: [
            { "ipInfo.isVPN": true },
            { "ipInfo.isProxy": true },
            { "ipInfo.isTOR": true },
            { "ipInfo.lookupStatus": { $in: ["lookup_failed", "ip_unknown"] } }
        ]
    };
    const [total, success, blocked, failed, reviewRequired, vpn, proxy, tor, lookupFailed] = await Promise.all([
        VerifyLog.countDocuments(filter),
        VerifyLog.countDocuments({ ...filter, result: "success" }),
        VerifyLog.countDocuments({ ...filter, result: "blocked" }),
        VerifyLog.countDocuments({ ...filter, result: "failed" }),
        VerifyLog.countDocuments(reviewFilter),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isVPN": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isProxy": true }),
        VerifyLog.countDocuments({ ...filter, "ipInfo.isTOR": true }),
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
        reviewRequired,
        vpn,
        proxy,
        tor,
        lookupFailed,
        successRate: total ? Math.round((success / total) * 100) : 0
    };
}

router.get("/api/guild/:guildId/overview", requireAdmin, requireGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    try {
        res.set("Cache-Control", "no-store");
        const [config, stats] = await Promise.all([
            GuildConfig.findOne({ guildId }).lean(),
            buildStats(guildId)
        ]);
        res.json({
            success: true,
            guild: req.adminGuild,
            config: config ? serializeConfig(config) : null,
            stats
        });
    } catch (err) {
        return safeServerError(res, err, "โหลดภาพรวมเซิร์ฟเวอร์ไม่สำเร็จ");
    }
});

router._test = {
    normalizeGuild,
    getGuildFromSession,
    safeServerError,
    buildStats,
    serializeConfig
};

module.exports = router;
