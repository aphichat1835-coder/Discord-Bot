"use strict";

function cleanPrivateLogText(value, maxString) {
    return String(value ?? "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .slice(0, maxString);
}

function sanitizeSensitiveValue(value, options = {}, depth = 0) {
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 5;
    const maxKeys = Number.isInteger(options.maxKeys) ? options.maxKeys : 100;
    const maxArray = Number.isInteger(options.maxArray) ? options.maxArray : 50;
    const maxString = Number.isInteger(options.maxString) ? options.maxString : 1000;

    if (value === null || value === undefined) return value;
    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (Array.isArray(value)) {
        return value.slice(0, maxArray).map(item => sanitizeSensitiveValue(item, options, depth + 1));
    }
    if (typeof value !== "object") return cleanPrivateLogText(value, maxString);

    const output = Object.create(null);
    for (const [key, nested] of Object.entries(value).slice(0, maxKeys)) {
        const safeKey = cleanPrivateLogText(key, 120);
        output[safeKey] = sanitizeSensitiveValue(nested, options, depth + 1);
    }
    return output;
}

module.exports = {
    sanitizeSensitiveValue,
    cleanPrivateLogText
};
