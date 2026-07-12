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
        const update = buildSensitiveAccessAuditUpdate({
            actor: getAdminId(req) || "owner-dashboard",
            route
        });
        update.$setOnInsert = {
            guildId,
            "verification.enabled": false,
            createdAt: Date.now()
        };
        const result = await GuildConfig.updateOne(
            { guildId },
            update,
            { upsert: true, setDefaultsOnInsert: false }
        );
        if (Number(result?.matchedCount || result?.modifiedCount || result?.upsertedCount || 0) > 0) {
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
