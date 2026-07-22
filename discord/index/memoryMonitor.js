/*
================================================================================
🧠 Lightweight Memory Monitor
- Logs current memory pressure and keeps a small numeric trend buffer.
- Designed for Render OOM diagnosis without changing runtime architecture.
================================================================================
*/

const v8 = require("node:v8");

let memoryTimer = null;
let lastHeapUsed = 0;
let criticalCount = 0;
let emergencyCleanupRunning = false;
let lastSnapshot = null;
const memoryTrend = [];

function mb(bytes) {
    return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

function getCacheSize(cacheLike) {
    return Number(cacheLike?.cache?.size ?? cacheLike?.size ?? 0) || 0;
}

function getDiscordCacheStats(client) {
    const stats = {
        ready: !!client?.isReady?.(),
        guilds: getCacheSize(client?.guilds),
        channels: getCacheSize(client?.channels),
        users: getCacheSize(client?.users),
        guildMembers: 0,
        guildChannels: 0,
        voiceStates: 0,
        roles: 0,
        messages: 0
    };

    for (const guild of client?.guilds?.cache?.values?.() || []) {
        stats.guildMembers += getCacheSize(guild.members);
        stats.guildChannels += getCacheSize(guild.channels);
        stats.voiceStates += getCacheSize(guild.voiceStates);
        stats.roles += getCacheSize(guild.roles);
    }

    for (const channel of client?.channels?.cache?.values?.() || []) {
        stats.messages += getCacheSize(channel?.messages);
    }

    return stats;
}

function getActiveHandleStats() {
    const handles = typeof process._getActiveHandles === "function"
        ? process._getActiveHandles()
        : [];
    const counts = {};

    for (const handle of handles) {
        const name = handle?.constructor?.name || "Unknown";
        counts[name] = (counts[name] || 0) + 1;
    }

    return {
        total: handles.length,
        byType: counts
    };
}

function getV8HeapStats() {
    const stats = v8.getHeapStatistics();
    const spaces = v8.getHeapSpaceStatistics();

    return {
        heapSizeLimit: mb(stats.heap_size_limit),
        totalAvailableSize: mb(stats.total_available_size),
        mallocedMemory: mb(stats.malloced_memory),
        peakMallocedMemory: mb(stats.peak_malloced_memory),
        externalMemory: mb(stats.external_memory),
        spaces: Object.fromEntries(
            spaces.map(space => [
                space.space_name,
                {
                    used: mb(space.space_used_size),
                    size: mb(space.space_size),
                    available: mb(space.space_available_size),
                    physical: mb(space.physical_space_size)
                }
            ])
        )
    };
}

function getEmitterListenerStats(emitter, allowList = []) {
    if (!emitter || typeof emitter.eventNames !== "function" || typeof emitter.listenerCount !== "function") {
        return { total: 0, byEvent: {} };
    }

    const byEvent = {};
    let total = 0;
    const allowed = new Set(allowList);

    for (const event of emitter.eventNames()) {
        const name = String(event);
        const count = emitter.listenerCount(event);
        total += count;
        if (!allowed.size || allowed.has(name)) {
            byEvent[name] = count;
        }
    }

    return { total, byEvent };
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
        trendMax: Math.max(2, Math.floor(numberEnv("MEMORY_TREND_MAX", 24, 2))),
        criticalMode
    };
}

function toSafeNumber(value, fallback = 0) {
    return Number(value || fallback) || fallback;
}

function compactTrendSample(snapshot) {
    return {
        at: snapshot.at,
        heapUsed: snapshot.heapUsed,
        heapTotal: snapshot.heapTotal,
        rss: snapshot.rss,
        external: snapshot.external,
        diff: snapshot.diff,
        sessions: snapshot.sessions,
        clientPool: snapshot.clientPool,
        selfClientMessages: toSafeNumber(snapshot.workerDiagnostics?.selfClientCaches?.messages),
        selfClientUsers: toSafeNumber(snapshot.workerDiagnostics?.selfClientCaches?.users),
        selfClientListeners: toSafeNumber(snapshot.workerDiagnostics?.selfClientListeners?.total),
        discordMessages: toSafeNumber(snapshot.discordCaches?.messages),
        discordUsers: toSafeNumber(snapshot.discordCaches?.users),
        discordListeners: toSafeNumber(snapshot.discordListeners?.total),
        activeHandles: toSafeNumber(snapshot.activeHandles?.total),
        naturalTimers: snapshot.natural?.activeTimers ?? 0,
        autoDeafTimers: snapshot.autoDeaf?.activeTimers ?? 0,
        v8Available: toSafeNumber(snapshot.v8?.totalAvailableSize),
        v8Malloced: toSafeNumber(snapshot.v8?.mallocedMemory)
    };
}

function recordMemoryTrend(snapshot) {
    memoryTrend.push(compactTrendSample(snapshot));

    while (memoryTrend.length > snapshot.config.trendMax) {
        memoryTrend.shift();
    }
}

