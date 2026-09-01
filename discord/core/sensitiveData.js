"use strict";

function cleanPrivateLogText(value) {
    return String(value ?? "");
}

function sanitizeSensitiveValue(value, seen = new WeakMap()) {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (seen.has(value)) throw new TypeError("PRIVATE_LOG_CIRCULAR_VALUE");
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) {
        const output = [];
        seen.set(value, output);
        for (const item of value) output.push(sanitizeSensitiveValue(item, seen));
        return output;
    }

    const output = Object.create(null);
    seen.set(value, output);
    for (const [key, nested] of Object.entries(value)) {
        output[key] = sanitizeSensitiveValue(nested, seen);
    }
    return output;
}

module.exports = {
    sanitizeSensitiveValue,
    cleanPrivateLogText
};
