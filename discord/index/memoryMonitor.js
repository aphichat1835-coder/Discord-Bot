/*
================================================================================
🧠 Lightweight Memory Monitor
- Logs current memory pressure only; does not store historical samples.
- Designed for Render OOM diagnosis without changing runtime architecture.
================================================================================
*/

let memoryTimer = null;
let lastHeapUsed = 0;

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

    memoryTimer = setInterval(() => {
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
            console.error(`[MEMORY] 🚨 Heap critical: ${heapUsed}MB`);
        }
    }, intervalMs);

    memoryTimer.unref?.();
}

function stopMemoryMonitor() {
    if (!memoryTimer) return;

    clearInterval(memoryTimer);
    memoryTimer = null;
}

module.exports = {
    startMemoryMonitor,
    stopMemoryMonitor
};