function buildMemorySnapshot({ voiceWorker, sessionManager, client }) {
    const mem = process.memoryUsage();
    const heapUsed = mb(mem.heapUsed);
    const heapTotal = mb(mem.heapTotal);
    const rss = mb(mem.rss);
    const external = mb(mem.external);
    const diff = lastHeapUsed ? Math.round((heapUsed - lastHeapUsed) * 10) / 10 : 0;
    const natural = voiceWorker?.getNaturalSettings?.();
    const autoDeaf = voiceWorker?.getAutoDeafSettings?.();
    const workerDiagnostics = voiceWorker?.getWorkerDiagnostics?.();
    const sessionDiagnostics = sessionManager?.getSessionDiagnostics?.();

    lastHeapUsed = heapUsed;

    return {
        heapUsed,
        heapTotal,
        rss,
        external,
        diff,
        sessions: sessionManager?.getAllSessions?.()?.size ?? 0,
        clientPool: voiceWorker?.getClientPoolSize?.() ?? 0,
        natural,
        autoDeaf,
        workerDiagnostics,
        sessionDiagnostics,
        discordCaches: getDiscordCacheStats(client),
        discordListeners: getEmitterListenerStats(client, [
            "ready",
            "messageCreate",
            "interactionCreate",
            "guildCreate",
            "guildDelete",
            "voiceStateUpdate",
            "guildMemberAdd",
            "guildMemberRemove"
        ]),
        activeHandles: getActiveHandleStats(),
        v8: getV8HeapStats(),
        criticalCount,
        config: getMemoryMonitorConfig(),
        at: Date.now()
    };
}

function logMemorySnapshot(snapshot) {
    console.log(
        `[MEMORY] heap=${snapshot.heapUsed}/${snapshot.heapTotal}MB rss=${snapshot.rss}MB ` +
        `external=${snapshot.external}MB diff=${snapshot.diff}MB ` +
        `sessions=${snapshot.sessions} clientPool=${snapshot.clientPool} ` +
        `naturalTimers=${snapshot.natural?.activeTimers ?? "-"} ` +
        `autoDeafTimers=${snapshot.autoDeaf?.activeTimers ?? "-"} ` +
        `worker=${snapshot.workerDiagnostics ? JSON.stringify(snapshot.workerDiagnostics) : "-"} ` +
        `discord=${JSON.stringify(snapshot.discordCaches)} ` +
        `session=${snapshot.sessionDiagnostics ? JSON.stringify(snapshot.sessionDiagnostics) : "-"} ` +
        `listeners=${JSON.stringify(snapshot.discordListeners)} ` +
        `handles=${JSON.stringify(snapshot.activeHandles)} ` +
        `v8=${JSON.stringify({
            heapSizeLimit: snapshot.v8.heapSizeLimit,
            totalAvailableSize: snapshot.v8.totalAvailableSize,
            mallocedMemory: snapshot.v8.mallocedMemory,
            externalMemory: snapshot.v8.externalMemory
        })}`
    );
}

function updateCriticalCount(heapUsed, monitorConfig) {
    if (heapUsed > monitorConfig.criticalMb) {
        criticalCount += 1;
        console.error(`[MEMORY] 🚨 Heap critical: ${heapUsed}MB (${criticalCount}/${monitorConfig.criticalRounds})`);
        return;
    }

    criticalCount = 0;
}

async function runEmergencyCleanup({ monitorConfig, voiceWorker, sessionManager, system }) {
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

function startMemoryMonitor({
    intervalMs = 60000,
    voiceWorker,
    sessionManager,
    client,
    system
} = {}) {
    stopMemoryMonitor();

    criticalCount = 0;
    emergencyCleanupRunning = false;
    lastHeapUsed = 0;

    memoryTimer = setInterval(async () => {
        try {
            if (system?.isShuttingDown?.()) return;
            lastSnapshot = buildMemorySnapshot({ voiceWorker, sessionManager, client });
            recordMemoryTrend(lastSnapshot);
            logMemorySnapshot(lastSnapshot);

            if (lastSnapshot.heapUsed > lastSnapshot.config.warnMb) {
                console.warn(`[MEMORY] ⚠️ Heap high: ${lastSnapshot.heapUsed}MB`);
                voiceWorker?.cleanupVolatileState?.(Date.now(), { cleanupSelfClientCaches: true });
            }

            updateCriticalCount(lastSnapshot.heapUsed, lastSnapshot.config);

            if (criticalCount >= lastSnapshot.config.criticalRounds && !emergencyCleanupRunning) {
                await runEmergencyCleanup({
                    monitorConfig: lastSnapshot.config,
                    voiceWorker,
                    sessionManager,
                    system
                });
            }
        } catch (e) {
            console.error(`[MEMORY] Monitor failed: ${e.message}`);
        }
    }, intervalMs);

    memoryTimer.unref?.();
}

function captureMemorySnapshot(label, { voiceWorker, sessionManager, client } = {}) {
    lastSnapshot = buildMemorySnapshot({ voiceWorker, sessionManager, client });
    recordMemoryTrend(lastSnapshot);
    const labelText = label ? ` ${label}` : "";
    console.log(`[MEMORY] Snapshot${labelText}`);
    logMemorySnapshot(lastSnapshot);
    return lastSnapshot;
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
        lastSnapshot,
        trend: memoryTrend.slice()
    };
}

module.exports = {
    startMemoryMonitor,
    captureMemorySnapshot,
    stopMemoryMonitor,
    getMemoryMonitorConfig,
    getMemoryMonitorState
};
