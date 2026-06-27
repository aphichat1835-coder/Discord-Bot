const assert = require("assert");
const { startAuditRuntime, auditReconcilerScheduler } = require("../logging/auditRuntimeLifecycle");
const { registerAuditWebBundle } = require("../index/auditWebBundle");

function createApp() {
    const routes = [];
    return {
        routes,
        get(path, ...handlers) {
            routes.push({ method: "GET", path, handlers });
        }
    };
}

function createLogger() {
    return { logs: [], log(message) { this.logs.push(message); } };
}

async function run() {
    const originalStart = auditReconcilerScheduler.start;
    const originalStop = auditReconcilerScheduler.stop;

    try {
        let startCall = null;
        auditReconcilerScheduler.start = (client, sessionManager, options) => {
            startCall = { client, sessionManager, options };
            return { started: true, intervalMs: 60000, mode: options.allowSettingsDriven ? "settings_driven" : "forced" };
        };
        auditReconcilerScheduler.stop = () => true;

        const client = { id: "client" };
        const sessionManager = { id: "sessionManager" };
        const logger = createLogger();
        const result = startAuditRuntime({ client, sessionManager, logger, allowSettingsDriven: true });

        assert.strictEqual(result.started, true);
        assert.strictEqual(startCall.client, client);
        assert.strictEqual(startCall.sessionManager, sessionManager);
        assert.strictEqual(startCall.options.allowSettingsDriven, true);
        assert(logger.logs.some(line => line.includes("settings_driven")));
    } finally {
        auditReconcilerScheduler.start = originalStart;
        auditReconcilerScheduler.stop = originalStop;
    }

    const app = createApp();
    const express = { json: () => (_req, _res, next) => next?.() };
    const checkAuth = (_req, _res) => true;
    const requireCsrf = (_req, _res, next) => next?.();

    registerAuditWebBundle({
        app,
        express,
        sessionManager: {},
        client: {},
        auditLogger: {},
        checkAuth,
        requireCsrf
    });

    const auditPageRoute = app.routes.find(route => route.method === "GET" && route.path === "/audit-logs");
    assert(auditPageRoute, "/audit-logs route should be registered");
    assert.strictEqual(auditPageRoute.handlers.length, 2, "/audit-logs should include auth middleware and renderer");
    assert.strictEqual(typeof auditPageRoute.handlers[0], "function");
    assert.strictEqual(typeof auditPageRoute.handlers[1], "function");
}

run().then(() => {
    console.log("auditRuntimeIntegrationBehavior.test passed");
}).catch(err => {
    console.error(err);
    process.exit(1);
});
