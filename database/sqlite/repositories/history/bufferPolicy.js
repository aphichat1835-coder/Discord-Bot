"use strict";

const { notifyBufferDropped } = require("./telemetryAlert");

/**
 * Resolves priority for an incoming history/telemetry event.
 *
 * P0: Critical Security, Database Corruption, Backup Failure, or explicit critical flag.
 *     (Best-effort durable; written directly to SQLite, queued for retry on transient error, never intentionally evicted while SQLite is healthy)
 * P1: Session Lifecycle, Quarantine, 429, Rate Limit, Errors.
 *     (Preserved over P2; only dropped if queue remains saturated after P2 eviction)
 * P2: Verbose Telemetry, Voice Lean, Pings, General Command execution.
 *     (Evicted first during memory pressure)
 *
 * @param {object} event
 * @param {boolean} isCritical
 * @returns {"P0"|"P1"|"P2"}
 */
function resolvePriority(event, isCritical = false) {
    if (isCritical || event?.critical === true) return "P0";
    if (event?.priority === "P0" || event?.priority === "CRITICAL") return "P0";
    if (event?.priority === "P1" || event?.priority === "HIGH") return "P1";
    if (event?.priority === "P2" || event?.priority === "LOW") return "P2";

    const type = String(event?.eventType || event?.commandName || "").toLowerCase();
    const detail = String(event?.detail || event?.status || "").toLowerCase();

    // P0: Critical Security / Corruption / Backup Failure
    if (
        type.includes("security") ||
        type.includes("corruption") ||
        type.includes("backup_fail") ||
        detail.includes("corruption") ||
        detail.includes("security_alert")
    ) {
        return "P0";
    }

    // P1: Session Lifecycle / Quarantine / 429 / Rate Limit / Errors
    if (
        type.includes("session_") ||
        type.includes("quarantine") ||
        type.includes("rate_limit") ||
        type.includes("429") ||
        detail.includes("429") ||
        detail.includes("quarantine") ||
        event?.status === "failed" ||
        event?.status === "error"
    ) {
        return "P1";
    }

    // Default to P2 (Verbose telemetry, noise, metrics)
    return "P2";
}

function dropPriorityLevel(buffer, priority, limit) {
    let count = 0;
    for (let i = 0; i < buffer.length && count < limit; ) {
        const prio = buffer[i]?.priority || "P2";
        if (prio === priority) {
            buffer.splice(i, 1);
            count++;
        } else {
            i++;
        }
    }
    return count;
}

/**
 * Priority-aware eviction for in-memory buffer.
 * Drops P2 items first, then P1 if necessary.
 * P0 items are NEVER evicted.
 *
 * @param {Array} buffer - The repository buffer array
 * @param {number} dropTarget - Number of items to evict (default 500)
 * @returns {number} actual number of dropped items
 */
function evictWithPriority(buffer, dropTarget = 500, outStats = null) {
    if (!Array.isArray(buffer) || buffer.length === 0 || dropTarget <= 0) return 0;

    const p2Dropped = dropPriorityLevel(buffer, "P2", dropTarget);
    const remaining = dropTarget - p2Dropped;
    const p1Dropped = remaining > 0 ? dropPriorityLevel(buffer, "P1", remaining) : 0;
    const dropped = p2Dropped + p1Dropped;

    if (outStats && typeof outStats === "object") {
        outStats.p2 = p2Dropped;
        outStats.p1 = p1Dropped;
        outStats.total = dropped;
    }

    return dropped;
}

const SENSITIVE_KEY_REGEX = /(?:token|password|pin|secret|credential|auth|bearer|cookie|salt|private|api_?key|access_?key|secret_?key|^key$)/i;
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
    /(?:token|password|secret|api_?key)\s*[:=]\s*[^\s&,;]+/gi,
    /bearer\s+[\w.-]+/gi,
    /bot\s+[\w.-]+/gi,
    /mfa\.[\w-]{20,}/gi,
    /\b[A-Za-z0-9_-]{24,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,45}\b/g
]);

function sanitizeString(str) {
    if (typeof str !== "string") return str;
    let result = str;
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
        result = result.replace(pattern, "[REDACTED_CREDENTIAL]");
    }
    return result.length > 500 ? result.slice(0, 500) + "..." : result;
}

function sanitizeDetails(obj, depth = 0) {
    if (!obj || typeof obj !== "object") {
        return sanitizeString(obj);
    }
    if (depth >= 5) {
        return "[REDACTED_NESTED]";
    }
    if (Array.isArray(obj)) {
        return obj.slice(0, 50).map(item => sanitizeDetails(item, depth + 1));
    }
    const clean = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_KEY_REGEX.test(key)) {
            clean[key] = "[REDACTED]";
        } else if (value && typeof value === "object") {
            clean[key] = sanitizeDetails(value, depth + 1);
        } else if (typeof value === "string") {
            clean[key] = sanitizeString(value);
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

const { notifyP1Dropped } = require("./telemetryAlert");

module.exports = {
    resolvePriority,
    evictWithPriority,
    notifyBufferDropped,
    notifyP1Dropped,
    sanitizeDetails,
    SENSITIVE_KEY_REGEX
};
