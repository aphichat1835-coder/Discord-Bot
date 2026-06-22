/*
 * Protection Audit
 * Wick-style evidence and action-result helpers for anti-raid, anti-spam, anti-link,
 * and future anti-nuke/quarantine systems.
 */

const { safeAuditText, LOG_TYPES, LOG_CHANNEL_TYPES, routeAndSendLog } = require("./logCore");
const { buildLogEmbed, field, formatDiscordTime } = require("./logFormat");
const modCaseManager = require("./modCaseManager");

function normalizeEvidenceItem(item) {
    if (item === undefined || item === null) return null;
    if (typeof item === "string") return safeAuditText(item, 300);
    if (typeof item === "number" || typeof item === "boolean") return String(item);

    try {
        return safeAuditText(JSON.stringify(item), 300);
    } catch {
        return safeAuditText(String(item), 300);
    }
}

function createEvidence(input = {}) {
    const evidence = [];

    if (Array.isArray(input.evidence)) {
        for (const item of input.evidence) {
            const normalized = normalizeEvidenceItem(item);
            if (normalized) evidence.push(normalized);
        }
    }

    if (input.messageCount != null) evidence.push(`Messages: ${input.messageCount}`);
    if (input.channelCount != null) evidence.push(`Channels involved: ${input.channelCount}`);
    if (input.linkCount != null) evidence.push(`Links: ${input.linkCount}`);
    if (input.suspiciousLinkCount != null) evidence.push(`Suspicious links: ${input.suspiciousLinkCount}`);
    if (input.everyoneMentions != null) evidence.push(`@everyone/@here mentions: ${input.everyoneMentions}`);
    if (input.roleChanges != null) evidence.push(`Role changes: ${input.roleChanges}`);
    if (input.channelChanges != null) evidence.push(`Channel changes: ${input.channelChanges}`);

    return evidence.slice(0, 25);
}

function createActionResult(input = {}) {
    return {
        action: safeAuditText(input.action || "log", 80),
        attempted: input.attempted !== false,
        success: input.success === true,
        reason: input.reason ? safeAuditText(input.reason, 300) : null,
        error: input.error ? safeAuditText(input.error, 300) : null,
        dmSent: input.dmSent === true,
        rolesRemoved: Number(input.rolesRemoved || 0),
        timeoutMs: input.timeoutMs ? Number(input.timeoutMs) : null,
        caseNumber: input.caseNumber || null
    };
}

function buildProtectionEvent(input = {}) {
    const now = Date.now();
    const actionResult = createActionResult(input.actionResult || input);
    const evidence = createEvidence(input);

    return {
        type: LOG_TYPES.PROTECTION_TRIGGER,
        category: LOG_CHANNEL_TYPES.SECURITY,
        severity: input.severity || "danger",
        guildId: input.guildId || input.guild?.id || null,
        userId: input.userId || input.member?.id || input.user?.id || null,
        actorId: input.actorId || input.executorId || null,
        channelId: input.channelId || input.channel?.id || null,
        trigger: safeAuditText(input.trigger || "Protection Trigger", 120),
        reason: safeAuditText(input.reason || "ระบบป้องกันตรวจพบพฤติกรรมเสี่ยง", 500),
        evidence,
        actionResult,
        createdAt: input.createdAt || now,
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
    };
}

function formatActionResult(result) {
    if (!result) return "-";
    const lines = [
        `Action: \`${safeAuditText(String(result.action || "log").toUpperCase(), 80)}\``,
        `Attempted: \`${result.attempted ? "yes" : "no"}\``,
        `Success: \`${result.success ? "yes" : "no"}\``
    ];
    if (result.reason) lines.push(`Reason: ${result.reason}`);
    if (result.error) lines.push(`Error: ${result.error}`);
    if (result.dmSent) lines.push("DM Sent: `yes`");
    if (result.rolesRemoved) lines.push(`Roles Removed: \`${result.rolesRemoved}\``);
    if (result.timeoutMs) lines.push(`Timeout: \`${Math.round(result.timeoutMs / 60000)}m\``);
    if (result.caseNumber) lines.push(`Case: \`#${result.caseNumber}\``);
    return lines.join("\n");
}

function buildProtectionEmbed(event = {}) {
    const evidenceLines = Array.isArray(event.evidence) && event.evidence.length
        ? event.evidence.slice(0, 12).map(item => `• ${safeAuditText(item, 220)}`).join("\n")
        : "-";

    return buildLogEmbed({
        category: LOG_CHANNEL_TYPES.SECURITY,
        severity: event.severity || "danger",
        title: `🛡️ ${safeAuditText(event.trigger || "Protection Triggered", 180)}`,
        description: safeAuditText(event.reason || "ระบบป้องกันตรวจพบเหตุการณ์", 1200),
        guildId: event.guildId,
        channelId: event.channelId,
        targetId: event.userId,
        actorId: event.actorId,
        ids: {
            userId: event.userId,
            actorId: event.actorId,
            channelId: event.channelId,
            caseNumber: event.actionResult?.caseNumber || event.caseNumber
        },
        fields: [
            field("🧩 Evidence", evidenceLines, false),
            field("⚙️ Action Result", formatActionResult(event.actionResult), false),
            field("🕒 Detected", formatDiscordTime(event.createdAt), true)
        ]
    });
}

async function createProtectionCase(sessionManager, event, options = {}) {
    const action = options.action || event.actionResult?.action;
    const shouldCreate = options.force === true || ["ban", "kick", "timeout", "quarantine", "mute", "warn"].includes(String(action || "").toLowerCase());
    if (!shouldCreate || !sessionManager || !event.guildId || !event.userId) return null;

    const caseDoc = await modCaseManager.createCase(sessionManager, {
        guildId: event.guildId,
        action,
        type: action,
        userId: event.userId,
        moderatorId: event.actorId || options.moderatorId || null,
        reason: event.reason,
        evidence: event.evidence,
        source: options.source || "protection",
        durationMs: event.actionResult?.timeoutMs || null,
        metadata: {
            trigger: event.trigger,
            protection: true,
            actionResult: event.actionResult
        }
    });

    event.actionResult = {
        ...event.actionResult,
        caseNumber: caseDoc.caseNumber
    };
    event.caseNumber = caseDoc.caseNumber;
    return caseDoc;
}

async function sendProtectionAudit({ guild, sessionManager, event, createCase = false, debounceKey = null, debounceMs = 0 }) {
    if (!event) return false;
    if (createCase) await createProtectionCase(sessionManager, event).catch(() => null);
    const embed = buildProtectionEmbed(event);
    return routeAndSendLog({
        guild,
        sessionManager,
        category: LOG_CHANNEL_TYPES.SECURITY,
        embed,
        debounceKey,
        debounceMs
    });
}

module.exports = {
    createEvidence,
    createActionResult,
    buildProtectionEvent,
    buildProtectionEmbed,
    createProtectionCase,
    sendProtectionAudit,
    formatActionResult,
    _test: {
        normalizeEvidenceItem
    }
};
