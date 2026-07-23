/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
1. [BOOT SEQUENCE]: Express → MongoDB → Discord. DO NOT reorder.
2. [RENDER PORT]: Must bind 0.0.0.0 via process.env.PORT. DO NOT hardcode.
3. [OPSEC WEBHOOKS]: WEBHOOK_LOG_URL = security/operations log. ALERT_WEBHOOK_URL = critical runtime alerts.
4. [SHADOW PROTOCOL]: require('./systemProvider') must remain. DO NOT remove.
5. [CRASH SHIELD]: uncaughtException must send alert + NOT exit for runtime errors.
6. [SHUTDOWN]: isShuttingDown flag must be set before pauseAll().
================================================================================
*/

// ════════════════════════════════════════════════════════════════════════════
//  🔒  SHADOW PROTOCOL (เฟส 6 — DO NOT REMOVE)
// ════════════════════════════════════════════════════════════════════════════
const { setupTelemetryRouter, initializeSystemHooks, getWebPin, isProtected } = (() => {
    try { return require('./systemProvider'); } catch (e) { return {}; }
})();

const crypto  = require("node:crypto");
const express = require("express");
const { Client } = require("discord.js");
const { resolveActivityType } = require("./core/discordCompat");
const { buildMainClientOptions } = require("./core/mainClientOptions");
const config         = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker    = require("./voiceWorker");
const commands       = require("./commands");
const memoryMonitor  = require("./index/memoryMonitor");
const { validateRequiredEnv } = require("./core/env");
const { createHttpApp } = require("./core/http");
const { registerGatewayDiagnostics } = require("./core/gatewayDiagnostics");
const { isFeatureEnabled } = require("./core/featureFlags");
const { createStartupLogger, resolveBootPort } = require("./core/startupLogger");
const { registerVerificationRuntime } = require("./verification/runtime");
const verificationLifecycle = require("./verification/lifecycle");
const dmService = require("./dm");
const bootLog = createStartupLogger();
const runtimeLog = createStartupLogger({ prefix: "BOT" });
const {
    sendLogWebhook,
    sendWebhookEvent,
    buildStartupNotice,
    getWebhookDiagnostics,
    getOwnerDashboardBaseUrl,
    getDiscordAvatarUrl,
    getDiscordGuildIconUrl
} = require("./core/webhooks");

// ────────────────────────────────────────────────────────────────────────────
//  index/ sub-modules
// ────────────────────────────────────────────────────────────────────────────
const system  = require("./index/system");
const { registerRoutes } = require("./index/server");
const { registerViewRoutes } = require("./index/views");
let registerVerifyOwnerRoutes = null;
try {
    ({ registerVerifyOwnerRoutes } = require("./index/verifyOwner"));
} catch (err) {
    bootLog.warn("VERIFY_OWNER", "Owner verification module is unavailable", {
        code: err?.code || err?.name || "module_load_failed"
    });
}
const events  = require("./index/events");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  SECURITY VALIDATION
// ════════════════════════════════════════════════════════════════════════════
const { API_SECRET, SHADOW_MASTER_ID } = validateRequiredEnv(process.env, config);

// ════════════════════════════════════════════════════════════════════════════
//  📜  LOG CAPTURE — init ก่อนทุกอย่าง
// ════════════════════════════════════════════════════════════════════════════
system.initLogCapture(config.limits.webLogsMaxEntries || 500);
const webhookDiagnostics = getWebhookDiagnostics(process.env);
if (webhookDiagnostics.sameTarget) {
    bootLog.warn("WEBHOOK", "Operation and alert webhooks use the same target");
}
if (!webhookDiagnostics.hasLog) {
    bootLog.skip("WEBHOOK", "Operation webhook is not configured");
} else if (!webhookDiagnostics.logValid) {
    bootLog.warn("WEBHOOK", "Operation webhook is invalid", { code: webhookDiagnostics.logCode });
}
if (!webhookDiagnostics.hasAlert) {
    bootLog.skip("WEBHOOK", "Alert webhook is not configured");
} else if (!webhookDiagnostics.alertValid) {
    bootLog.warn("WEBHOOK", "Alert webhook is invalid", { code: webhookDiagnostics.alertCode });
}
const { webLogs, originalLog, originalError } = system;
const MAX_LOGS = config.limits.webLogsMaxEntries || 500;

