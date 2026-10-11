'use strict';

const crypto = require("node:crypto");
const auth = require("./auth");
const { resolveActivityType } = require("../core/discordCompat");
const { delay: awaitedDelay } = require("../core/timers");
const {
    buildCommandStatusPayload,
    buildCommandAuditPayload
} = require("./dashboardState");
const { sendWebhookEvent, getDiscordGuildIconUrl } = require("../core/webhooks");
const { getQuestLogRepository, getScheduledRunnerRepository } = require("../../database/repositories/quest");
const { stopScheduledJob } = require("../quest");
const tokenCoordinator = require("../core/tokenCoordinator");

function wait(ms) {
    return awaitedDelay(ms);
}

function hashAuditIp(ip) {
    const raw = String(ip || "unknown");
    const secret = auth.getApiSecret() || "dashboard-audit";
    const hash = crypto
        .createHmac("sha256", secret)
        .update(raw)
        .digest("hex")
        .slice(0, 12);

    return `ip#${hash}`;
}

async function removeApprovedGuildRecord(sessionManager, guildId, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await sessionManager.ApprovedGuildModel.deleteOne({ guildId });
            return true;
        } catch {
            console.warn(`[DASHBOARD] ⚠️ Approved guild cleanup failed (${attempt}/${attempts})`);

            if (attempt < attempts) {
                await wait(250 * attempt);
            }
        }
    }

    return false;
}

async function stopGuildVoiceSessions(sessionManager, voiceWorker, guildId) {
    const guildSessions = Array.from(sessionManager.getAllSessions().values())
        .filter(session => session.serverId === guildId);

    let failedStops = 0;

    for (const session of guildSessions) {
        const stopped = await voiceWorker.stopSession(session.sessionId, {
            stoppedBy: "dashboard"
        }).catch(() => {
            console.warn("[DASHBOARD] ⚠️ Best-effort guild kick voice stop failed");
            return false;
        });

        if (!stopped) failedStops++;
    }

    if (failedStops > 0) {
        console.warn(`[DASHBOARD] ⚠️ Continuing guild leave after ${failedStops} voice session stop failure(s)`);
    }

    return failedStops;
}

function buildApprovedKickWarning(failedStops, approvalCleanupFailed) {
    return [
        failedStops > 0
            ? "บอทถูกนำออกแล้ว แต่มี voice sessions บางรายการหยุดไม่สำเร็จ"
            : null,
        approvalCleanupFailed
            ? "บอทถูกนำออกแล้ว แต่ลบ approved guild record ไม่สำเร็จ"
            : null
    ].filter(Boolean).join(" | ") || null;
}

const COMMAND_TOGGLE_COOLDOWN_MS = 5000;
const COMMAND_AUDIT_MAX = 100;

function validateCommandToggleRequest(commands, commandName) {
    if (!commandName || typeof commandName !== "string") {
        return { ok: false, status: 400, error: "ไม่ระบุชื่อคำสั่ง" };
    }

    const exists = (commands.slashCommandsData || []).some(command => command.name === commandName);
    if (!exists) {
        return { ok: false, status: 404, error: `ไม่พบคำสั่ง /${commandName}` };
    }

    return { ok: true, commandName };
}

function getCommandToggleCooldown(toggleCooldowns, toggleKey, now = Date.now()) {
    const lastToggle = toggleCooldowns.get(toggleKey) || 0;
    const remainingMs = COMMAND_TOGGLE_COOLDOWN_MS - (now - lastToggle);
    return Math.max(0, remainingMs);
}

function createCommandTogglePlan(disabledCommands, commandName) {
    const nextDisabledCommands = new Set(disabledCommands);
    if (nextDisabledCommands.has(commandName)) nextDisabledCommands.delete(commandName);
    else nextDisabledCommands.add(commandName);

    return {
        nextDisabledCommands,
        nowEnabled: !nextDisabledCommands.has(commandName)
    };
}

async function persistCommandToggle(sessionManager, disabledCommands, commandName) {
    const plan = createCommandTogglePlan(disabledCommands, commandName);
    const persisted = await sessionManager.setSetting("disabledCommands", [...plan.nextDisabledCommands]);
    if (persisted !== true) return { ok: false, nowEnabled: !disabledCommands.has(commandName) };

    disabledCommands.clear();
    for (const disabledCommand of plan.nextDisabledCommands) disabledCommands.add(disabledCommand);
    return { ok: true, nowEnabled: plan.nowEnabled };
}

