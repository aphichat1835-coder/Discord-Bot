const auditReconcilerScheduler = require("./auditReconcilerScheduler");

function startAuditRuntime({ client, sessionManager, logger = console } = {}) {
    const result = auditReconcilerScheduler.start(client, sessionManager, {
        allowSettingsDriven: true
    });
    if (result.started) {
        const mode = result.mode ? ` (${result.mode})` : "";
        logger.log?.(`[AUDIT] 🔁 Audit reconciler scheduler started every ${result.intervalMs}ms${mode}.`);
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
