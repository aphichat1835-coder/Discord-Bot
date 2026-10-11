'use strict';

const databaseService = require("../../database/services/databaseService");
const { getPrimaryOwnerId } = require("../core/env");

function resolveActor(req) {
    if (!req) return "owner:dashboard";
    if (req.user?.id) return `owner:${req.user.id}`;
    if (req.session?.ownerId) return `owner:${req.session.ownerId}`;
    if (req.session?.user?.id) return `owner:${req.session.user.id}`;
    const primaryOwner = getPrimaryOwnerId();
    if (primaryOwner) return `owner:${primaryOwner}`;
    return "owner:dashboard";
}

function registerDatabaseRoutes({ app, express, checkAuth }) {
    // 1. Overview
    app.get("/api/database/overview", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const data = await databaseService.getDatabaseOverview();
            res.json({ success: true, ...data });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 2. SQLite Detailed Status
    app.get("/api/database/sqlite", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const data = await databaseService.getSqliteDetailedStatus();
            res.json({ success: true, ...data });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 3. SQLite Maintenance Action
    app.post("/api/database/sqlite/action", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const { action, options } = req.body || {};
            if (!action || typeof action !== "string") {
                return res.status(400).json({ success: false, error: "กรุณาระบุ action ที่ต้องการดำเนินการ" });
            }
            const actor = resolveActor(req);
            const result = await databaseService.executeSqliteAction(action, options || {}, actor);
            res.json({ success: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 4. Database Console (Strict Allowlist)
    app.post("/api/database/sqlite/console", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const { command } = req.body || {};
            if (!command || typeof command !== "string") {
                return res.status(400).json({ success: false, error: "กรุณาระบุคำสั่งฐานข้อมูล" });
            }
            const actor = resolveActor(req);
            const result = await databaseService.executeDatabaseConsole(command, actor);
            res.json({ success: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 5. MongoDB Detailed Status
    app.get("/api/database/mongo", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const data = await databaseService.getMongoDetailedStatus();
            res.json({ success: true, ...data });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 6. Safe MongoDB Collection Explorer
    app.get("/api/database/mongo/collection/:name", async (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const { name } = req.params;
            const limit = parseInt(req.query.limit, 10) || 5;
            const data = await databaseService.getMongoCollectionSample(name, limit);
            res.json({ success: true, ...data });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });
}

module.exports = {
    registerDatabaseRoutes
};
