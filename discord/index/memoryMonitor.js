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

function mb(bytes) {
    return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
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

    memoryTimer = setInterval(async () => {
        try {
            if (system?.isShuttingDown?.()) return;

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
            const auditStats = auditLogger?.getAuditStats?.();

            console.log(
                `[MEMORY] heap=${heapUsed}/${heapTotal}MB rss=${rss}MB external=${external}MB diff=${diff}MB ` +
                `sessions=${sessions} clientPool=${clientPool} ` +
                `naturalTimers=${natural?.activeTimers ?? "-"} autoDeafTimers=${autoDeaf?.activeTimers ?? "-"} ` +
                `audit=${auditStats ? JSON.stringify(auditStats) : "-"}`
            );

            if (heapUsed > 180) {
                console.warn(`[MEMORY] ⚠️ Heap high: ${heapUsed}MB`);
            }

            if (heapUsed > 220) {
                criticalCount += 1;
                console.error(`[MEMORY] 🚨 Heap critical: ${heapUsed}MB (${criticalCount}/3)`);
            } else {
                criticalCount = 0;
            }

            if (criticalCount >= 3 && !emergencyCleanupRunning) {
                emergencyCleanupRunning = true;
                console.error("[MEMORY] 🚨 Critical memory sustained. Pausing voice sessions before exit.");

                try {
                    system?.markAppShuttingDown?.();
                    voiceWorker?.setShuttingDown?.(true);
                    await voiceWorker?.pauseAll?.();
                    await sessionManager?.saveDatabase?.();
                } catch (e) {
                    console.error(`[MEMORY] Emergency cleanup failed: ${e.message}`);
                } finally {
                    process.exit(1);
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
}

module.exports = {
    startMemoryMonitor,
    stopMemoryMonitor
};
