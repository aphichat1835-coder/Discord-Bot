const auditReconcilerScheduler = require("./auditReconcilerScheduler");

function startAuditRuntime({ client, sessionManager, logger = console } = {}) {
    const result = auditReconcilerScheduler.start(client, sessionManager);
    if (result.started) {
        logger.log?.(`[AUDIT] 🔁 Audit reconciler scheduler started every ${result.intervalMs}ms.`);
    } else {
        logger.log?.(`[AUDIT] 🔁 Audit reconciler scheduler inactive: ${result.reason}`);
    }
    return result;
}

function stopAuditRuntime() {
    return auditReconcilerScheduler.stop();
}

function auditRuntimeStats() {
    return auditReconcilerScheduler.stats();
}

module.exports = {
    startAuditRuntime,
    stopAuditRuntime,
    auditRuntimeStats,
    auditReconcilerScheduler
};
