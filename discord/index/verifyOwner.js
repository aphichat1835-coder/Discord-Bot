"use strict";

const auth = require("./auth");
const verificationOwnerService = require("../verification/ownerService");

function sendError(res, err) {
    const status = ["reason_required", "reason_too_long"].includes(err?.code)
        ? 400
        : err?.code === "ip_not_found"
            ? 404
            : 500;
    res.status(status).json({
        success: false,
        code: err?.code || "verification_owner_error",
        error: err?.message || "verification_owner_error"
    });
}

function registerVerifyOwnerRoutes({ app, express }) {
    app.get("/verify", (_req, res) => res.redirect(302, "/verification"));
    app.get("/verify-owner", (_req, res) => res.redirect(302, "/verification"));

    app.get("/api/verify-owner/overview", auth.requirePin, async (req, res) => {
        try {
            res.json(await verificationOwnerService.getOverview({
                enabled: req.query?.enabled || "all"
            }));
        } catch (err) {
            sendError(res, err);
        }
    });

    app.get(
        "/api/verify-owner/guild/:guildId/stats",
        auth.requirePin,
        async (req, res) => {
            try {
                res.json(await verificationOwnerService.getGuildStats(
                    String(req.params.guildId)
                ));
            } catch (err) {
                sendError(res, err);
            }
        }
    );

    app.get(
        "/api/verify-owner/guild/:guildId/members",
        auth.requirePin,
        async (req, res) => {
            try {
                res.json(await verificationOwnerService.getGuildMembers(
                    String(req.params.guildId),
                    {
                        page: req.query?.page,
                        limit: req.query?.limit
                    }
                ));
            } catch (err) {
                sendError(res, err);
            }
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
