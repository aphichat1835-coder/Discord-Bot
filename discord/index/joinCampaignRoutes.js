const joinCampaign = require("../features/joinCampaign");
const { getDiscordGuildIconUrl } = require("../core/webhooks");

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

    if (!campaignConfig.enabled) {
        return { ok: false, status: 503, code: "CAMPAIGN_DISABLED", error: "ระบบ Join Campaign ถูกปิด" };
    }
    if (!(campaignConfig.allowedGuilds instanceof Set) || campaignConfig.allowedGuilds.size === 0) {
        return { ok: false, status: 503, code: "CAMPAIGN_ALLOWLIST_REQUIRED", error: "ยังไม่ได้ตั้งค่ารายการเซิร์ฟเวอร์ที่อนุญาต" };
    }
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

function registerJoinCampaignRoutes({ app, express, client, checkAuth }) {
    app.get("/api/join-campaign/targets", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const config = joinCampaign.getJoinCampaignConfig();
            res.json({
                success: true,
                enabled: config.enabled,
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

    app.post("/api/join-campaign/dry-run", express.json({ limit: "8kb" }), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const target = resolveJoinCampaignTarget(client, req.body?.guildId);
            if (!target.ok) {
                return res.status(target.status).json({
                    success: false,
                    code: target.code || null,
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
            res.status(Number(e?.status) || 500).json({
                success: false,
                code: e?.code || "CAMPAIGN_DRY_RUN_FAILED",
                error: e.message
            });
        }
    });

    app.post("/api/join-campaign/start", express.json({ limit: "8kb" }), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const target = resolveJoinCampaignTarget(client, req.body?.guildId);
            if (!target.ok) {
                return res.status(target.status).json({
                    success: false,
                    code: target.code || null,
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
                const status = started.code === "CAMPAIGN_DISABLED" || started.code === "CAMPAIGN_ALLOWLIST_REQUIRED"
                    ? 503
                    : started.code === "INVALID_GUILD_ID"
                        ? 400
                        : started.code === "TARGET_GUILD_NOT_ALLOWED"
                            ? 403
                            : 409;
                return res.status(status).json({
                    success: false,
                    code: started.code || "CAMPAIGN_ALREADY_RUNNING",
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
