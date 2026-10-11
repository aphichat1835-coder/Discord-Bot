"use strict";

const databaseService = require("../../services/databaseService");

function executeSqliteAction(action, options = {}, invoker = "system_scheduler") {
    if (databaseService && typeof databaseService.executeSqliteAction === "function") {
        return databaseService.executeSqliteAction(action, options, invoker);
    }
    throw new Error("databaseService.executeSqliteAction is not available");
}
const { getAssetCacheManager } = require("../cache/assetCacheManager");
const { getCurrentDbPath, resolveDbPath } = require("../connection");
const { evaluateEmergencyThresholds, canSendAlert, recordAlertSent } = require("./quota");
const { listBackups } = require("./backup");
const { sendWebhookEvent } = require("../../../discord/core/webhooks");

let walIntervalId = null;
let cleanupIntervalId = null;
let vacuumIntervalId = null;
let backupIntervalId = null;
let emergencyIntervalId = null;
let initialBackupTimeoutId = null;

let isWalRunning = false;
let isCleanupRunning = false;
let isVacuumRunning = false;
let isBackupRunning = false;
let isEmergencyRunning = false;
let lastQuickIntegrityCheckAt = 0;
const QUICK_INTEGRITY_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

let schedulerStartedAt = null;
let nextScheduledBackupAt = null;
let configuredIntervalsMs = {
    wal: 60 * 60 * 1000,
    cleanup: 360 * 60 * 1000,
    vacuum: 1440 * 60 * 1000,
    backup: 24 * 60 * 60 * 1000,
    emergency: 2 * 60 * 1000
};

const diagnostics = {
    wal: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", lastError: null, runCount: 0 },
    cleanup: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", lastError: null, runCount: 0 },
    vacuum: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", lastError: null, runCount: 0 },
    backup: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", lastError: null, runCount: 0 },
    emergency: { lastRunAt: null, lastStatus: "idle", incidentCount: 0 }
};

function parseMinutes(envVar, defaultMinutes) {
    const val = parseInt(process.env[envVar], 10);
    return !isNaN(val) && val > 0 ? val : defaultMinutes;
}

function parseHours(envVar, defaultHours) {
    const val = parseInt(process.env[envVar], 10);
    return !isNaN(val) && val > 0 ? val : defaultHours;
}

async function runWalCheckpoint() {
    if (isWalRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ WAL Checkpoint skipped: previous checkpoint still running.");
        return;
    }
    isWalRunning = true;
    const start = Date.now();
    diagnostics.wal.lastRunAt = start;
    diagnostics.wal.lastStatus = "running";

    try {
        const res = await executeSqliteAction("checkpoint", {}, "system_scheduler");
        if (res && res.ok) {
            diagnostics.wal.lastStatus = "success";
            diagnostics.wal.lastError = null;
            diagnostics.wal.runCount++;
        } else {
            diagnostics.wal.lastStatus = "error";
            const errDetail = res?.message || res?.error || "Unknown checkpoint error";
            diagnostics.wal.lastError = errDetail;
            console.error(`[DB_SCHEDULER] ❌ WAL Checkpoint failed: ${errDetail}`);
        }
    } catch (err) {
        diagnostics.wal.lastStatus = "error";
        diagnostics.wal.lastError = err.message;
        console.error(`[DB_SCHEDULER] ❌ WAL Checkpoint failed: ${err.message}`);
    } finally {
        diagnostics.wal.lastDurationMs = Date.now() - start;
        isWalRunning = false;
    }
}

