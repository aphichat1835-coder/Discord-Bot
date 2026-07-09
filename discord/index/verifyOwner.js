"use strict";

const auth = require("./auth");
const verificationOwnerService = require("../verification/ownerService");

function sendError(res, err) {
    let status = 500;
    if (["reason_required", "reason_too_long"].includes(err?.code)) status = 400;
    else if (["rate_limited", "cooldown"].includes(err?.code)) status = 429;
    else if (err?.code === "ip_not_found") status = 404;
    res.status(status).json({
        success: false,
        code: err?.code || "verification_owner_error",
        error: err?.message || "verification_owner_error"
    });
}

function safeQuerySuffix(req, allowedKeys = []) {
    const params = new URLSearchParams();
    for (const key of allowedKeys) {
        const value = req.query?.[key];
        if (typeof value === "string" && value.length <= 120) {
            params.set(key, value);
        }
    }
    const query = params.toString();
    return query ? `?${query}` : "";
}

function safeGuildId(value) {
    const text = String(value || "").trim();
    return /^\d{17,22}$/.test(text) ? text : "";
}

function registerVerifyOwnerRoutes({ app, express }) {
    app.get("/verify", (_req, res) => res.redirect(302, "/verification"));
    app.get("/verify-owner", (_req, res) => res.redirect(302, "/verification"));

    app.get("/api/verify-owner/overview", auth.requirePin, (req, res) => {
        res.redirect(302, `/api/guilds${safeQuerySuffix(req, ["enabled"])}`);
    });

    app.get(
        "/api/verify-owner/guild/:guildId/stats",
        auth.requirePin,
        (req, res) => {
            const guildId = safeGuildId(req.params.guildId);
            const target = guildId
                ? `/api/guild/${guildId}/stats${safeQuerySuffix(req, ["page", "limit", "result", "risk", "q"])}`
                : "/api/guilds";
            res.redirect(302, target);
        }
    );

    app.get(
        "/api/verify-owner/guild/:guildId/members",
        auth.requirePin,
        (req, res) => {
            const guildId = safeGuildId(req.params.guildId);
            const target = guildId
                ? `/api/guild/${guildId}/members${safeQuerySuffix(req, ["page", "limit", "result", "risk", "q"])}`
                : "/api/guilds";
            res.redirect(302, target);
        }
    );

    app.post(
        "/api/verify-owner/guild/:guildId/user/:userId/reveal-ip",
        auth.requirePin,
        auth.requireCsrf,
        express.json(),
        async (req, res) => {
            try {
                res.json(await verificationOwnerService.revealRawIp({
                    guildId: String(req.params.guildId),
                    userId: String(req.params.userId),
                    reason: req.body?.reason,
                    actor: "owner-dashboard"
                }));
            } catch (err) {
                sendError(res, err);
            }
        }
    );
}

module.exports = {
    registerVerifyOwnerRoutes
};
