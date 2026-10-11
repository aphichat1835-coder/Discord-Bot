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

    let dropped = 0;
    let p2Dropped = 0;
    let p1Dropped = 0;

    // Pass 1: Drop P2 items starting from the oldest (unspecified priority defaults to P2)
    for (let i = 0; i < buffer.length && dropped < dropTarget; ) {
        const prio = buffer[i]?.priority || "P2";
        if (prio === "P2") {
            buffer.splice(i, 1);
            dropped++;
            p2Dropped++;
        } else {
            i++;
        }
    }

    // Pass 2: If we still need to drop more and buffer is still at capacity, drop P1 items starting from oldest
    if (dropped < dropTarget) {
        for (let i = 0; i < buffer.length && dropped < dropTarget; ) {
            if (buffer[i]?.priority === "P1") {
                buffer.splice(i, 1);
                dropped++;
                p1Dropped++;
            } else {
                i++;
            }
        }
    }

    if (outStats && typeof outStats === "object") {
        outStats.p2 = p2Dropped;
        outStats.p1 = p1Dropped;
        outStats.total = dropped;
    }

    return dropped;
}

const SENSITIVE_KEY_REGEX = /(token|password|pin|secret|credential|auth|bearer|cookie|salt|private|api_?key|access_?key|secret_?key|^key$)/i;
const SENSITIVE_VALUE_REGEX = /(token\s*[:=]\s*[^\s&,;]+|bearer\s+[a-zA-Z0-9_\-\.]+|bot\s+[a-zA-Z0-9_\-\.]+|mfa\.[a-zA-Z0-9_\-]{20,}|[a-zA-Z0-9_\-]{24,}\.[a-zA-Z0-9_\-]{6}\.[a-zA-Z0-9_\-]{20,}|password\s*[:=]\s*[^\s&,;]+|api_?key\s*[:=]\s*[^\s&,;]+|secret\s*[:=]\s*[^\s&,;]+)/gi;

function sanitizeString(str) {
    if (typeof str !== "string") return str;
    const result = str.replace(SENSITIVE_VALUE_REGEX, "[REDACTED_CREDENTIAL]");
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