function recordCommandToggleAudit(commandAuditLog, commandName, nowEnabled, auditIp, timestamp) {
    if (commandAuditLog.length >= COMMAND_AUDIT_MAX) commandAuditLog.shift();
    commandAuditLog.push({
        commandName,
        action: nowEnabled ? "enabled" : "disabled",
        ip: auditIp,
        timestamp
    });
}

function notifyCommandToggle(commandName, nowEnabled, auditIp) {
    sendWebhookEvent({
        target: "LOG",
        severity: "INFO",
        category: "OWNER",
        code: nowEnabled ? "owner.command.enabled" : "owner.command.disabled",
        title: nowEnabled ? "เปิดใช้งานคำสั่งแล้ว" : "ปิดใช้งานคำสั่งแล้ว",
        context: {
            "คำสั่ง": `/${commandName}`,
            "สถานะใหม่": nowEnabled ? "เปิดใช้งาน" : "ปิดใช้งาน",
            "IP ผู้ดำเนินการ": auditIp
        }
    }).catch(() => {});
}

async function handleCommandToggle({
    req,
    res,
    checkAuth,
    commands,
    sessionManager,
    disabledCommands,
    commandAuditLog,
    toggleCooldowns,
    now = Date.now
}) {
    if (!checkAuth(req, res)) return;

    const validation = validateCommandToggleRequest(commands, req.body?.commandName);
    if (!validation.ok) return res.status(validation.status).json({ success: false, error: validation.error });

    const timestamp = now();
    const auditIp = hashAuditIp(req.ip);
    const toggleKey = `${auditIp}:${validation.commandName}`;
    const remainingMs = getCommandToggleCooldown(toggleCooldowns, toggleKey, timestamp);
    if (remainingMs > 0) {
        return res.status(429).json({
            success: false,
            error: `กรุณารอ ${(remainingMs / 1000).toFixed(1)}s`
        });
    }

    try {
        const result = await persistCommandToggle(sessionManager, disabledCommands, validation.commandName);
        if (!result.ok) {
            return res.status(503).json({
                success: false,
                error: "บันทึกสถานะคำสั่งไม่สำเร็จ กรุณาลองใหม่"
            });
        }

        toggleCooldowns.set(toggleKey, timestamp);
        recordCommandToggleAudit(
            commandAuditLog,
            validation.commandName,
            result.nowEnabled,
            auditIp,
            timestamp
        );
        notifyCommandToggle(validation.commandName, result.nowEnabled, auditIp);

        return res.json({
            success: true,
            commandName: validation.commandName,
            enabled: result.nowEnabled
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function sendGuildNotFoundKickResponse({
    res,
    sessionManager,
    guildId
}) {
    const removedApproval = await removeApprovedGuildRecord(sessionManager, guildId);
    const approvalCleanupFailed = removedApproval === false;

    return res.status(removedApproval ? 404 : 207).json({
        success: false,
        partialSuccess: approvalCleanupFailed,
        error: "บอทไม่ได้อยู่ใน guild นี้",
        approvalRemoved: removedApproval,
        warning: approvalCleanupFailed
            ? "บอทไม่ได้อยู่ใน guild นี้แล้ว แต่ลบ approved guild record ไม่สำเร็จ"
            : null
    });
}

async function handleApprovedGuildKick({
    req,
    res,
    checkAuth,
    client,
    sessionManager,
    voiceWorker
}) {
    if (!checkAuth(req, res)) return;

    try {
        const { guildId } = req.body;

        if (!guildId || typeof guildId !== "string") {
            return res.status(400).json({
                success: false,
                error: "Invalid guildId"
            });
        }

        const guild = client.guilds.cache.get(guildId);

        if (!guild) {
            return sendGuildNotFoundKickResponse({
                res,
                sessionManager,
                guildId
            });
        }

        const guildName = guild.name;
        const guildIconUrl = getDiscordGuildIconUrl(guild);
        const failedStops = await stopGuildVoiceSessions(sessionManager, voiceWorker, guildId);

        await guild.leave();

        const removedApproval = await removeApprovedGuildRecord(sessionManager, guildId);
        const approvalCleanupFailed = removedApproval === false;
        const partialSuccess = failedStops > 0 || approvalCleanupFailed;

        sendWebhookEvent({
            target: "LOG",
            severity: partialSuccess ? "WARNING" : "SUCCESS",
            category: "GUILD",
            code: partialSuccess ? "guild.leave.partial" : "guild.left",
            title: partialSuccess ? "บอทออกจากเซิร์ฟเวอร์แบบไม่สมบูรณ์" : "บอทออกจากเซิร์ฟเวอร์แล้ว",
            description: partialSuccess
                ? "บอทออกจากเซิร์ฟเวอร์สำเร็จ แต่มีงานทำความสะอาดบางส่วนไม่ครบ"
                : "เจ้าของนำบอทออกจากเซิร์ฟเวอร์ผ่าน Dashboard",
            context: {
                "เซิร์ฟเวอร์": guildName,
                "Guild ID": guildId,
                "Voice ที่หยุดไม่สำเร็จ": failedStops,
                "ลบข้อมูลอนุมัติแล้ว": removedApproval !== false
            },
            sourceIconUrl: guildIconUrl
        }).catch(() => {});

        return res.status(partialSuccess ? 207 : 200).json({
            success: !partialSuccess,
            partialSuccess,
            voiceStopFailed: failedStops,
            approvalRemoved: removedApproval,
            warning: partialSuccess
                ? buildApprovedKickWarning(failedStops, approvalCleanupFailed)
                : null
        });
    } catch (e) {
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
}

function registerAdminRoutes({
    app,
    express,
    sessionManager,
    voiceWorker,
    commands,
    client,
    checkAuth,
    disabledCommands,
    commandAuditLog,
    toggleCooldowns,
    startRotateTimer,
    ROTATE_MESSAGES_MAX
}) {
    app.get("/api/quest-logs", auth.requirePin, async (req, res) => {
        try {
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
            const logs = getQuestLogRepository().findRecent(limit);
            const safeLogs = logs.map(l => {
                const safeAccounts = (l.accounts || []).map(acc => {
                    const { encryptedToken, ...safeAcc } = acc;
                    return safeAcc;
                });
                return { ...l, accounts: safeAccounts };
            });
            res.json({ success: true, logs: safeLogs });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/quest-scheduled", auth.requirePin, async (req, res) => {
        try {
            const list = getScheduledRunnerRepository().find();
            const safeRunners = list.map(r => {
                const { token_ciphertext, token_iv, token_tag, token_salt, ...safe } = r;
                return safe;
            });
            res.json({ success: true, runners: safeRunners });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete("/api/quest-scheduled/:id", auth.requirePin, async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || (!/^[0-9a-fA-F]{24}$/.test(String(id).trim()) && !/^\d+$/.test(String(id).trim()))) {
                return res.status(400).json({ success: false, error: "Invalid scheduled runner ID" });
            }
            const cleanId = String(id).trim();
            const stopped = stopScheduledJob(null, cleanId, { asAdmin: true });
            const deleted = getScheduledRunnerRepository().deleteById(cleanId);
            res.json({ success: true, deleted: Boolean(deleted), stopped });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Guild Approval Listing ──
    app.get("/api/pending-guilds", async (_req, res) => {
        try {
            const pending = await sessionManager.getPendingGuilds();
            res.json({ success: true, pending });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/approved-guilds", async (_req, res) => {
        try {
            const approved = await sessionManager.getApprovedGuildDocs?.();
            res.json({ success: true, approved: approved || [] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Commands Status / Toggle / Audit ──
    app.get("/api/commands-status", (req, res) => {
        try {
            res.json(buildCommandStatusPayload(commands, disabledCommands));
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/commands/toggle", express.json(), (req, res) => handleCommandToggle({
        req,
        res,
        checkAuth,
        commands,
        sessionManager,
        disabledCommands,
        commandAuditLog,
        toggleCooldowns
    }));

    app.get("/api/commands-audit", (req, res) => {
        res.json(buildCommandAuditPayload(commandAuditLog));
    });

    // ── Settings ──
    app.post("/api/settings", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                maxSessions,
                rateLimitRequests,
                idleTimeoutHrs,
                antiRaidEnabled,
                voiceDmMode
            } = req.body;

            if (maxSessions) await sessionManager.setSetting("maxSessions", maxSessions);
            if (rateLimitRequests) await sessionManager.setSetting("rateLimitRequests", rateLimitRequests);
            if (idleTimeoutHrs) await sessionManager.setSetting("idleTimeoutHrs", idleTimeoutHrs);
            if (antiRaidEnabled !== undefined) await sessionManager.setSetting("antiRaidEnabled", antiRaidEnabled);
            if (["important_only", "all", "off"].includes(voiceDmMode)) {
                await sessionManager.setSetting("voiceDmMode", voiceDmMode);
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Presence ──
    app.post("/api/presence", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                botStatus,
                botActivityType,
                botActivity,
                botNote
            } = req.body;

            if (!["online", "idle", "dnd", "invisible"].includes(botStatus)) {
                return res.status(400).json({
                    success: false,
                    error: "สถานะไม่ถูกต้อง"
                });
            }

            if (!botActivity?.trim()) {
                return res.status(400).json({
                    success: false,
                    error: "กรุณากรอกข้อความกิจกรรม"
                });
            }

            const actType = ["WATCHING", "LISTENING", "PLAYING", "COMPETING"].includes(botActivityType)
                ? botActivityType
                : "WATCHING";

            await sessionManager.setSetting("botStatus", botStatus);
            await sessionManager.setSetting("botActivityType", actType);
            await sessionManager.setSetting("botActivity", botActivity.trim().slice(0, 128));
            await sessionManager.setSetting("botNote", (botNote || "").trim().slice(0, 128));

            if (client?.isReady?.()) {
                const activities = [
                    {
                        name: botActivity.trim().slice(0, 128),
                        type: resolveActivityType(actType)
                    }
                ];

                if (botNote?.trim()) {
                    activities.push({
                        name: botNote.trim().slice(0, 128),
                        type: resolveActivityType("CUSTOM")
                    });
                }

                client.user.setPresence({
                    status: botStatus,
                    activities
                });
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/presence/rotate", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                rotateEnabled,
                rotateInterval,
                rotateMessages
            } = req.body;

            if (typeof rotateEnabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "rotateEnabled ต้องเป็น boolean"
                });
            }

            const interval = Math.max(1, Number.parseInt(rotateInterval, 10) || 5);
            const msgs = Array.isArray(rotateMessages)
                ? rotateMessages.map(m => String(m).trim().slice(0, 128)).filter(Boolean).slice(0, ROTATE_MESSAGES_MAX)
                : [];

            await sessionManager.setSetting("rotateEnabled", rotateEnabled);
            await sessionManager.setSetting("rotateInterval", interval);
            await sessionManager.setSetting("rotateMessages", msgs);

            await startRotateTimer();

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Approved Guilds ──
    app.post("/api/approve", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            await sessionManager.ApprovedGuildModel.updateOne(
                { guildId },
                { $setOnInsert: { guildId } },
                { upsert: true }
            );

            await sessionManager.PendingGuildModel.deleteOne({ guildId });

            const guild = client.guilds.cache.get(guildId);
            sendWebhookEvent({
                target: "LOG",
                severity: "SUCCESS",
                category: "GUILD",
                code: "guild.approved",
                title: "อนุมัติเซิร์ฟเวอร์แล้ว",
                context: {
                    "เซิร์ฟเวอร์": guild?.name || "ไม่พบชื่อใน Cache",
                    "Guild ID": guildId
                },
                sourceIconUrl: getDiscordGuildIconUrl(guild)
            }).catch(() => {});

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/remove", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            const removedApproval = await removeApprovedGuildRecord(sessionManager, guildId);

            if (!removedApproval) {
                return res.status(503).json({
                    success: false,
                    error: "Failed to remove approved guild record"
                });
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/kick", express.json(), (req, res) => handleApprovedGuildKick({
        req,
        res,
        checkAuth,
        client,
        sessionManager,
        voiceWorker
    }));

    app.get("/api/token-hub/status", (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const summary = tokenCoordinator.getStatusSummary();
            res.json({ success: true, ...summary });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/token-hub/quarantine/release", express.json(), (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const { tokenHash } = req.body || {};
            if (!tokenHash || typeof tokenHash !== "string") {
                return res.status(400).json({ success: false, error: "Invalid tokenHash" });
            }
            const released = tokenCoordinator.releaseQuarantine(tokenHash);
            res.json({ success: true, released });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/token-hub/cache/clear", express.json(), (req, res) => {
        if (!checkAuth(req, res)) return;
        try {
            const { tokenHash } = req.body || {};
            tokenCoordinator.clearTokenProfileCache(tokenHash || null);
            res.json({ success: true, cleared: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

module.exports = {
    registerAdminRoutes,
    removeApprovedGuildRecord,
    stopGuildVoiceSessions,
    buildApprovedKickWarning,
    validateCommandToggleRequest,
    getCommandToggleCooldown,
    createCommandTogglePlan,
    persistCommandToggle,
    recordCommandToggleAudit,
    handleCommandToggle,
    handleApprovedGuildKick,
    _test: {
        validateCommandToggleRequest,
        getCommandToggleCooldown,
        createCommandTogglePlan,
        persistCommandToggle,
        recordCommandToggleAudit,
        handleCommandToggle,
        handleApprovedGuildKick
    }
};
