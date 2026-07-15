"use strict";

const { sanitizeLogText } = require("./safeLogger");

const LEVEL_LABELS = Object.freeze({
    start: "🚀 START",
    success: "✅ OK",
    info: "ℹ️ INFO",
    warn: "⚠️ WARN",
    error: "❌ FAIL",
    skip: "⏭️ SKIP"
});

const RUNTIME_LEVELS = Object.freeze({
    error: "error",
    warn: "warn",
    info: "info",
    log: "info",
    debug: "info"
});

const FORMATTED_LINE_PATTERN = /^\[(?:BOOT|BOT)\] \[(?:🚀 START|✅ OK|ℹ️ INFO|⚠️ WARN|❌ FAIL|⏭️ SKIP)\] \[[^\]]+\] /;
const LEADING_SCOPE_PATTERN = /^\[([a-zA-Z0-9_.:/-]{1,40})\]\s*/;
const GENERIC_LEVEL_SCOPES = new Set(["START", "OK", "INFO", "WARN", "FAIL", "SKIP", "ERROR", "DEBUG"]);
const LEGACY_STATUS_PATTERN = /^(✅|🟢|❌|🔴|⚠️?|ℹ️?)\s*/u;
const LEGACY_STATUS_LEVEL = Object.freeze({
    "✅": "success",
    "🟢": "success",
    "❌": "error",
    "🔴": "error",
    "⚠": "warn",
    "⚠️": "warn",
    "ℹ": "info",
    "ℹ️": "info"
});

function safeLabel(value, fallback = "GENERAL", maxLength = 40) {
    const normalized = sanitizeLogText(String(value || fallback))
        .replace(/[^a-zA-Z0-9_.:/-]+/g, "_")
        .slice(0, maxLength);
    return normalized || fallback;
}

function safeMessage(value, maxLength = 500) {
    return sanitizeLogText(String(value || "-")).replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function detailValue(value) {
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    if (typeof value === "string") return safeMessage(value, 160);
    if (value === null) return "null";
    try {
        return safeMessage(JSON.stringify(value), 240);
    } catch {
        return "[unserializable]";
    }
}

function formatDetails(details = {}) {
    if (!details || typeof details !== "object" || Array.isArray(details)) return "";
    const fields = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, value]) => `${safeLabel(key, "field", 50)}=${detailValue(value)}`);
    return fields.length ? ` | ${sanitizeLogText(fields.join(" "))}` : "";
}

function formatStartupLine({ prefix = "BOOT", level = "info", scope = "GENERAL", message = "-", details = {} } = {}) {
    const levelLabel = LEVEL_LABELS[level] || LEVEL_LABELS.info;
    return `[${safeLabel(prefix, "BOOT", 20)}] [${levelLabel}] [${safeLabel(scope)}] ${safeMessage(message)}${formatDetails(details)}`;
}

function normalizeRuntimeLine(type, value) {
    const message = safeMessage(value);
    if (FORMATTED_LINE_PATTERN.test(message)) return message;

    const match = message.match(LEADING_SCOPE_PATTERN);
    const candidateScope = match?.[1]?.toUpperCase();
    const hasSpecificScope = Boolean(candidateScope && !GENERIC_LEVEL_SCOPES.has(candidateScope));
    const scope = hasSpecificScope ? candidateScope : "GENERAL";
    const rawBody = match ? message.slice(match[0].length).trim() : message;
    const statusMatch = rawBody.match(LEGACY_STATUS_PATTERN);
    const body = statusMatch ? rawBody.slice(statusMatch[0].length).trim() : rawBody;
    const level = statusMatch?.[1]
        ? LEGACY_STATUS_LEVEL[statusMatch[1]] || RUNTIME_LEVELS[type] || "info"
        : RUNTIME_LEVELS[type] || "info";

    return formatStartupLine({
        prefix: "BOT",
        level,
        scope,
        message: body || "-"
    });
}

function errorDetails(error, durationMs) {
    return {
        code: safeLabel(error?.code || error?.name || "operation_failed", "operation_failed", 80),
        durationMs: Math.max(0, Number(durationMs) || 0)
    };
}

function resolveBootPort(value, fallback = 3000) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
    return parsed;
}

function createStartupLogger({ consoleLike = console, now = Date.now, prefix = "BOOT" } = {}) {
    function write(level, scope, message, details) {
        const line = formatStartupLine({ prefix, level, scope, message, details });
        if (level === "error") consoleLike.error(line);
        else if (level === "warn") consoleLike.warn(line);
        else consoleLike.log(line);
        return line;
    }

    async function runStage(scope, message, operation, options = {}) {
        const startedAt = now();
        write("start", scope, message, options.startDetails);
        try {
            const value = await operation();
            const durationMs = Math.max(0, now() - startedAt);
            const resolvedDetails = typeof options.details === "function"
                ? options.details(value)
                : options.details;
            write("success", scope, options.successMessage || `${message} completed`, {
                durationMs,
                ...resolvedDetails
            });
            return { ok: true, value, durationMs };
        } catch (error) {
            const durationMs = Math.max(0, now() - startedAt);
            const level = options.required === false ? "warn" : "error";
            write(level, scope, options.failureMessage || `${message} failed`, errorDetails(error, durationMs));
            if (options.required === false) return { ok: false, error, durationMs };
            throw error;
        }
    }

    return {
        start: (scope, message, details) => write("start", scope, message, details),
        success: (scope, message, details) => write("success", scope, message, details),
        info: (scope, message, details) => write("info", scope, message, details),
        warn: (scope, message, details) => write("warn", scope, message, details),
        error: (scope, message, details) => write("error", scope, message, details),
        skip: (scope, message, details) => write("skip", scope, message, details),
        runStage
    };
}

module.exports = {
    LEVEL_LABELS,
    safeLabel,
    safeMessage,
    detailValue,
    formatDetails,
    formatStartupLine,
    normalizeRuntimeLine,
    errorDetails,
    resolveBootPort,
    createStartupLogger
};
