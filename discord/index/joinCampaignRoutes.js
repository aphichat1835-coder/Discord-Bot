const joinCampaign = require("../features/joinCampaign");
const { getDiscordGuildIconUrl } = require("../core/webhooks");

function listJoinCampaignTargets(client) {
    const campaignConfig = joinCampaign.getJoinCampaignConfig();
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

function resolveJoinCampaignTarget(client, guildId) {
    const safeGuildId = String(guildId || "").trim();
    const campaignConfig = joinCampaign.getJoinCampaignConfig();

    if (!joinCampaign.isGuildAllowed(safeGuildId, campaignConfig)) {
        return {
            ok: false,
            status: 403,
            error: "เซิร์ฟเวอร์นี้ไม่ได้อยู่ในรายการที่อนุญาต"
        };
    }

    const guild = client?.guilds?.cache?.get?.(safeGuildId);
    if (!guild) {
        return {
            ok: false,
            status: 404,
            error: "บอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายนี้"
        };
    }

    return {
        ok: true,
        guild
    };
}

function registerJoinCampaignRoutes({ app, express, client, checkAuth }) {
    app.get("/api/join-campaign/targets", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            res.json({
                success: true,
                enabled: joinCampaign.getJoinCampaignConfig().enabled,
                targets: listJoinCampaignTargets(client)
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

    app.post("/api/join-campaign/dry-run", express.json({ limit: "8kb" }), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const target = resolveJoinCampaignTarget(client, req.body?.guildId);
            if (!target.ok) {
                return res.status(target.status).json({
                    success: false,
                    error: target.error
                });
            }

            const summary = await joinCampaign.executeJoinCampaign({
                targetGuildId: target.guild.id,
                targetGuildName: target.guild.name,
                targetGuildIconUrl: getDiscordGuildIconUrl(target.guild),
                dryRun: true,
                sendFinishLog: false,
                startedBy: "owner-dashboard"
            });

            res.json({ success: true, summary });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/join-campaign/start", express.json({ limit: "8kb" }), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const target = resolveJoinCampaignTarget(client, req.body?.guildId);
            if (!target.ok) {
                return res.status(target.status).json({
                    success: false,
                    error: target.error
                });
            }

            const started = joinCampaign.startJoinCampaign({
                targetGuildId: target.guild.id,
                targetGuildName: target.guild.name,
                targetGuildIconUrl: getDiscordGuildIconUrl(target.guild),
                startedBy: "owner-dashboard"
            });

            if (!started.ok) {
                return res.status(409).json({
                    success: false,
                    error: started.error,
                    campaign: started.campaign
                });
            }

            res.json({
                success: true,
                campaign: started.campaign
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/join-campaign/stop", express.json({ limit: "2kb" }), (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const stopped = joinCampaign.stopJoinCampaign();
            res.status(stopped.ok ? 200 : 409).json({
                success: stopped.ok,
                error: stopped.error || null
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    return true;
}

module.exports = {
    listJoinCampaignTargets,
    resolveJoinCampaignTarget,
    registerJoinCampaignRoutes
};