async function runCleanup() {
    if (isCleanupRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ Cleanup skipped: previous cleanup still running.");
        return;
    }
    isCleanupRunning = true;
    const start = Date.now();
    diagnostics.cleanup.lastRunAt = start;
    diagnostics.cleanup.lastStatus = "running";

    try {
        // 1. Cleanup database expired records (nonces, history)
        const res = await executeSqliteAction("cleanup_all", {}, "system_scheduler");
        if (!res || !res.ok) {
            diagnostics.cleanup.lastStatus = "error";
            const errDetail = res?.message || res?.error || "Unknown cleanup error";
            diagnostics.cleanup.lastError = errDetail;
            console.error(`[DB_SCHEDULER] ❌ Maintenance cleanup failed: ${errDetail}`);
            return;
        }

        // 2. Reconcile asset cache & enforce 500MB quota
        try {
            const assetMgr = getAssetCacheManager();
            assetMgr.evictIfOverQuota();
            assetMgr.reconcileOrphans();
        } catch (assetErr) {
            console.warn(`[DB_SCHEDULER] ⚠️ Asset cache reconciliation warning: ${assetErr.message}`);
        }

        diagnostics.cleanup.lastStatus = "success";
        diagnostics.cleanup.lastError = null;
        diagnostics.cleanup.runCount++;
    } catch (err) {
        diagnostics.cleanup.lastStatus = "error";
        diagnostics.cleanup.lastError = err.message;
        console.error(`[DB_SCHEDULER] ❌ Maintenance cleanup failed: ${err.message}`);
    } finally {
        diagnostics.cleanup.lastDurationMs = Date.now() - start;
        isCleanupRunning = false;
    }
}

async function runVacuum() {
    if (isVacuumRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ Incremental Vacuum skipped: previous vacuum still running.");
        return;
    }
    isVacuumRunning = true;
    const start = Date.now();
    diagnostics.vacuum.lastRunAt = start;
    diagnostics.vacuum.lastStatus = "running";

    try {
        const res = await executeSqliteAction("vacuum", {}, "system_scheduler");
        if (res && res.ok) {
            diagnostics.vacuum.lastStatus = "success";
            diagnostics.vacuum.lastError = null;
            diagnostics.vacuum.runCount++;
        } else {
            diagnostics.vacuum.lastStatus = "error";
            const errDetail = res?.message || res?.error || "Unknown vacuum error";
            diagnostics.vacuum.lastError = errDetail;
            console.error(`[DB_SCHEDULER] ❌ Incremental Vacuum failed: ${errDetail}`);
        }
    } catch (err) {
        diagnostics.vacuum.lastStatus = "error";
        diagnostics.vacuum.lastError = err.message;
        console.error(`[DB_SCHEDULER] ❌ Incremental Vacuum failed: ${err.message}`);
    } finally {
        diagnostics.vacuum.lastDurationMs = Date.now() - start;
        isVacuumRunning = false;
    }
}

async function runAutoBackup() {
    if (isBackupRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ Auto-backup skipped: previous backup still running.");
        return;
    }
    isBackupRunning = true;
    const start = Date.now();
    diagnostics.backup.lastRunAt = start;
    diagnostics.backup.lastStatus = "running";

    try {
        const retention = parseInt(process.env.SQLITE_BACKUP_RETENTION, 10) || 2;
        const res = await executeSqliteAction("backup", { retention }, "system_scheduler");
        if (res && res.ok) {
            diagnostics.backup.lastStatus = "success";
            diagnostics.backup.lastError = null;
            diagnostics.backup.runCount++;
            console.log(`[DB_SCHEDULER] 💾 Automated 24h backup completed successfully: ${res.backup?.filename || "ok"} (retention: ${retention})`);

            try {
                sendWebhookEvent({
                    target: "ALERT",
                    severity: "SUCCESS",
                    category: "DATA",
                    code: "sqlite.backup.success",
                    title: "💾 สำรองข้อมูล SQLite ประจำวันสำเร็จ",
                    description: "การสำรองข้อมูลอัตโนมัติประจำ 24 ชั่วโมงเสร็จสิ้นสมบูรณ์และถูกจัดเก็บไว้บน Local Persistent Storage อย่างปลอดภัย",
                    context: {
                        "ชื่อไฟล์": res.backup?.filename || "unknown",
                        "ขนาดไฟล์": `${res.backup?.sizeMb || 0} MB`,
                        "SHA-256": res.backup?.sha256 || "N/A",
                        "ระยะเวลาสำรอง": `${res.backup?.durationMs || (Date.now() - start)} ms`,
                        "นโยบาย Retention": `เก็บ ${retention} ชุดล่าสุด`,
                        "พื้นที่จัดเก็บ": "Local Persistent Storage (/persistent/backups/)"
                    }
                }).catch(() => {});
            } catch (_) {}
        } else {
            diagnostics.backup.lastStatus = "error";
            const errDetail = res?.message || res?.error || "unknown error";
            diagnostics.backup.lastError = errDetail;
            console.error(`[DB_SCHEDULER] ⚠️ Automated backup failed: ${errDetail}`);

            try {
                sendWebhookEvent({
                    target: "ALERT",
                    severity: "CRITICAL",
                    category: "DATA",
                    code: "sqlite.backup.failure",
                    title: "🚨 การสำรองข้อมูล SQLite ประจำวันล้มเหลว",
                    description: `ระบบไม่สามารถสร้าง Snapshot สำรองข้อมูล SQLite ประจำวันได้: ${errDetail}`,
                    context: {
                        "สาเหตุ": errDetail,
                        "เวลาที่เกิด": new Date().toISOString()
                    }
                }).catch(() => {});
            } catch (_) {}
        }
    } catch (err) {
        diagnostics.backup.lastStatus = "error";
        diagnostics.backup.lastError = err.message;
        console.error(`[DB_SCHEDULER] ❌ Automated backup exception: ${err.message}`);

        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "CRITICAL",
                category: "DATA",
                code: "sqlite.backup.exception",
                title: "🚨 เกิดข้อผิดพลาดร้ายแรงขณะสำรองข้อมูล SQLite",
                description: `เกิด Exception ระหว่างสร้าง Snapshot สำรองข้อมูล: ${err.message}`,
                context: {
                    "ข้อความ Exception": err.message,
                    "เวลาที่เกิด": new Date().toISOString()
                }
            }).catch(() => {});
        } catch (_) {}
    } finally {
        diagnostics.backup.lastDurationMs = Date.now() - start;
        isBackupRunning = false;
    }
}

