"use strict";

const { evaluateQuota } = require("./quota");
const { evaluateStoragePaths } = require("./storageCheck");

let lastHealthCheck = null;
let errorCounter = 0;

function incrementErrorCounter() {
    errorCounter++;
}

function getHealthStatus(db, dbPath) {
    if (!db || !db.open) {
        return {
            status: "failed",
            isReady: false,
            reason: "connection_closed",
            errorCount: errorCounter,
            timestamp: Date.now()
        };
    }

    try {
        const userVersion = db.pragma("user_version", { simple: true });
        const quotaInfo = dbPath ? evaluateQuota(dbPath) : null;
        const storageCheck = dbPath ? evaluateStoragePaths({ dbPath }) : null;
        const tables = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();

        const isQuotaDegraded = quotaInfo && (quotaInfo.status === "critical" || quotaInfo.status === "hard");
        const isStorageDegraded = storageCheck && (storageCheck.filesystemCritical || storageCheck.errors.length > 0);
        const isDegraded = Boolean(isQuotaDegraded || isStorageDegraded);

        const reasons = [];
        if (isQuotaDegraded) reasons.push(quotaInfo.degradedReason || "quota_threshold_exceeded");
        if (isStorageDegraded) reasons.push(storageCheck.errors[0] || "filesystem_critical");

        const health = {
            status: isDegraded ? "degraded" : "ready",
            isReady: !isStorageDegraded && db.open,
            reason: reasons.length > 0 ? reasons.join("; ") : null,
            schemaVersion: userVersion,
            tablesCount: tables ? tables.count : 0,
            quota: quotaInfo,
            storage: storageCheck,
            errorCount: errorCounter,
            timestamp: Date.now()
        };

        lastHealthCheck = health;
        return health;
    } catch (err) {
        incrementErrorCounter();
        return {
            status: "failed",
            isReady: false,
            error: err.message,
            errorCount: errorCounter,
            timestamp: Date.now()
        };
    }
}

module.exports = {
    getHealthStatus,
    incrementErrorCounter
};
