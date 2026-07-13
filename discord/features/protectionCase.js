const { sanitizeLogText } = require("../core/safeLogger");
const modCaseManager = require("../logging/modCaseManager");

function safeText(value, max = 500) {
    const limit = Math.max(1, Number(max) || 500);
    return sanitizeLogText(String(value ?? "")).slice(0, limit) || "-";
}

function normalizeEvidenceItem(item) {
    if (item === undefined || item === null) return null;
    if (["string", "number", "boolean"].includes(typeof item)) return safeText(item, 300);
    try {
        return safeText(JSON.stringify(item), 300);
    } catch {
        return safeText(String(item), 300);
    }
}

function createEvidence(input = {}) {
    const evidence = [];
    for (const item of Array.isArray(input.evidence) ? input.evidence : []) {
        const normalized = normalizeEvidenceItem(item);
        if (normalized) evidence.push(normalized);
    }
    if (input.messageCount != null) evidence.push(`Messages: ${input.messageCount}`);
    if (input.channelCount != null) evidence.push(`Channels involved: ${input.channelCount}`);
    if (input.linkCount != null) evidence.push(`Links: ${input.linkCount}`);
    if (input.suspiciousLinkCount != null) evidence.push(`Suspicious links: ${input.suspiciousLinkCount}`);
    if (input.everyoneMentions != null) evidence.push(`@everyone/@here mentions: ${input.everyoneMentions}`);
    return evidence.slice(0, 25);
}

function createActionResult(input = {}) {
    return {
        action: safeText(input.action || "log", 80),
        attempted: input.attempted !== false,
        success: input.success === true,
        reason: input.reason ? safeText(input.reason, 300) : null,
        error: input.error ? safeText(input.error, 300) : null,
        dmSent: input.dmSent === true,
        rolesRemoved: Number(input.rolesRemoved || 0),
        timeoutMs: input.timeoutMs ? Number(input.timeoutMs) : null,
        caseNumber: input.caseNumber || null
    };
}

function buildProtectionEvent(input = {}) {
    return {
        guildId: input.guildId || input.guild?.id || null,
        userId: input.userId || input.member?.id || input.user?.id || null,
        actorId: input.actorId || input.executorId || null,
        channelId: input.channelId || input.channel?.id || null,
        trigger: safeText(input.trigger || "Protection Trigger", 120),
        reason: safeText(input.reason || "Protection policy triggered", 500),
        evidence: createEvidence(input),
        actionResult: createActionResult(input.actionResult || input),
        createdAt: input.createdAt || Date.now(),
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
    };
}

async function createProtectionCase(sessionManager, event, options = {}) {
    const action = options.action || event.actionResult?.action;
    const createsCase = options.force === true || ["ban", "kick", "timeout", "quarantine", "mute", "warn"]
        .includes(String(action || "").toLowerCase());
    const succeeded = event.actionResult?.attempted === true && event.actionResult?.success === true;
    if (!createsCase || !succeeded || !sessionManager || !event.guildId || !event.userId) return null;

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
    event.actionResult = { ...event.actionResult, caseNumber: caseDoc.caseNumber };
    event.caseNumber = caseDoc.caseNumber;
    return caseDoc;
}

async function recordProtectionResult({ sessionManager, event, createCase = false }) {
    if (!event) return null;
    if (createCase) await createProtectionCase(sessionManager, event).catch(() => null);
    return event;
}

module.exports = {
    createEvidence,
    createActionResult,
    buildProtectionEvent,
    createProtectionCase,
    recordProtectionResult,
    _test: { normalizeEvidenceItem, safeText }
};