async function runEmergencyEvaluation() {
    if (isEmergencyRunning) return;
    isEmergencyRunning = true;
    const start = Date.now();
    diagnostics.emergency.lastRunAt = start;

    try {
        const dbPath = getCurrentDbPath() || resolveDbPath();

        // Check quick integrity periodically (every 20 minutes) rather than on every 2-minute cycle
        if ((start - lastQuickIntegrityCheckAt) >= QUICK_INTEGRITY_INTERVAL_MS) {
            lastQuickIntegrityCheckAt = start;
            try {
                const { getDatabase } = require("../connection");
                const db = getDatabase();
                if (db && db.open) {
                    const quickRows = db.pragma("quick_check(1)");
                    const quickOk = quickRows.length === 1 && (quickRows[0].quick_check === "ok" || quickRows[0] === "ok");
                    if (!quickOk && canSendAlert("sqlite_integrity_corrupted")) {
                        recordAlertSent("sqlite_integrity_corrupted");
                        sendWebhookEvent({
                            target: "ALERT",
                            severity: "CRITICAL",
                            category: "DATA",
                            code: "sqlite.integrity.corrupted",
                            title: "🚨 ตรวจพบความเสียหายในไฟล์ฐานข้อมูล SQLite (Integrity Corrupted)",
                            description: "ระบบ Background Scheduler ตรวจพบความผิดปกติของโครงสร้างไฟล์ฐานข้อมูล SQLite ระหว่างการตรวจสอบประจำรอบ",
                            context: {
                                "ผลการตรวจสอบ": JSON.stringify(quickRows),
                                "ไฟล์ฐานข้อมูล": dbPath,
                                "เวลาที่เกิด": new Date().toISOString()
                            }
                        }).catch(() => {});
                    }
                }
            } catch (_) {}
        }

        // Aggregate write buffer counts from history repositories
        let totalBufferCount = 0;
        try {
            const { getVoiceEventRepository } = require("../repositories/history/VoiceEventRepository");
            const { getCommandEventRepository } = require("../repositories/history/CommandEventRepository");
            const { getSessionEventRepository } = require("../repositories/history/SessionEventRepository");
            const vBuf = getVoiceEventRepository()?.getBufferStats()?.bufferedCount || 0;
            const cBuf = getCommandEventRepository()?.getBufferStats()?.bufferedCount || 0;
            const sBuf = getSessionEventRepository()?.getBufferStats()?.bufferedCount || 0;
            totalBufferCount = vBuf + cBuf + sBuf;
        } catch (_) {}

        const evalResult = evaluateEmergencyThresholds(dbPath, { writeBufferCount: totalBufferCount });

        if (evalResult.isEmergency) {
            diagnostics.emergency.incidentCount++;

            // 1. Storage Emergency Alert & Auto-Trim Execution (Physical Disk Exhaustion)
            if (evalResult.isStorageEmergency) {
                diagnostics.emergency.lastStatus = "storage_critical";
                const eventKey = "sqlite_emergency_storage";
                const alertAllowed = canSendAlert(eventKey);

                if (alertAllowed) {
                    recordAlertSent(eventKey);
                    try {
                        const storageReasons = evalResult.reasons.filter(r => !r.includes("Write-behind"));
                        sendWebhookEvent({
                            target: "ALERT",
                            severity: "CRITICAL",
                            category: "DATA",
                            code: "sqlite.emergency.critical",
                            title: "🚨 ตรวจพบภาวะวิกฤตพื้นที่จัดเก็บ SQLite (Storage Critical)",
                            description: `ระบบตรวจพบพื้นที่จัดเก็บบนดิสก์เกินเกณฑ์วิกฤต กำลังเริ่ม Emergency Auto-Trim อัตโนมัติ เพื่อล้างข้อมูลหมดอายุและคืนพื้นที่ดิสก์:\n${storageReasons.map(r => `• ${r}`).join("\n")}`,
                            context: {
                                "ขนาด Footprint": `${evalResult.quota.footprint.totalMb} MB`,
                                "เพดานวิกฤต": `${evalResult.quota.limits.critMb} MB`,
                                "ขนาดไฟล์ WAL": `${evalResult.walMb} MB`,
                                "สถานะระบบ": evalResult.quota.status.toUpperCase()
                            }
                        }).catch(() => {});
                    } catch (_) {}
                }

                // Execute Emergency Auto-Trim strictly on physical storage emergency
                const trimResult = await executeSqliteAction("emergency_trim", {
                    reason: evalResult.reasons.join("; ")
                }, "system_auto_emergency");

                if (trimResult && trimResult.ok) {
                    const trim = trimResult.trimResult || {};
                    if (trim.isResolved) {
                        diagnostics.emergency.lastStatus = "resolved";
                        // Send RESOLVED Webhook alert (strictly when post-quota is ok)
                        try {
                            sendWebhookEvent({
                                target: "ALERT",
                                severity: "SUCCESS",
                                category: "DATA",
                                code: "sqlite.emergency.resolved",
                                title: "🟢 ระบบฐานข้อมูล SQLite คืนสู่สภาวะปกติสมบูรณ์แล้ว",
                                description: "Emergency Auto-Trim ดำเนินการสำเร็จ และระดับพื้นที่จัดเก็บกลับเข้าสู่เกณฑ์ปลอดภัยสมบูรณ์ (Safe/OK)",
                                context: {
                                    "สาเหตุที่เกิด": evalResult.reasons[0] || "Storage critical",
                                    "พื้นที่ที่คืนได้": `${trim.freedMb} MB`,
                                    "จำนวนรายการที่ลบ": `${trim.itemsPurged?.totalItems || 0} รายการ`,
                                    "ขนาดก่อน ➔ หลัง": `${trim.preFootprint?.totalMb} MB ➔ ${trim.postFootprint?.totalMb} MB`,
                                    "สถานะล่าสุด": "OK",
                                    "ระยะเวลาดำเนินการ": `${trim.durationMs} ms`
                                }
                            }).catch(() => {});
                        } catch (_) {}
                    } else if (trim.postStatus === "soft" || trim.isSoftWarning) {
                        diagnostics.emergency.lastStatus = "soft_warning";
                        // Send WARNING alert: dropped out of critical but still in soft warning state
                        try {
                            sendWebhookEvent({
                                target: "ALERT",
                                severity: "WARNING",
                                category: "DATA",
                                code: "sqlite.emergency.warning_cleared",
                                title: "🟡 ภาวะวิกฤตลดระดับสู่เกณฑ์เฝ้าระวัง (Soft Warning)",
                                description: "Emergency Auto-Trim สามารถคืนพื้นที่บางส่วนได้ แต่ระดับพื้นที่จัดเก็บยังอยู่ในเกณฑ์เฝ้าระวัง (Soft Quota) ยังไม่กลับสู่สถานะปกติสมบูรณ์",
                                context: {
                                    "สาเหตุที่เกิด": evalResult.reasons[0] || "Storage critical",
                                    "พื้นที่ที่คืนได้": `${trim.freedMb} MB`,
                                    "จำนวนรายการที่ลบ": `${trim.itemsPurged?.totalItems || 0} รายการ`,
                                    "ขนาดก่อน ➔ หลัง": `${trim.preFootprint?.totalMb} MB ➔ ${trim.postFootprint?.totalMb} MB`,
                                    "สถานะล่าสุด": "SOFT WARNING",
                                    "ระยะเวลาดำเนินการ": `${trim.durationMs} ms`
                                }
                            }).catch(() => {});
                        } catch (_) {}
                    } else {
                        diagnostics.emergency.lastStatus = "degraded";
                    }
                }
            }

            // 2. Policy B: Telemetry Write-Behind Buffer Pressure Alert & Drain (RAM / Writer Pressure)
            // Attempt to drain pending events from write-behind buffers via active flush.
            // Bounded queue priority eviction and webhook alerting are managed within the repositories.
            // Note: Does NOT trigger Emergency Trim on physical disk assets, because buffer pressure is RAM/writer pressure.
            if (evalResult.isBufferEmergency) {
                if (!evalResult.isStorageEmergency) {
                    diagnostics.emergency.lastStatus = "buffer_pressure";
                }
                const bufferKey = "sqlite_emergency_buffer";
                if (canSendAlert(bufferKey)) {
                    recordAlertSent(bufferKey);
                    try {
                        sendWebhookEvent({
                            target: "ALERT",
                            severity: "WARNING",
                            category: "DATA",
                            code: "sqlite.buffer.critical",
                            title: "🟠 ตรวจพบภาวะแรงกดดันคิวพักข้อมูล Telemetry Buffer (Buffer Pressure)",
                            description: `คิวพักข้อมูล Write-Behind ใน RAM มีขนาดสะสมเกินเกณฑ์วิกฤต (${evalResult.writeBufferCount} รายการ) ระบบดำเนินการระบายข้อมูล (Drain Flush) และเปิดใช้งาน Priority Eviction โดยไม่แตะต้องหรือลบแคชไฟล์บนดิสก์`,
                            context: {
                                "จำนวน Buffer ใน RAM": `${evalResult.writeBufferCount} รายการ`,
                                "เพดานวิกฤต": `${evalResult.bufferThreshold} รายการ`,
                                "มาตรการ": "Active Queue Drain Flush + Priority Eviction (No Disk Trim)"
                            }
                        }).catch(() => {});
                    } catch (_) {}
                }

                try {
                    const { getVoiceEventRepository } = require("../repositories/history/VoiceEventRepository");
                    const { getCommandEventRepository } = require("../repositories/history/CommandEventRepository");
                    const { getSessionEventRepository } = require("../repositories/history/SessionEventRepository");
                    getVoiceEventRepository()?.flush();
                    getCommandEventRepository()?.flush();
                    getSessionEventRepository()?.flush();
                } catch (flushErr) {
                    console.warn(`[DB_SCHEDULER] ⚠️ Buffer drain flush warning: ${flushErr.message}`);
                }
            }
        } else {
            diagnostics.emergency.lastStatus = "normal";
        }
    } catch (err) {
        console.error(`[DB_SCHEDULER] ⚠️ Emergency evaluation error: ${err.message}`);
    } finally {
        isEmergencyRunning = false;
    }
}

