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

function querySuffix(req) {
    const index = String(req.originalUrl || "").indexOf("?");
    return index >= 0 ? req.originalUrl.slice(index) : "";
}

function registerVerifyOwnerRoutes({ app, express }) {
    app.get("/verify", (_req, res) => res.redirect(302, "/verification"));
    app.get("/verify-owner", (_req, res) => res.redirect(302, "/verification"));

    app.get("/api/verify-owner/overview", auth.requirePin, (req, res) => {
        res.redirect(302, `/api/guilds${querySuffix(req)}`);
    });

    app.get(
        "/api/verify-owner/guild/:guildId/stats",
        auth.requirePin,
        (req, res) => {
            res.redirect(302, `/api/guild/${encodeURIComponent(req.params.guildId)}/stats${querySuffix(req)}`);
        }
    );

    app.get(
        "/api/verify-owner/guild/:guildId/members",
        auth.requirePin,
        (req, res) => {
            res.redirect(302, `/api/guild/${encodeURIComponent(req.params.guildId)}/members${querySuffix(req)}`);
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
