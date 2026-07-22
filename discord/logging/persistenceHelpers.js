"use strict";

const { sanitizeLogText } = require("../core/safeLogger");

const fallbackLocks = new Map();

function safeText(value, max = 500) {
    return sanitizeLogText(String(value ?? ""))
        .slice(0, Math.max(1, Number(max) || 500)) || "-";
}

async function withFallbackLock(key, operation) {
    const lockKey = String(key || "global");
    const previous = fallbackLocks.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const lock = previous.catch(() => {}).then(() => current);
    fallbackLocks.set(lockKey, lock);
    try {
        await previous.catch(() => {});
        return await operation();
    } finally {
        release();
        if (fallbackLocks.get(lockKey) === lock) fallbackLocks.delete(lockKey);
    }
}

module.exports = { safeText, withFallbackLock };
