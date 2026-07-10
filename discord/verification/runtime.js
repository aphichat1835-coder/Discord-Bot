"use strict";

const path = require("node:path");
const rateLimitImport = require("express-rate-limit");
const ownerAuth = require("../index/auth");
const oauthRoutes = require("./routes/oauth");
const guildRoutes = require("./routes/guild");
const guildDashboardRoutes = require("./routes/guildDashboard");
const { verificationHomePage } = require("./page");
const {
    getVerificationDiagnostics,
    runVerificationMaintenance
} = require("./lifecycle");

const rateLimit = rateLimitImport.rateLimit || rateLimitImport.default || rateLimitImport;

function ownerGuilds(client) {
    return Array.from(client?.guilds?.cache?.values?.() || []).map(guild => ({
        id: String(guild.id),
        name: guild.name || String(guild.id),
        icon: guild.icon || null,
        owner: true,
        isOwner: true,
        isAdmin: true,
        canManage: true,
        canManageGuild: true,
        canManageRoles: true,
        permissions: "8"
    }));
}

function ownerContext(client) {
    return (req, _res, next) => {
        const cookies = ownerAuth.parseCookies(req);
        const localPinBypass = !ownerAuth.PIN() && !ownerAuth.isProduction();
        req.verificationOwner = localPinBypass ||
            ownerAuth.verifyToken(cookies[ownerAuth.COOKIE_NAME]);
        req.verificationGuilds = req.verificationOwner ? ownerGuilds(client) : [];
        next();
    };
}

function registerVerificationRuntime({ app, express, client, sessionManager }) {
    const publicRoot = path.join(__dirname, "public");
    const callbackLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 20,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => res.status(429).json({
            success: false,
            code: "rate_limited",
            error: "มีการยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่"
        })
    });

    app.use("/verification-assets", express.static(publicRoot, {
        etag: true,
        maxAge: process.env.STATIC_CACHE_MAX_AGE || "10m"
    }));

    app.post("/auth/callback", callbackLimiter, (req, res, next) => {
        const db = sessionManager.getDatabaseStatus?.();
        if (db?.connected !== true) {
            return res.status(503).json({
                success: false,
                code: "verification_not_ready",
                error: "ระบบยืนยันกำลังเริ่มทำงาน กรุณาลองใหม่อีกครั้ง"
            });
        }
        return next();
    });
    app.use(oauthRoutes);

    const attachOwner = ownerContext(client);
    app.get("/guilds", ownerAuth.requirePin, (_req, res) => {
        res.redirect(302, "/verification");
    });
    app.get("/guild/:guildId", ownerAuth.requirePin, attachOwner, (req, res) => {
        const guildId = String(req.params.guildId || "");
        const canManage = /^\d{17,22}$/.test(guildId) &&
            req.verificationGuilds.some(guild => String(guild.id) === guildId);
        if (!canManage) return res.redirect(302, "/verification");
        return res.sendFile(path.join(__dirname, "views", "guild.html"));
    });
    app.get("/verification", ownerAuth.requirePin, attachOwner, (_req, res) => {
        res.send(verificationHomePage());
    });
    app.use(attachOwner, guildDashboardRoutes, guildRoutes);

    app.get("/api/verification/diagnostics", ownerAuth.requirePin, attachOwner, (_req, res) => {
        res.json({ success: true, verification: getVerificationDiagnostics() });
    });
    app.post(
        "/api/verification/retention/dry-run",
        ownerAuth.requirePin,
        ownerAuth.requireCsrf,
        attachOwner,
        async (_req, res) => {
            try {
                const summary = await runVerificationMaintenance({ dryRun: true });
                res.json({ success: true, summary });
            } catch (err) {
                res.status(500).json({ success: false, error: err?.message || "maintenance_failed" });
            }
        }
    );
}

module.exports = {
    registerVerificationRuntime,
    ownerGuilds,
    ownerContext
};