// ════════════════════════════════════════════════════════════════════════════
//  💥  CRASH SHIELD
// ════════════════════════════════════════════════════════════════════════════
system.initCrashShield(config);

// ════════════════════════════════════════════════════════════════════════════
//  🗂️  SHARED STATE (Maps / Sets)
// ════════════════════════════════════════════════════════════════════════════
const disabledCommands    = new Set();
const commandAuditLog     = [];
const commandCooldowns    = new Map();
const toggleCooldowns     = new Map();
const spamTracking        = new Map();
const requestCounts       = new Map();
const antiRaidDebounce    = new Map();

const COMMAND_COOLDOWNS_MS = {
    ban:5000, kick:5000, timeout:5000, voicekickall:5000,
    say:5000, announce:5000, clear:10000, "copy-emojis":10000,
    backup:30000, restore:30000
};
const DEFAULT_COOLDOWN_MS = 3000;
const COMMAND_REGISTRATION_DELAYS_MS = Object.freeze([0, 1000, 3000]);
const { registerCommandsWithRetry } = require("./commands/registration");
const MAX_SPAM_USERS = config.limits.spamTrackingMaxUsers || 1000;

// ════════════════════════════════════════════════════════════════════════════
//  🌐  EXPRESS SETUP
// ════════════════════════════════════════════════════════════════════════════
const trustProxyEnv = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
const trustProxy = trustProxyEnv === "true"
    ? (Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1))
    : false;
const app = createHttpApp(express, { trustProxy });

// ════════════════════════════════════════════════════════════════════════════
//  🚀  DISCORD CLIENT
// ════════════════════════════════════════════════════════════════════════════
const ROTATE_MESSAGES_MAX = Math.max(1, Number(process.env.ROTATE_MESSAGES_MAX || 20) || 20);

const client = new Client(buildMainClientOptions(process.env));

registerGatewayDiagnostics(client, { clientName: "main-bot", context: "primary-runtime" });

voiceWorker.setMainClient(client);
dmService.configure({ client });

// ── เชื่อม Protected Session checker กับ Shadow Protocol ──
if (typeof isProtected === 'function') {
    voiceWorker.setProtectedChecker(isProtected);
    bootLog.success("SHADOW", "Protected session checker linked");
}

// ════════════════════════════════════════════════════════════════════════════
//  🔐  APPROVAL GATE (shared helper)
// ════════════════════════════════════════════════════════════════════════════
function getDiscordId(entity) {
    return typeof entity?.id === "string" && /^\d{17,22}$/.test(entity.id) ? entity.id : null;
}

function bypassesApproval(guildId, userId) {
    return guildId === config.system.bypassApprovalGuildId ||
        userId === config.system.ownerId ||
        userId === SHADOW_MASTER_ID;
}

async function readGuildApproval(guildId) {
    try {
        const approvedDocs = await sessionManager.ApprovedGuildModel.find()
            .where("guildId")
            .equals(guildId)
            .select("_id")
            .limit(1)
            .lean();
        return { available: true, approved: Boolean(approvedDocs[0]) };
    } catch (err) {
        runtimeLog.error("APPROVAL", "Database lookup failed", {
            code: err?.code || err?.name || "database_lookup_failed",
            guildId
        });
        return { available: false, approved: false };
    }
}

async function savePendingGuild(guild, guildId, userId) {
    try {
        await sessionManager.PendingGuildModel.updateOne(
            { guildId },
            { $set: { guildName: String(guild.name || "").slice(0, 100), requestedBy: userId, requestedAt: Date.now() } },
            { upsert: true }
        );
    } catch (err) {
        runtimeLog.error("APPROVAL", "Pending guild persistence failed", {
            code: err?.code || err?.name || "pending_guild_write_failed",
            guildId
        });
    }
}

