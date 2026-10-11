"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SOFT_LIMIT_MB = 3072;
const DEFAULT_CRIT_LIMIT_MB = 3686;
const DEFAULT_HARD_LIMIT_MB = 4096;

function resolveLimits() {
    return {
        softMb: parseInt(process.env.SQLITE_QUOTA_SOFT_MB || process.env.SQLITE_SOFT_LIMIT_MB, 10) || DEFAULT_SOFT_LIMIT_MB,
        critMb: parseInt(process.env.SQLITE_QUOTA_CRIT_MB || process.env.SQLITE_CRITICAL_LIMIT_MB, 10) || DEFAULT_CRIT_LIMIT_MB,
        hardMb: parseInt(process.env.SQLITE_QUOTA_HARD_MB || process.env.SQLITE_HARD_LIMIT_MB, 10) || DEFAULT_HARD_LIMIT_MB
    };
}

function getDatabaseFootprint(dbPath) {
    if (!dbPath || !fs.existsSync(dbPath)) {
        return {
            mainBytes: 0,
            walBytes: 0,
            shmBytes: 0,
            totalBytes: 0,
            totalMb: 0
        };
    }

    const mainStat = fs.statSync(dbPath);
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    let walBytes = 0;
    let shmBytes = 0;

    if (fs.existsSync(walPath)) {
        walBytes = fs.statSync(walPath).size;
    }
    if (fs.existsSync(shmPath)) {
        shmBytes = fs.statSync(shmPath).size;
    }

    const totalBytes = mainStat.size + walBytes + shmBytes;
    const totalMb = parseFloat((totalBytes / (1024 * 1024)).toFixed(2));

    return {
        mainBytes: mainStat.size,
        walBytes,
        shmBytes,
        totalBytes,
        totalMb
    };
}

function getFilesystemFreeSpace(targetDir) {
    try {
        if (typeof fs.statfsSync === "function") {
            const stats = fs.statfsSync(targetDir);
            const freeBytes = stats.bavail * stats.bsize;
            const totalBytes = stats.blocks * stats.bsize;
            const percentFree = totalBytes > 0 ? parseFloat(((freeBytes / totalBytes) * 100).toFixed(1)) : null;
            return {
                availableBytes: freeBytes,
                availableMb: parseFloat((freeBytes / (1024 * 1024)).toFixed(2)),
                totalBytes,
                totalMb: parseFloat((totalBytes / (1024 * 1024)).toFixed(2)),
                percentFree
            };
        }
    } catch (_) {}
    return { availableBytes: null, availableMb: null, totalBytes: null, totalMb: null, percentFree: null };
}

function evaluateQuota(dbPath) {
    const limits = resolveLimits();
    const footprint = getDatabaseFootprint(dbPath);
    const parentDir = dbPath ? path.dirname(dbPath) : process.cwd();
    const fsFree = getFilesystemFreeSpace(parentDir);

    let status = "ok"; // 'ok' | 'soft' | 'critical' | 'hard'
    let degradedReason = "ระบบฐานข้อมูลทำงานปกติ";

    if (footprint.totalMb >= limits.hardMb) {
        status = "hard";
        degradedReason = `พื้นที่ฐานข้อมูลแตะเพดาน Hard Limit (${footprint.totalMb} MB / ${limits.hardMb} MB) — ระงับการเขียน Cache/History เพื่อปกป้องดิสก์`;
    } else if (footprint.totalMb >= limits.critMb) {
        status = "critical";
        degradedReason = `พื้นที่ฐานข้อมูลแตะเพดาน Critical Limit (${footprint.totalMb} MB / ${limits.critMb} MB) — ระงับการเขียนแคชใหม่`;
    } else if (footprint.totalMb >= limits.softMb) {
        status = "soft";
        degradedReason = `พื้นที่ฐานข้อมูลแตะระดับ Soft Limit (${footprint.totalMb} MB / ${limits.softMb} MB) — แนะนำให้ทำความสะอาดข้อมูล`;
    }

    return {
        status,
        degradedReason,
        limits,
        footprint,
        filesystem: fsFree,
        isCoreBlocked: false, // Core data is NEVER blocked
        isHistoryBlocked: status === "hard",
        isCacheBlocked: status === "critical" || status === "hard",
        isWriteBlocked: status === "hard" // Non-essential writes blocked
    };
}

const EMERGENCY_ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes throttle
const alertThrottleMap = new Map(); // eventKey -> timestamp

function canSendAlert(eventKey, cooldownMs = EMERGENCY_ALERT_COOLDOWN_MS, now = Date.now()) {
    const lastSent = alertThrottleMap.get(eventKey);
    if (!lastSent) return true;
    return (now - lastSent) >= cooldownMs;
}

function recordAlertSent(eventKey, now = Date.now()) {
    alertThrottleMap.set(eventKey, now);
}

function resetAlertThrottle() {
    alertThrottleMap.clear();
}

function evaluateEmergencyThresholds(dbPath, metrics = {}) {
    const quota = evaluateQuota(dbPath);
    const reasons = [];
    let isEmergency = false;

    // 1. Storage Footprint Threshold
    if (quota.status === "critical" || quota.status === "hard") {
        isEmergency = true;
        reasons.push(`Storage footprint reached ${quota.status.toUpperCase()} limit (${quota.footprint.totalMb} MB / ${quota.limits.critMb} MB)`);
    }

    // 2. WAL File Swelling (> 500MB)
    const walMb = parseFloat((quota.footprint.walBytes / (1024 * 1024)).toFixed(2));
    if (walMb >= 500) {
        isEmergency = true;
        reasons.push(`SQLite WAL file abnormally swollen (${walMb} MB >= 500 MB threshold)`);
    }

    // 3. Filesystem Free Space (< 100MB)
    if (quota.filesystem.availableMb !== null && quota.filesystem.availableMb < 100) {
        isEmergency = true;
        reasons.push(`Persistent disk storage critically low (${quota.filesystem.availableMb} MB free < 100 MB required)`);
    }

    const isStorageEmergency = isEmergency;

    // 4. Telemetry Write-Behind Buffer Pressure (>= 2000 items in RAM)
    // Note: Policy B — Handled via in-memory Priority Drop, active queue drain flush, and webhook alerting.
    // Strictly does NOT trigger disk Emergency Trim, as RAM queue pressure is distinct from physical disk exhaustion.
    const bufferCount = Number(metrics.writeBufferCount || 0);
    const isBufferEmergency = bufferCount >= 2000;
    if (isBufferEmergency) {
        reasons.push(`Telemetry write-behind buffer queue overflow (${bufferCount} items >= 2000 capacity)`);
    }

    return {
        isEmergency: isStorageEmergency || isBufferEmergency,
        isStorageEmergency,
        isBufferEmergency,
        reasons,
        severity: (isStorageEmergency || isBufferEmergency) ? (quota.status === "hard" ? "CRITICAL" : "ERROR") : "OK",
        quota,
        walMb,
        bufferCount,
        bufferThreshold: 2000
    };
}

module.exports = {
    getDatabaseFootprint,
    evaluateQuota,
    resolveLimits,
    getFilesystemFreeSpace,
    evaluateEmergencyThresholds,
    canSendAlert,
    recordAlertSent,
    resetAlertThrottle,
    EMERGENCY_ALERT_COOLDOWN_MS
};
