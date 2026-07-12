"use strict";

const GuildConfig = require("../models/GuildConfig");
const { buildSensitiveAccessAuditUpdate } = require("./sensitiveAccess");

function getAdminUser(req) {
    return req.verificationOwner === true
        ? { id: "owner-dashboard", username: "Owner" }
        : null;
}

function getAdminId(req) {
    const user = getAdminUser(req);
    return user?.id || user?.userId || user?.discordId || null;
}

async function recordSensitiveAccess(guildId, req, route) {
    try {
        const result = await GuildConfig.updateOne(
            { guildId },
            buildSensitiveAccessAuditUpdate({
                actor: getAdminId(req) || "owner-dashboard",
                route
            })
        );
        if (Number(result?.matchedCount || result?.modifiedCount || 0) > 0) {
            return { ok: true, status: "recorded" };
        }
        throw Object.assign(new Error("sensitive access audit target not found"), {
            code: "audit_write_failed"
        });
    } catch (err) {
        console.error("[GUILD-DASHBOARD:sensitive-access-audit]", err?.message || err);
        if (!err.code) err.code = "audit_write_failed";
        throw err;
    }
}

module.exports = { getAdminUser, getAdminId, recordSensitiveAccess };
