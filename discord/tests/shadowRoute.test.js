"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const { shouldBypassDashboardReadApi, isShadowPortalRequest } = require("../guards/dashboardGuards");
const { registerRoutes } = require("../index/server");

test("isShadowPortalRequest and shouldBypassDashboardReadApi allow shadow portal endpoints through", () => {
    const getReq = { method: "GET", baseUrl: "", path: "/api/v1/telemetry/snapshot" };
    const loginReq = { method: "POST", baseUrl: "", path: "/api/v1/telemetry/snapshot/login" };
    const actionsReq = { method: "POST", baseUrl: "", path: "/api/v1/telemetry/snapshot/actions" };
    const logoutReq = { method: "POST", baseUrl: "", path: "/api/v1/telemetry/snapshot/logout" };
    const normalApiReq = { method: "GET", baseUrl: "", path: "/api/status" };
    const postApiReq = { method: "POST", baseUrl: "", path: "/api/status" };

    assert.equal(isShadowPortalRequest(getReq), true);
    assert.equal(isShadowPortalRequest(loginReq), true);
    assert.equal(isShadowPortalRequest(actionsReq), true);
    assert.equal(isShadowPortalRequest(logoutReq), true);
    assert.equal(isShadowPortalRequest(normalApiReq), false);

    assert.equal(shouldBypassDashboardReadApi(getReq), true);
    assert.equal(shouldBypassDashboardReadApi(loginReq), true);
    assert.equal(shouldBypassDashboardReadApi(actionsReq), true);
    assert.equal(shouldBypassDashboardReadApi(logoutReq), true);
    assert.equal(shouldBypassDashboardReadApi(normalApiReq), false);
    assert.equal(shouldBypassDashboardReadApi(postApiReq), false);
});

test("/shadow endpoint redirects to /api/v1/telemetry/snapshot", async () => {
    const app = express();
    const client = {
        user: { id: "123456789012345678", tag: "Bot#0001" },
        isReady: () => true,
        guilds: { cache: new Map() },
        channels: { cache: new Map() }
    };
    const sessionManager = {
        getDatabaseStatus: () => ({ connected: true }),
        getAllActiveSessions: () => []
    };

    registerRoutes({
        app,
        express,
        config: { limits: {} },
        sessionManager,
        voiceWorker: { getWorkerDiagnostics: () => ({ ready: true }) },
        commands: { slashCommandsData: [] },
        webLogs: [],
        MAX_LOGS: 10,
        client,
        memoryMonitor: {},
        botReadyAt: () => Date.now(),
        commandsReady: () => true,
        API_SECRET: "test-secret-32-chars-long-requirement",
        requestCounts: new Map(),
        disabledCommands: new Set(),
        commandAuditLog: [],
        toggleCooldowns: new Map(),
        commandCooldowns: new Map(),
        spamTracking: new Map(),
        startRotateTimer: async () => {},
        setupTelemetryRouter: (targetApp) => {
            targetApp.get("/api/v1/telemetry/snapshot", (req, res) => {
                res.status(401).send("<html><body>Shadow Login Page</body></html>");
            });
        }
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
        const shadowRedirectRes = await fetch(`${baseUrl}/shadow`, { redirect: "manual" });
        assert.equal(shadowRedirectRes.status, 302);
        assert.equal(shadowRedirectRes.headers.get("location"), "/api/v1/telemetry/snapshot");

        const shadowSubpathRes = await fetch(`${baseUrl}/shadow/dashboard`, { redirect: "manual" });
        assert.equal(shadowSubpathRes.status, 302);
        assert.equal(shadowSubpathRes.headers.get("location"), "/api/v1/telemetry/snapshot");

        // Visiting /api/v1/telemetry/snapshot directly without main dashboard credentials reaches the shadow portal HTML
        const directShadowRes = await fetch(`${baseUrl}/api/v1/telemetry/snapshot`);
        assert.equal(directShadowRes.status, 401);
        const text = await directShadowRes.text();
        assert.ok(text.includes("Shadow Login Page"));
        assert.equal(text.includes("Unauthorized"), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
