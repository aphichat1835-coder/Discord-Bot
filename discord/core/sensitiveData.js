"use strict";

const { sanitizeLogText } = require("./safeLogger");

const SENSITIVE_KEY = /(token|secret|password|pin|authorization|cookie|webhook|mongo|encryption|raw.?ip|credential|private.?key)/i;

function sanitizeSensitiveValue(value, options = {}, depth = 0) {
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 5;
    const maxKeys = Number.isInteger(options.maxKeys) ? options.maxKeys : 100;
    const maxArray = Number.isInteger(options.maxArray) ? options.maxArray : 50;
    const maxString = Number.isInteger(options.maxString) ? options.maxString : 1000;

    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string") return sanitizeLogText(value).slice(0, maxString);
    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (Array.isArray(value)) {
        return value.slice(0, maxArray).map(item => sanitizeSensitiveValue(item, options, depth + 1));
    }
    if (typeof value !== "object") return sanitizeLogText(String(value)).slice(0, maxString);

    const output = {};
    for (const [key, nested] of Object.entries(value).slice(0, maxKeys)) {
        const safeKey = sanitizeLogText(key).slice(0, 120);
        output[safeKey] = SENSITIVE_KEY.test(key)
            ? "[REDACTED]"
            : sanitizeSensitiveValue(nested, options, depth + 1);
    }
    return output;
}

module.exports = {
    SENSITIVE_KEY,
    sanitizeSensitiveValue
};