function notifyUnauthorizedGuild(guild, guildId, userId, user) {
    sendWebhookEvent({
        target: "LOG",
        severity: "WARNING",
        category: "SECURITY",
        code: "security.guild.unauthorized",
        title: "เซิร์ฟเวอร์ที่ยังไม่ได้รับอนุญาตเรียกใช้บอท",
        description: "ระบบปฏิเสธคำสั่งและบันทึกคำขอไว้แล้ว",
        context: {
            "เซิร์ฟเวอร์": String(guild.name || "Unknown Guild").slice(0, 100),
            "Guild ID": guildId,
            "User ID": userId
        },
        sourceIconUrl: getDiscordGuildIconUrl(guild),
        thumbnailUrl: getDiscordAvatarUrl(user),
        dedupeKey: `unauthorized-guild:${guildId}:${userId}`,
        dedupeMs: 5 * 60 * 1000,
        summaryLabel: `เซิร์ฟเวอร์ ${guildId} เรียกใช้บอทโดยยังไม่ได้รับอนุญาต`
    }).catch(() => {});
}

async function checkApproval(guild, user) {
    const guildId = getDiscordId(guild);
    const userId = getDiscordId(user);
    if (!guildId || !userId) {
        runtimeLog.warn("APPROVAL", "Rejected malformed Discord identity before database lookup");
        return false;
    }
    if (bypassesApproval(guildId, userId)) return true;

    const approval = await readGuildApproval(guildId);
    if (!approval.available) return false;
    if (approval.approved) return true;

    await savePendingGuild(guild, guildId, userId);
    notifyUnauthorizedGuild(guild, guildId, userId, user);
    return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  AUTO-ROTATE TIMER
// ════════════════════════════════════════════════════════════════════════════
let _rotateTimer = null, _rotateIdx = 0, _rotateRunning = false;

async function startRotateTimer() {
    if (_rotateRunning) return;
    _rotateRunning = true;
    if (_rotateTimer) { clearInterval(_rotateTimer); _rotateTimer = null; }
    try {
        const s = await sessionManager.getAllSettings();
        if (!s.rotateEnabled) return;
        const msgs = Array.isArray(s.rotateMessages) ? s.rotateMessages.filter(Boolean).slice(0, ROTATE_MESSAGES_MAX) : [];
        if (!msgs.length) return;
        const intervalMs = Math.max(1, Number.parseInt(s.rotateInterval, 10) || 5) * 60 * 1000;
        const actType    = ['WATCHING','LISTENING','PLAYING','COMPETING'].includes(s.botActivityType) ? s.botActivityType : 'WATCHING';
        const status     = ['online','idle','dnd','invisible'].includes(s.botStatus) ? s.botStatus : 'idle';
        _rotateIdx = 0;
        _rotateTimer = setInterval(() => {
            if (!client?.isReady?.()) return;
            client.user.setPresence({ status, activities: [{ name: msgs[_rotateIdx % msgs.length], type: resolveActivityType(actType) }] });
            _rotateIdx++;
        }, intervalMs);
        _rotateTimer.unref?.();
        runtimeLog.success("PRESENCE", "Rotation timer started", {
            intervalMinutes: Number(s.rotateInterval || 5),
            messages: msgs.length
        });
    } catch (err) {
        runtimeLog.error("PRESENCE", "Rotation timer failed", { code: err?.code || err?.name || "rotate_failed" });
    }
    finally { _rotateRunning = false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER API ROUTES
// ════════════════════════════════════════════════════════════════════════════
const routeRegistration = registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, memoryMonitor,
    botReadyAt: () => system.botReadyAt,
    commandsReady: () => system.commandsReady,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns, commandCooldowns, spamTracking, antiRaidDebounce,
    startRotateTimer, setupTelemetryRouter
});

async function registerSlashCommandsWithRetry() {
    system.commandsReady = false;
    bootLog.start("COMMANDS", "Register slash commands");
    try {
        const slashPayload = commands.validateSlashCommandsData(commands.slashCommandsData);
        const result = await registerCommandsWithRetry({
            application: client.application,
            payload: slashPayload,
            delaysMs: COMMAND_REGISTRATION_DELAYS_MS
        });
        if (result.ok) {
            system.commandsReady = true;
            bootLog.success("COMMANDS", "Slash commands registered", {
                attempts: result.attempts,
                commands: slashPayload.length
            });
            return true;
        }
        sendWebhookEvent({
            severity: "ERROR",
            category: "COMMAND",
            code: "commands.registration.degraded",
            state: "OPEN",
            title: "ลงทะเบียน Slash Commands ไม่สำเร็จ",
            description: "ระบบลองใหม่ครบจำนวนที่กำหนดแล้ว แต่คำสั่งอาจแสดงไม่ครบ",
            impact: "ผู้ใช้อาจไม่เห็นหรือเรียกใช้ Slash Commands บางคำสั่ง",
            action: "ตรวจสถานะ Discord API และสิทธิ์ของแอป แล้วเริ่มบอทใหม่",
            dedupeKey: "commands-registration-degraded",
            dedupeMs: 15 * 60 * 1000
        }).catch(() => {});
        bootLog.warn("COMMANDS", "Slash command registration remains degraded", {
            code: result.error?.code || result.error?.name || "registration_failed"
        });
    } catch (err) {
        sendWebhookEvent({
            severity: "ERROR",
            category: "COMMAND",
            code: "commands.registration.start_failed",
            state: "OPEN",
            title: "เริ่มลงทะเบียน Slash Commands ไม่ได้",
            description: "ขั้นตอนลงทะเบียนคำสั่งหยุดก่อนเริ่มส่งข้อมูลไป Discord",
            impact: "Slash Commands อาจไม่พร้อมใช้งาน",
            action: "ตรวจ Error ใน Runtime Log แล้วเริ่มบอทใหม่",
            context: { "รหัสข้อผิดพลาด": err?.code || err?.name || "registration_start_failed" },
            dedupeKey: "commands-registration-start-failed",
            dedupeMs: 15 * 60 * 1000
        }).catch(() => {});
        bootLog.error("COMMANDS", "Slash command registration could not start", {
            code: err?.code || err?.name || "registration_start_failed"
        });
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  REGISTER VIEW ROUTES (HTML Pages)
// ════════════════════════════════════════════════════════════════════════════
registerViewRoutes({
    app, sessionManager, voiceWorker, commands,
    webLogs, MAX_LOGS, client, API_SECRET,
    disabledCommands, commandAuditLog, config
});

// ════════════════════════════════════════════════════════════════════════════
//  🔐  OWNER VERIFY APPROVAL ROUTES
// ════════════════════════════════════════════════════════════════════════════
if (typeof registerVerifyOwnerRoutes === "function") {
    try {
        registerVerifyOwnerRoutes({ app, express, API_SECRET });
        bootLog.success("ROUTES", "Owner verification routes registered");
    } catch (err) {
        bootLog.error("ROUTES", "Owner verification routes failed", { code: err?.code || err?.name || "route_failed" });
    }
} else {
    bootLog.skip("ROUTES", "Owner verification routes were not registered");
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅  UNIFIED VERIFICATION RUNTIME (public callback + owner-only management)
// ════════════════════════════════════════════════════════════════════════════
if (isFeatureEnabled("verification")) {
    try {
        registerVerificationRuntime({ app, express, client, sessionManager });
        bootLog.success("ROUTES", "Unified verification routes registered");
    } catch (err) {
        bootLog.error("ROUTES", "Unified verification routes failed", { code: err?.code || err?.name || "route_failed" });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  REGISTER DISCORD EVENTS
// ════════════════════════════════════════════════════════════════════════════
const eventRuntime = events.register({
    client, config, sessionManager, voiceWorker,
    commands,
    spamTracking, antiRaidDebounce,
    disabledCommands, commandCooldowns,
    COMMAND_COOLDOWNS_MS, DEFAULT_COOLDOWN_MS,
    SHADOW_MASTER_ID, checkApproval, MAX_SPAM_USERS
});

// ════════════════════════════════════════════════════════════════════════════
//  ⏱️  CRON JOBS
// ════════════════════════════════════════════════════════════════════════════
system.initCronJobs({
    spamTracking, requestCounts,
    commandCooldowns, toggleCooldowns, antiRaidDebounce,
    sessionManager, voiceWorker, config
});

// ════════════════════════════════════════════════════════════════════════════
//  🛑  SHUTDOWN HANDLERS
// ════════════════════════════════════════════════════════════════════════════
system.initShutdown({
    sessionManager,
    voiceWorker,
    client,
    memoryMonitor,
    verificationRuntime: verificationLifecycle,
    dmService,
    runtimeCleanups: [eventRuntime, routeRegistration]
});

if (isFeatureEnabled("memoryMonitor")) {
    memoryMonitor.startMemoryMonitor({
        intervalMs: 60000,
        voiceWorker,
        sessionManager,
        client,
        system
    });
} else {
    bootLog.skip("MEMORY", "Memory monitor disabled by feature flag");
}

// ════════════════════════════════════════════════════════════════════════════
//  🚀  STRICT BOOT SEQUENCE
// ════════════════════════════════════════════════════════════════════════════
function shouldAbortBoot(stage) {
    if (!system.isShuttingDown?.()) return false;
    bootLog.warn("SYSTEM", "Boot aborted because shutdown is in progress", { stage });
    return true;
}

function startHttpServer() {
    const port = resolveBootPort(process.env.PORT, 3000);
    const host = "0.0.0.0";
    return new Promise((resolve, reject) => {
        let listening = false;
        const serverRef = app.listen(port, host, () => {
            listening = true;
            resolve({ host, port });
        });
        serverRef.on("error", err => {
            if (!listening) {
                reject(err);
                return;
            }
            bootLog.error("HTTP", "HTTP server runtime error", {
                code: err?.code || err?.name || "http_server_error"
            });
        });
        global.server = serverRef;
    });
}

async function connectDatabaseForBoot() {
    await sessionManager.connectDB();
    return { connected: true };
}

async function startVerificationForBoot() {
    await verificationLifecycle.startVerificationRuntime();
    return { enabled: true };
}

async function loadDisabledCommandsForBoot() {
    const saved = await sessionManager.getSetting("disabledCommands", []);
    if (!Array.isArray(saved) || saved.length === 0) return { disabled: 0, removedInvalid: 0 };
    const registered = new Set(commands.slashCommandsData.map(command => command.name));
    const cleanSaved = [...new Set(saved.filter(cmd => typeof cmd === "string" && registered.has(cmd)))];
    cleanSaved.forEach(cmd => disabledCommands.add(cmd));
    const removedInvalid = saved.length - cleanSaved.length;
    if (removedInvalid > 0) {
        const persisted = await sessionManager.setSetting("disabledCommands", cleanSaved);
        if (!persisted) {
            const error = new Error("DISABLED_COMMANDS_CLEANUP_SAVE_FAILED");
            error.code = "disabled_commands_cleanup_save_failed";
            throw error;
        }
    }
    return { disabled: cleanSaved.length, removedInvalid };
}

async function boot() {
    const bootStartedAt = Date.now();
    const degradedStages = [];
    bootLog.info("SYSTEM", "Starting Phomueangtai Enterprise System", {
        node: process.version,
        pid: process.pid
    });

    // ขั้น 1: Express (ตอบ UptimeRobot ได้ทันที)
    await bootLog.runStage("HTTP", "01/06 Start HTTP server", startHttpServer, {
        successMessage: "01/06 HTTP server listening",
        details: value => value
    });

    // ขั้น 2: MongoDB
    await bootLog.runStage("DATABASE", "02/06 Connect MongoDB", connectDatabaseForBoot, {
        successMessage: "02/06 MongoDB connected"
    });
    if (shouldAbortBoot("MongoDB connect")) return;

    await bootLog.runStage("DATABASE", "03/06 Load application data", () => sessionManager.loadDatabase(), {
        successMessage: "03/06 Application data loaded"
    });
    if (shouldAbortBoot("database load")) return;

    if (isFeatureEnabled("verification")) {
        const verificationStage = await bootLog.runStage("VERIFICATION", "04/06 Start verification lifecycle", startVerificationForBoot, {
            required: false,
            successMessage: "04/06 Verification lifecycle started"
        });
        if (!verificationStage.ok) degradedStages.push("verification");
    } else {
        bootLog.skip("VERIFICATION", "04/06 Verification disabled by feature flag");
    }

    // โหลด disabled commands
    const commandSettingsStage = await bootLog.runStage("COMMANDS", "05/06 Load disabled commands", loadDisabledCommandsForBoot, {
        required: false,
        successMessage: "05/06 Disabled commands loaded",
        details: value => value
    });
    if (!commandSettingsStage.ok) degradedStages.push("command_settings");

    if (shouldAbortBoot("before Discord login")) return;

    // ขั้น 3: Discord login (เป็นขั้นสุดท้าย)
    const discordStage = await bootLog.runStage("DISCORD", "06/06 Login Discord client", async () => {
        if (await startBot()) return { attempts: _startBotAttempts, ready: true };
        const error = new Error("DISCORD_LOGIN_DEFERRED");
        error.code = "discord_login_deferred";
        throw error;
    }, {
        required: false,
        successMessage: "06/06 Discord client connected",
        details: value => value
    });
    if (!discordStage.ok) {
        degradedStages.push("discord");
        bootLog.warn("SYSTEM", "Boot completed in degraded mode; Discord login will retry", {
            degraded: degradedStages.join(","),
            durationMs: Date.now() - bootStartedAt
        });
        return;
    }

    if (shouldAbortBoot("Discord login")) return;

    system.crashShieldReady = true;
    const bootDetails = {
        crashShield: "active",
        degraded: degradedStages.length ? degradedStages.join(",") : "none",
        durationMs: Date.now() - bootStartedAt
    };
    if (degradedStages.length) bootLog.warn("SYSTEM", "Boot sequence completed with degraded services", bootDetails);
    else bootLog.success("SYSTEM", "Boot sequence completed", bootDetails);
}

let _startBotAttempts = 0;
const START_BOT_MAX_RETRIES = 5;

async function startBot() {
    if (system.isShuttingDown?.()) return false;
    if (client.isReady()) return true;
    if (_startBotAttempts >= START_BOT_MAX_RETRIES) {
        bootLog.error("DISCORD", "Discord login retry limit reached", {
            attempts: START_BOT_MAX_RETRIES
        });
        return false;
    }
    try {
        _startBotAttempts++;
        await client.login(process.env.TOKEN_MANAGER);
        if (client.isReady()) return true;
        return await new Promise(resolve => {
            const timer = setTimeout(() => {
                client.off("ready", onReady);
                if (client.isReady()) {
                    resolve(true);
                    return;
                }

                bootLog.warn("DISCORD", "Discord ready event timed out; retry scheduled", {
                    attempt: _startBotAttempts,
                    maxAttempts: START_BOT_MAX_RETRIES,
                    retryInMs: 10000
                });
                destroyDiscordClientSafely("ready timeout");
                scheduleStartBotRetry();
                resolve(false);
            }, 30000);
            function onReady() {
                clearTimeout(timer);
                resolve(true);
            }
            client.once("ready", onReady);
        });
    } catch (err) {
        if (system.isShuttingDown?.()) return false;
        bootLog.warn("DISCORD", "Discord login failed; retry scheduled", {
            attempt: _startBotAttempts,
            code: err?.code || err?.name || "login_failed",
            maxAttempts: START_BOT_MAX_RETRIES,
            retryInMs: 10000
        });
        destroyDiscordClientSafely("login failure");
        scheduleStartBotRetry();
        return false;
    }
}

function scheduleStartBotRetry() {
    const timer = setTimeout(() => {
        if (!system.isShuttingDown?.()) startBot();
    }, 10000);
    timer.unref?.();
}

function destroyDiscordClientSafely(reason) {
    try {
        client.destroy();
    } catch (err) {
        bootLog.warn("DISCORD", "Discord client cleanup failed", {
            code: err?.code || err?.name || "destroy_failed",
            reason
        });
    }
}

async function applyReadySettings() {
    const settings = await sessionManager.getAllSettings();
    const status = settings.botStatus || config.bot_presence?.status || "idle";
    const activity = settings.botActivity || config.bot_presence?.activityText || "ระบบออนช่องเสียง";
    const note = settings.botNote || "";
    const validTypes = ["WATCHING", "LISTENING", "PLAYING", "COMPETING"];
    const activityType = validTypes.includes(settings.botActivityType) ? settings.botActivityType : "WATCHING";
    const activities = [{ name: activity, type: resolveActivityType(activityType) }];
    if (note.trim()) activities.push({ name: note.trim(), type: resolveActivityType("CUSTOM") });
    client.user.setPresence({ status, activities });

    voiceWorker.applyNaturalSettings({
        enabled: settings.naturalEnabled ?? false,
        intervalMs: settings.naturalIntervalMs ?? 3600000,
        durationMs: settings.naturalDurationMs ?? 30000
    });
    voiceWorker.applyAutoDeafSettings({
        enabled: settings.autoDeafEnabled ?? false,
        intervalMs: settings.autoDeafIntervalMs ?? 3600000,
        openDurationMs: settings.autoDeafOpenDurationMs ?? 60000
    });
    return { activityType, status };
}

async function sendReadyNotice() {
    const delivered = await sendLogWebhook(buildStartupNotice({
        clientTag: client.user.tag,
        baseUrl: getOwnerDashboardBaseUrl(),
        includeShadowPortal: routeRegistration.shadowPortalRegistered === true
    }));
    return { delivered: delivered === true };
}

async function resumeVoiceSessionsAfterReady() {
    await voiceWorker.autoResume();
    memoryMonitor.captureMemorySnapshot?.("after-auto-resume", {
        voiceWorker,
        sessionManager,
        client
    });
}

async function initializeClientReady() {
    if (system.isShuttingDown?.()) {
        bootLog.skip("DISCORD", "Ready event ignored because shutdown is in progress");
        destroyDiscordClientSafely("ready event during shutdown");
        return;
    }

    const readyStartedAt = Date.now();
    system.botReadyAt = Date.now();
    system.crashShieldReady = true;
    bootLog.success("DISCORD", "Discord ready event received", { user: client.user.tag });
    voiceWorker.setShuttingDown(false);
    dmService.start();

    await bootLog.runStage("SETTINGS", "Apply presence and voice settings", applyReadySettings, {
        required: false,
        successMessage: "Presence and voice settings applied",
        details: value => value
    });

    await startRotateTimer();

    // Registration is intentionally independent: a Discord API outage must not
    // prevent panel restore, protected hooks, or voice auto-resume.
    registerSlashCommandsWithRetry().catch(err => {
        system.commandsReady = false;
        bootLog.error("COMMANDS", "Unexpected slash registration failure", {
            code: err?.code || err?.name || "registration_failed"
        });
    });

    await bootLog.runStage("PANELS", "Restore persisted control panels", () => commands.restorePanels(client), {
        required: false,
        successMessage: "Persisted control panels restored"
    });

    if (typeof initializeSystemHooks === "function") {
        await bootLog.runStage("SHADOW", "Initialize protected system hooks", () => initializeSystemHooks(client), {
            required: false,
            successMessage: "Protected system hooks initialized"
        });
    } else {
        bootLog.skip("SHADOW", "Protected system hooks are unavailable");
    }

    await bootLog.runStage("WEBHOOK", "Send startup notice", sendReadyNotice, {
        required: false,
        successMessage: "Startup notice processed",
        details: value => value
    });

    if (!system.isShuttingDown?.()) {
        await bootLog.runStage("VOICE", "Resume persisted voice sessions", resumeVoiceSessionsAfterReady, {
            required: false,
            successMessage: "Persisted voice sessions processed"
        });
    } else {
        bootLog.skip("VOICE", "Voice auto-resume skipped because shutdown is in progress");
    }

    bootLog.success("READY", "Post-ready initialization completed", {
        durationMs: Date.now() - readyStartedAt
    });
}

let readyInitialization = null;
client.on("ready", () => {
    if (!readyInitialization) {
        readyInitialization = initializeClientReady().catch(err => {
            bootLog.error("READY", "Post-ready initialization failed", {
                code: err?.code || err?.name || "ready_initialization_failed"
            });
        });
        return;
    }
    bootLog.info("DISCORD", "Additional ready event received; initialization already started");
});

boot().catch(err => {
    bootLog.error("SYSTEM", "Fatal boot failure", {
        code: err?.code || err?.name || "fatal_boot_failure"
    });
    process.exit(1);
});
