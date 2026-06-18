/*
================================================================================
🧠 Lightweight Memory Monitor
- Logs current memory pressure only; does not store historical samples.
- Designed for Render OOM diagnosis without changing runtime architecture.
================================================================================
*/

let memoryTimer = null;
let lastHeapUsed = 0;
let criticalCount = 0;
let emergencyCleanupRunning = false;
let lastSnapshot = null;

function mb(bytes) {
    return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

function numberEnv(name, fallback, min = 0) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, value);
}

function getMemoryMonitorConfig() {
    const criticalModeRaw = String(process.env.MEMORY_CRITICAL_MODE || "graceful_exit").trim().toLowerCase();
    const criticalMode = criticalModeRaw === "cleanup_only" ? "cleanup_only" : "graceful_exit";

    return {
        warnMb: numberEnv("MEMORY_WARN_MB", 180, 1),
        criticalMb: numberEnv("MEMORY_CRITICAL_MB", 220, 1),
        criticalRounds: Math.max(1, Math.floor(numberEnv("MEMORY_CRITICAL_ROUNDS", 3, 1))),
        criticalMode
    };
}

function startMemoryMonitor({
    intervalMs = 60000,
    voiceWorker,
    sessionManager,
    auditLogger,
    system
} = {}) {
    stopMemoryMonitor();

    criticalCount = 0;
    emergencyCleanupRunning = false;
    lastHeapUsed = 0;

    memoryTimer = setInterval(async () => {
        try {
            if (system?.isShuttingDown?.()) return;
            const monitorConfig = getMemoryMonitorConfig();

            const mem = process.memoryUsage();
            const heapUsed = mb(mem.heapUsed);
            const heapTotal = mb(mem.heapTotal);
            const rss = mb(mem.rss);
            const external = mb(mem.external);
            const diff = lastHeapUsed ? Math.round((heapUsed - lastHeapUsed) * 10) / 10 : 0;
            lastHeapUsed = heapUsed;

            const sessions = sessionManager?.getAllSessions?.()?.size ?? 0;
            const clientPool = voiceWorker?.getClientPoolSize?.() ?? 0;
            const natural = voiceWorker?.getNaturalSettings?.();
            const autoDeaf = voiceWorker?.getAutoDeafSettings?.();
            const workerDiagnostics = voiceWorker?.getWorkerDiagnostics?.();
            const auditStats = auditLogger?.getAuditStats?.();
            lastSnapshot = {
                heapUsed,
                heapTotal,
                rss,
                external,
                diff,
                sessions,
                clientPool,
                workerDiagnostics,
                auditStats,
                criticalCount,
                config: monitorConfig,
                at: Date.now()
            };

            console.log(
                `[MEMORY] heap=${heapUsed}/${heapTotal}MB rss=${rss}MB external=${external}MB diff=${diff}MB ` +
                `sessions=${sessions} clientPool=${clientPool} ` +
                `naturalTimers=${natural?.activeTimers ?? "-"} autoDeafTimers=${autoDeaf?.activeTimers ?? "-"} ` +
                `worker=${workerDiagnostics ? JSON.stringify(workerDiagnostics) : "-"} ` +
                `audit=${auditStats ? JSON.stringify(auditStats) : "-"}`
            );

            if (heapUsed > monitorConfig.warnMb) {
                console.warn(`[MEMORY] ⚠️ Heap high: ${heapUsed}MB`);
                voiceWorker?.cleanupVolatileState?.();
            }

            if (heapUsed > monitorConfig.criticalMb) {
                criticalCount += 1;
                console.error(`[MEMORY] 🚨 Heap critical: ${heapUsed}MB (${criticalCount}/${monitorConfig.criticalRounds})`);
            } else {
                criticalCount = 0;
            }

            if (criticalCount >= monitorConfig.criticalRounds && !emergencyCleanupRunning) {
                emergencyCleanupRunning = true;
                console.error(`[MEMORY] 🚨 Critical memory sustained. Mode=${monitorConfig.criticalMode}`);

                const shouldExit = monitorConfig.criticalMode !== "cleanup_only";
                const forceExitTimeout = setTimeout(() => {
                    if (shouldExit) {
                        console.error("[MEMORY] 💀 Force-exit timeout reached. Exiting immediately.");
                        process.exit(1);
                    }
                    console.error("[MEMORY] ⚠️ Cleanup-only timeout reached. Keeping process alive.");
                }, 10000);

                try {
                    if (shouldExit) system?.markAppShuttingDown?.();
                    voiceWorker?.setShuttingDown?.(true);
                    await voiceWorker?.pauseAll?.();
                    await sessionManager?.saveDatabase?.();
                } catch (e) {
                    console.error(`[MEMORY] Emergency cleanup failed: ${e.message}`);
                } finally {
                    clearTimeout(forceExitTimeout);
                    if (monitorConfig.criticalMode === "cleanup_only") {
                        emergencyCleanupRunning = false;
                        criticalCount = 0;
                        voiceWorker?.setShuttingDown?.(false);
                    } else {
                        process.exit(1);
                    }
                }
            }
        } catch (e) {
            console.error(`[MEMORY] Monitor failed: ${e.message}`);
        }
    }, intervalMs);

    memoryTimer.unref?.();
}

function stopMemoryMonitor() {
    if (!memoryTimer) return;

    clearInterval(memoryTimer);
    memoryTimer = null;
    criticalCount = 0;
    lastHeapUsed = 0;
}

function getMemoryMonitorState() {
    return {
        running: !!memoryTimer,
        criticalCount,
        emergencyCleanupRunning,
        lastSnapshot
    };
}

module.exports = {
    startMemoryMonitor,
    stopMemoryMonitor,
    getMemoryMonitorConfig,
    getMemoryMonitorState
};
