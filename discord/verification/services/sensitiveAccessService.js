"use strict";

const crypto = require("node:crypto");
const sessionManager = require("../../sessionManager");
const auditStorage = require("../../logging/auditStorage");
const { isDiscordSnowflake } = require("../../core/snowflakes");

function cleanReason(value) {
    return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
}

function defaultAccessReason(valueType) {
    return `owner_dashboard_reveal:${String(valueType || "unknown").slice(0, 80)}`;
}

function accessError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

async function saveAccessAudit({ actorId, guildId, userId, valueType, reason, requestId, phase, result, resultCode }) {
    return auditStorage.saveAuditRecord(sessionManager, {
        guildId,
        source: "verification_dashboard",
        category: "SECURITY",
        severity: result === "failed" ? "ERROR" : "WARNING",
        actionType: "sensitive_value_access",
        actorId,
        targetId: userId,
        reason,
        summary: `${phase}:${result}`,
        metadata: {
            requestId,
            valueType,
            phase,
            result,
            resultCode: resultCode || null
        }
    });
}

async function revealSensitiveValue({ actorId, guildId, userId, valueType, reason, loader, requestId = crypto.randomUUID() }) {
    const safeActorId = String(actorId || "").trim();
    const safeGuildId = String(guildId || "").trim();
    const safeUserId = String(userId || "").trim();
    const safeReason = cleanReason(reason) || defaultAccessReason(valueType);
    if (!isDiscordSnowflake(safeActorId) || !isDiscordSnowflake(safeGuildId) || !isDiscordSnowflake(safeUserId)) {
        throw accessError("invalid_sensitive_access_scope", "Sensitive access scope is invalid");
    }
    if (typeof loader !== "function") throw accessError("sensitive_loader_missing");

    const intent = await saveAccessAudit({
        actorId: safeActorId,
        guildId: safeGuildId,
        userId: safeUserId,
        valueType,
        reason: safeReason,
        requestId,
        phase: "intent",
        result: "pending"
    });
    if (!intent) throw accessError("audit_unavailable", "Sensitive access audit is unavailable");

    let value;
    try {
        value = await loader();
    } catch (error) {
        await saveAccessAudit({
            actorId: safeActorId,
            guildId: safeGuildId,
            userId: safeUserId,
            valueType,
            reason: safeReason,
            requestId,
            phase: "result",
            result: "failed",
            resultCode: error?.code || error?.name || "sensitive_loader_failed"
        });
        throw error;
    }

    const completed = await saveAccessAudit({
        actorId: safeActorId,
        guildId: safeGuildId,
        userId: safeUserId,
        valueType,
        reason: safeReason,
        requestId,
        phase: "result",
        result: "succeeded"
    });
    if (!completed) throw accessError("audit_result_unavailable", "Sensitive access result could not be audited");

    return {
        ...value,
        audit: {
            requestId,
            eventId: completed.eventId,
            status: "recorded"
        }
    };
}

module.exports = {
    revealSensitiveValue,
    cleanReason,
    defaultAccessReason,
    saveAccessAudit
};