function startScheduler() {
    if (walIntervalId || cleanupIntervalId || vacuumIntervalId || backupIntervalId || emergencyIntervalId) {
        return; // Already running
    }

    const walMinutes = parseMinutes("SQLITE_WAL_CHECKPOINT_INTERVAL_MINUTES", 60);
    const cleanupMinutes = parseMinutes("SQLITE_CLEANUP_INTERVAL_MINUTES", 360);
    const vacuumMinutes = parseMinutes("SQLITE_VACUUM_INTERVAL_MINUTES", 1440);
    const autoBackupEnabled = process.env.SQLITE_AUTO_BACKUP_ENABLED !== "false";
    const backupHours = parseHours("SQLITE_AUTO_BACKUP_INTERVAL_HOURS", 24);

    schedulerStartedAt = Date.now();
    configuredIntervalsMs = {
        wal: walMinutes * 60 * 1000,
        cleanup: cleanupMinutes * 60 * 1000,
        vacuum: vacuumMinutes * 60 * 1000,
        backup: backupHours * 60 * 60 * 1000,
        emergency: 2 * 60 * 1000
    };

    walIntervalId = setInterval(runWalCheckpoint, walMinutes * 60 * 1000);
    if (walIntervalId.unref) walIntervalId.unref();

    cleanupIntervalId = setInterval(runCleanup, cleanupMinutes * 60 * 1000);
    if (cleanupIntervalId.unref) cleanupIntervalId.unref();

    vacuumIntervalId = setInterval(runVacuum, vacuumMinutes * 60 * 1000);
    if (vacuumIntervalId.unref) vacuumIntervalId.unref();

    if (autoBackupEnabled) {
        const intervalMs = backupHours * 60 * 60 * 1000;
        const backups = listBackups();
        const now = Date.now();
        // Baseline safety policy: Even if SQLITE_AUTO_BACKUP_INITIAL is not explicitly "true",
        // if no previous backup exists at all (backups.length === 0), run an initial baseline backup
        // after 5s to guarantee we always have a restore point before runtime mutations accumulate.
        const shouldRunInitialBackup = process.env.SQLITE_AUTO_BACKUP_INITIAL === "true" || backups.length === 0;

        let delayUntilFirstBackup = intervalMs;
        if (shouldRunInitialBackup) {
            delayUntilFirstBackup = 5000;
        } else if (backups.length > 0) {
            const lastBackupTime = backups[0].mtime || now;
            const elapsed = now - lastBackupTime;
            if (elapsed >= intervalMs) {
                // Past interval, run promptly
                delayUntilFirstBackup = 5000;
            } else {
                // Schedule for the remaining time
                delayUntilFirstBackup = Math.max(5000, intervalMs - elapsed);
            }
        }

        nextScheduledBackupAt = now + delayUntilFirstBackup;
        console.log(`[DB_SCHEDULER] 💾 Next auto-backup scheduled in ${Math.round(delayUntilFirstBackup / 1000)}s (${(delayUntilFirstBackup / (60 * 60 * 1000)).toFixed(1)}h)`);

        initialBackupTimeoutId = setTimeout(async () => {
            initialBackupTimeoutId = null;
            try {
                await runAutoBackup();
            } catch (err) {
                console.error(`[DB_SCHEDULER] ⚠️ Initial scheduled backup failed: ${err.message}`);
            }
            nextScheduledBackupAt = Date.now() + intervalMs;
            backupIntervalId = setInterval(() => {
                nextScheduledBackupAt = Date.now() + intervalMs;
                runAutoBackup().catch(err => {
                    console.error(`[DB_SCHEDULER] ⚠️ Auto-backup failed: ${err.message}`);
                });
            }, intervalMs);
            if (backupIntervalId.unref) backupIntervalId.unref();
        }, delayUntilFirstBackup);
        if (initialBackupTimeoutId.unref) initialBackupTimeoutId.unref();
    }

    emergencyIntervalId = setInterval(runEmergencyEvaluation, 2 * 60 * 1000);
    if (emergencyIntervalId.unref) emergencyIntervalId.unref();

    console.log(`[DB_SCHEDULER] 🕒 Background Maintenance Scheduler started (WAL=${walMinutes}m, Cleanup=${cleanupMinutes}m, Vacuum=${vacuumMinutes}m, EmergencyCheck=2m, AutoBackup=${autoBackupEnabled ? `${backupHours}h` : "disabled"})`);
}

