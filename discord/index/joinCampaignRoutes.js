const joinCampaign = require("../features/joinCampaign/index");

function listJoinCampaignTargets(client, campaignConfig = joinCampaign.getJoinCampaignConfig()) {
    const guilds = Array.from(client?.guilds?.cache?.values?.() || []);

    return guilds
        .filter(guild => joinCampaign.isGuildAllowed(guild.id, campaignConfig))
        .map(guild => ({
            id: guild.id,
            name: guild.name || guild.id,
            memberCount: guild.memberCount || null,
            allowed: true
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function resolveJoinCampaignTarget(client, guildId, campaignConfig = joinCampaign.getJoinCampaignConfig()) {
    const safeGuildId = String(guildId || "").trim();

    if (!/^\d{17,22}$/.test(safeGuildId)) {
        return { ok: false, status: 400, code: "INVALID_GUILD_ID", error: "Guild ID ไม่ถูกต้อง" };
    }
    if (!joinCampaign.isGuildAllowed(safeGuildId, campaignConfig)) {
        return {
            ok: false,
            status: 403,
            code: "TARGET_GUILD_NOT_ALLOWED",
            error: "เซิร์ฟเวอร์นี้ไม่ได้อยู่ในรายการที่อนุญาต"
        };
    }

    const guild = client?.guilds?.cache?.get?.(safeGuildId);
    if (!guild) {
        return {
            ok: false,
            status: 404,
            code: "TARGET_GUILD_NOT_FOUND",
            error: "บอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายนี้"
        };
    }

    return {
        ok: true,
        guild
    };
}

function resolveJoinCampaignStartStatus(code) {
    switch (code) {
        case "INVALID_GUILD_ID":
            return 400;
        case "TARGET_GUILD_NOT_ALLOWED":
            return 403;
        default:
            return 409;
    }
}

function registerJoinCampaignRoutes({ app, express, client, checkAuth }) {
    app.get("/api/join-campaign/targets", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const config = joinCampaign.getJoinCampaignConfig();
            res.json({
                success: true,
                enabled: true,
                allowlistConfigured: config.allowedGuilds.size > 0,
                targets: listJoinCampaignTargets(client, config)
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/join-campaign/status", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            res.json({
                success: true,
                status: joinCampaign.getJoinCampaignStatus()
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/join-campaign/history", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
            const history = joinCampaign.listRecentCampaigns({ limit });
            res.json({ success: true, history });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/join-campaign/metrics", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const metrics = joinCampaign.getCampaignMetrics();
            res.json({ success: true, metrics });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    return true;
}

module.exports = {
    listJoinCampaignTargets,
    resolveJoinCampaignStartStatus,
    resolveJoinCampaignTarget,
    registerJoinCampaignRoutes
};
