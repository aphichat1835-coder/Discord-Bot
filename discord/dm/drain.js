"use strict";

function delay(ms, setTimer = setTimeout) {
    // This timer is awaited shutdown control flow. Keep it referenced so the
    // promise can always settle even when no other event-loop handle exists.
    return new Promise(resolve => {
        setTimer(resolve, ms);
    });
}

async function drainDmService(dmService, options = {}) {
    if (!dmService) return { stopped: false, drained: true, persisted: 0 };
    const timeoutMs = Math.max(100, Number(options.timeoutMs) || 5000);
    const pollMs = Math.max(5, Number(options.pollMs) || 25);
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const startedAt = now();

    const stopped = await Promise.resolve(dmService.stop?.());
    while (dmService.getDiagnostics?.().workerBusy === true) {
        if (now() - startedAt >= timeoutMs) {
            const error = new Error("DM worker did not drain before shutdown timeout");
            error.code = "DM_DRAIN_TIMEOUT";
            throw error;
        }
        await delay(pollMs, setTimer);
    }

    let persisted = 0;
    if (typeof dmService.persistVolatileOutbox === "function") {
        const result = await dmService.persistVolatileOutbox();
        persisted = Number(result?.persisted || 0);
    }
    const diagnostics = dmService.getDiagnostics?.() || {};
    if (diagnostics.workerBusy === true) {
        const error = new Error("DM worker resumed while shutdown drain was completing");
        error.code = "DM_DRAIN_RACE";
        throw error;
    }
    return { stopped: Boolean(stopped), drained: true, persisted };
}

module.exports = {
    delay,
    drainDmService
};