"use strict";

const { evaluateQuota } = require("./quota");
const { getCurrentDbPath, resolveDbPath } = require("../connection");

let cachedEvaluation = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 2000; // re-evaluate at most every 2 seconds

function getWriteQuotaStatus(dbPath = null) {
    const now = Date.now();
    if (cachedEvaluation && (now - lastCheckTime) < CACHE_TTL_MS) {
        return cachedEvaluation;
    }
    const targetPath = dbPath || getCurrentDbPath() || resolveDbPath();
    cachedEvaluation = evaluateQuota(targetPath);
    lastCheckTime = now;
    return cachedEvaluation;
}

function resetWritePolicyCache() {
    cachedEvaluation = null;
    lastCheckTime = 0;
}

/**
 * Evaluates whether a write operation is permitted under current storage quota.
 * Policy rules:
 * - "core": Quests, scheduled runners, DMs, verification recovery are NEVER blocked.
 * - "cache": Blocked when quota is CRITICAL or HARD.
 * - "history": Blocked when quota is HARD.
 * - "telemetry": Blocked when quota is HARD. P2 telemetry degraded/dropped when SOFT or above.
 * 
 * @param {"core"|"cache"|"history"|"telemetry"} category
 * @param {Object} [options]
 * @returns {boolean}
 */
function canWrite(category = "core", options = {}) {
    const quota = options.quota || getWriteQuotaStatus(options.dbPath);

    switch (category) {
        case "core":
            return true;
        case "cache":
            return !quota.isCacheBlocked;
        case "history":
            return !quota.isHistoryBlocked;
        case "telemetry":
            if (options.priority === "P2" && (quota.status === "soft" || quota.status === "critical" || quota.status === "hard")) {
                return false;
            }
            return !quota.isWriteBlocked;
        default:
            return !quota.isWriteBlocked;
    }
}

module.exports = {
    canWrite,
    getWriteQuotaStatus,
    resetWritePolicyCache
};
