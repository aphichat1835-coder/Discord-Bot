"use strict";

const auth = require("./auth");
const verificationOwnerService = require("../verification/ownerService");

function sendError(res, err) {
    const publicCodes = new Set([
        "rate_limited",
        "cooldown",
        "ip_not_found"
    ]);
    let status = 500;
    if (["rate_limited", "cooldown"].includes(err?.code)) status = 429;
    else if (err?.code === "ip_not_found") status = 404;
    const code = publicCodes.has(err?.code) ? err.code : "verification_owner_error";
    res.status(status).json({
        success: false,
        code,
        error: code === "verification_owner_error" ? code : (err?.message || code)
    });
}

function safeGuildId(value) {
    const text = String(value || "").trim();
    return /^\d{17,22}$/.test(text) ? text : "";
}

function sendInvalidGuildId(res) {
    return res.status(400).json({
        success: false,
        code: "invalid_guild_id",
        error: "guildId ไม่ถูกต้อง"
    });
}

function sendInvalidUserId(res) {
    return res.status(400).json({
        success: false,
        code: "invalid_user_id",
        error: "userId ไม่ถูกต้อง"
    });
}

function safeOverviewEnabled(value) {
    return String(value || "").toLowerCase() === "all" ? "all" : "enabled";
}

function safeListOptions(query = {}) {
    return {
        page: Math.max(0, Number.parseInt(query.page, 10) || 0),
        limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20)),
        q: typeof query.q === "string" ? query.q.trim().slice(0, 120) : ""
    };
}

function registerVerifyOwnerRoutes({ app, express }) {
    app.get("/verify", (_req, res) => res.redirect(302, "/verification"));
    app.get("/verify-owner", (_req, res) => res.redirect(302, "/verification"));

    app.get("/api/verify-owner/overview", auth.requirePin, async (req, res) => {
        try {
            const enabled = safeOverviewEnabled(req.query?.enabled);
            return res.json(await verificationOwnerService.getOverview({ enabled }));
        } catch (err) {
            return sendError(res, err);
        }
    });

    app.get(
        "/api/verify-owner/guild/:guildId/stats",
        auth.requirePin,
        async (req, res) => {
            const guildId = safeGuildId(req.params.guildId);
            if (!guildId) return sendInvalidGuildId(res);
            try {
                return res.json(await verificationOwnerService.getGuildStats(guildId));
            } catch (err) {
                return sendError(res, err);
            }
        }
    );

    app.get(
        "/api/verify-owner/guild/:guildId/members",
        auth.requirePin,
        async (req, res) => {
            const guildId = safeGuildId(req.params.guildId);
            if (!guildId) return sendInvalidGuildId(res);
            try {
                const options = safeListOptions(req.query);
                return res.json(await verificationOwnerService.getGuildMembers(guildId, options));
            } catch (err) {
                return sendError(res, err);
            }
        }
    );

}

module.exports = {
    registerVerifyOwnerRoutes
};