function stopScheduler() {
    if (initialBackupTimeoutId) {
        clearTimeout(initialBackupTimeoutId);
        initialBackupTimeoutId = null;
    }
    nextScheduledBackupAt = null;
    if (walIntervalId) {
        clearInterval(walIntervalId);
        walIntervalId = null;
    }
    if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
    if (vacuumIntervalId) {
        clearInterval(vacuumIntervalId);
        vacuumIntervalId = null;
    }
    if (backupIntervalId) {
        clearInterval(backupIntervalId);
        backupIntervalId = null;
    }
    if (emergencyIntervalId) {
        clearInterval(emergencyIntervalId);
        emergencyIntervalId = null;
    }
    schedulerStartedAt = null;
    console.log("[DB_SCHEDULER] 🛑 Background Maintenance Scheduler stopped.");
}

function hasCriticalRunningTasks() {
    return Boolean(isBackupRunning);
}

function hasRunningTasks() {
    return Boolean(isWalRunning || isCleanupRunning || isVacuumRunning || isBackupRunning || isEmergencyRunning);
}

async function drainSchedulerTasks(timeoutMs = null) {
    const configuredTimeout = parseInt(process.env.SQLITE_SHUTDOWN_DRAIN_TIMEOUT_MS, 10);
    const defaultTimeout = hasCriticalRunningTasks() ? 60000 : 30000;
    const effectiveTimeoutMs = (typeof timeoutMs === "number" && timeoutMs > 0)
        ? timeoutMs
        : (!isNaN(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : defaultTimeout);

    if (hasCriticalRunningTasks()) {
        console.log(`[DB_SCHEDULER] ⏳ Waiting for critical database backup to finish before shutdown (timeout: ${effectiveTimeoutMs}ms)...`);
    }

    const start = Date.now();
    while (hasRunningTasks() && (Date.now() - start) < effectiveTimeoutMs) {
        await new Promise(r => setTimeout(r, 50));
    }
    return !hasRunningTasks();
}

function triggerEmergencyEvaluation(reason = "event_triggered") {
    setImmediate(() => {
        runEmergencyEvaluation().catch(err => {
            console.error(`[DB_SCHEDULER] ⚠️ Event-triggered emergency evaluation failed (${reason}): ${err.message}`);
        });
    });
}

function getSchedulerDiagnostics() {
    const now = Date.now();
    const baseTime = schedulerStartedAt || now;

    const calcNext = (timerKey, intervalMs, isRunning) => {
        if (!isRunning) return null;
        const lastRun = diagnostics[timerKey]?.lastRunAt;
        if (lastRun) {
            return lastRun + intervalMs;
        }
        return baseTime + intervalMs;
    };

    const diagnosticsWithNext = {
        wal: {
            ...diagnostics.wal,
            nextRunAt: calcNext("wal", configuredIntervalsMs.wal, Boolean(walIntervalId)),
            intervalMinutes: Math.round(configuredIntervalsMs.wal / 60000)
        },
        cleanup: {
            ...diagnostics.cleanup,
            nextRunAt: calcNext("cleanup", configuredIntervalsMs.cleanup, Boolean(cleanupIntervalId)),
            intervalMinutes: Math.round(configuredIntervalsMs.cleanup / 60000)
        },
        vacuum: {
            ...diagnostics.vacuum,
            nextRunAt: calcNext("vacuum", configuredIntervalsMs.vacuum, Boolean(vacuumIntervalId)),
            intervalMinutes: Math.round(configuredIntervalsMs.vacuum / 60000)
        },
        backup: {
            ...diagnostics.backup,
            nextRunAt: nextScheduledBackupAt || calcNext("backup", configuredIntervalsMs.backup, Boolean(backupIntervalId)),
            intervalHours: Math.round(configuredIntervalsMs.backup / 3600000)
        },
        emergency: {
            ...diagnostics.emergency,
            nextRunAt: calcNext("emergency", configuredIntervalsMs.emergency, Boolean(emergencyIntervalId)),
            intervalMinutes: Math.round(configuredIntervalsMs.emergency / 60000)
        }
    };

    return {
        active: Boolean(walIntervalId || cleanupIntervalId || vacuumIntervalId || backupIntervalId || emergencyIntervalId || initialBackupTimeoutId),
        startedAt: schedulerStartedAt,
        timers: {
            wal: Boolean(walIntervalId),
            cleanup: Boolean(cleanupIntervalId),
            vacuum: Boolean(vacuumIntervalId),
            backup: Boolean(backupIntervalId || initialBackupTimeoutId),
            emergency: Boolean(emergencyIntervalId),
            initialBackupScheduled: Boolean(initialBackupTimeoutId)
        },
        diagnostics: diagnosticsWithNext
    };
}

module.exports = {
    startScheduler,
    stopScheduler,
    runWalCheckpoint,
    runCleanup,
    runVacuum,
    runAutoBackup,
    runEmergencyEvaluation,
    triggerEmergencyEvaluation,
    getSchedulerDiagnostics,
    hasRunningTasks,
    hasCriticalRunningTasks,
    drainSchedulerTasks
};
