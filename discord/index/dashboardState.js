function buildCommandStatusPayload(commands, disabledCommands) {
    const commandList = Array.isArray(commands?.slashCommandsData)
        ? commands.slashCommandsData
        : [];

    const allCmds = commandList.map(cmd => ({
        name: cmd.name,
        description: cmd.description || "",
        enabled: !disabledCommands.has(cmd.name)
    }));

    return {
        success: true,
        commands: allCmds,
        disabledCount: disabledCommands.size
    };
}

function buildCommandAuditPayload(commandAuditLog) {
    return {
        success: true,
        log: [...commandAuditLog].reverse()
    };
}

function buildRuntimeStatusPayload({
    sessionManager,
    voiceWorker,
    webLogs,
    client,
    config,
    botReadyAt,
    serializeVoiceSession
}) {
    const sessions = Array.from(sessionManager.getAllSessions().values())
        .filter(session => sessionManager.isSessionRunnable?.(session) !== false);
    const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
    const mem = process.memoryUsage();
    const voiceLogs = voiceWorker.getVoiceLogs();
    const voiceSummary = { connect: 0, recover: 0, drop: 0, disconnect: 0, fail: 0 };

    voiceLogs.forEach(e => {
        if (voiceSummary[e.type] !== undefined) voiceSummary[e.type]++;
    });

    const totalReq = sessionManager.systemMetrics.requests;
    const totalErr = sessionManager.systemMetrics.errors;
    const reconnects = sessionManager.systemMetrics.reconnects;
    const successRate = totalReq > 0
        ? (((totalReq - totalErr) / totalReq) * 100).toFixed(1)
        : "100.0";

    const readyAt = typeof botReadyAt === "function" ? botReadyAt() : botReadyAt;
    const botOnlineSec = readyAt ? Math.floor((Date.now() - readyAt) / 1000) : null;

    const dynamicMaxSessions = Number(sessionManager.getCachedSetting?.("maxSessions", config.limits.maxSessions));

    return safeDashboardPayload({
        botOnline: client?.isReady?.() ?? false,
        botTag: client?.user?.tag ?? null,
        uptimeSec,
        botOnlineSec,
        sessions: sessions.length,
        maxSessions: Number.isFinite(dynamicMaxSessions) && dynamicMaxSessions > 0
            ? dynamicMaxSessions
            : config.limits.maxSessions,
        sessionList: sessions.map(session => serializeVoiceSession(session)),
        clientPool: voiceWorker.getClientPoolSize(),
        ramMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
        ramTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
        reconnects,
        successRate,
        voiceSummary,
        recentLogs: webLogs.slice(-60).reverse()
    });
}

function safeDashboardPayload(payload) {
    if (typeof structuredClone === "function") {
        return structuredClone(payload);
    }

    return JSON.parse(JSON.stringify(payload));
}

module.exports = {
    buildCommandStatusPayload,
    buildCommandAuditPayload,
    buildRuntimeStatusPayload,
    safeDashboardPayload
};
