const assert = require("assert");
const { startAuditRuntime, auditReconcilerScheduler } = require("../logging/auditRuntimeLifecycle");
const { auditPageAuth, registerAuditWebBundle } = require("../index/auditWebBundle");

function createApp() {
    const routes = [];
    return {
        routes,
        get(path, ...handlers) {
            routes.push({ method: "GET", path, handlers });
        },
        post(path, ...handlers) {
            routes.push({ method: "POST", path, handlers });
        }
    };
}

function createLogger() {
    return { logs: [], log(message) { this.logs.push(message); } };
}

describe("audit runtime integration behavior", () => {
    test("starts audit runtime with settings-driven scheduler options", () => {
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
    });

    test("registers audit logs dashboard route behind audit page auth", () => {
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
        assert.strictEqual(auditPageRoute.handlers[0], auditPageAuth);
        assert.strictEqual(typeof auditPageRoute.handlers[1], "function");
    });
});