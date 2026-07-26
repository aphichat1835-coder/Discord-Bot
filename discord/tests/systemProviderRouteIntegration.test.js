"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const dashboardAuth = require("../index/auth");
const { makeCheckAuth } = require("../guards/dashboardGuards");
const sessionManager = require("../sessionManager");
const systemProvider = require("../systemProvider");

function envSnapshot(names) {
    return Object.fromEntries(names.map(name => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
    for (const [name, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

function createClient() {
    const listeners = new Map();
    return {
        user: { id: "999999999999999999", tag: "TestBot#0001", username: "TestBot" },
        ws: { ping: 1 },
        guilds: { cache: new Map() },
        channels: { cache: new Map(), async fetch() { return null; } },
        async fetchWebhook() { return null; },
        on(event, listener) { listeners.set(event, listener); },
        off(event, listener) {
            if (listeners.get(event) === listener) listeners.delete(event);
        }
    };
}

function cookiePair(setCookie) {
    return String(setCookie || "").split(";", 1)[0];
}

test("protected portal works through the real main-auth and CSRF middleware stack", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const env = envSnapshot([
        "API_SECRET",
        "DASHBOARD_PIN",
        "SHADOW_SESSION_SECRET",
        "SHADOW_PORTAL_PIN",
        "NODE_ENV"
    ]);
    const originalGetSetting = sessionManager.getSetting;
    const originalSetSetting = sessionManager.setSetting;
    process.env.API_SECRET = "main-api-secret-for-test";
    process.env.DASHBOARD_PIN = "main-owner-pin";
    process.env.SHADOW_SESSION_SECRET = "protected-session-secret-for-test";
    process.env.NODE_ENV = "test";

    sessionManager.getSetting = async (key, fallback) => {
        if (key === "_shadowPortalAuth") return {
            pin: "protected-owner-pin",
            sessionVersion: 1
        };
        if (key === "_shadowPin") return null;
        return fallback;
    };
    sessionManager.setSetting = async () => true;

    const app = express();
    const client = createClient();
    const checkAuth = makeCheckAuth(process.env.API_SECRET);
    app.use("/api", (req, res, next) => {
        if (!checkAuth(req, res)) return;
        return dashboardAuth.requireCsrf(req, res, next);
    });

    await systemProvider.initializeSystemHooks(client);
    systemProvider.setupTelemetryRouter(app, client, null);

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const mainToken = dashboardAuth.makeToken();
    const csrfToken = dashboardAuth.makeCsrfToken(mainToken);
    const mainCookies = `${dashboardAuth.COOKIE_NAME}=${encodeURIComponent(mainToken)}; ${dashboardAuth.CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`;
    const headers = {
        cookie: mainCookies,
        "content-type": "application/x-www-form-urlencoded"
    };

    try {
        const fakeHeader = await fetch(`${baseUrl}/api/v1/telemetry/snapshot/login`, {
            method: "POST",
            headers: {
                authorization: "Bearer wrong-secret",
                "content-type": "application/x-www-form-urlencoded"
            },
            body: "pin=protected-owner-pin"
        });
        assert.equal(fakeHeader.status, 401);

        const missingCsrf = await fetch(`${baseUrl}/api/v1/telemetry/snapshot/login`, {
            method: "POST",
            headers,
            body: "pin=protected-owner-pin"
        });
        assert.equal(missingCsrf.status, 403);

        const queryPin = await fetch(`${baseUrl}/api/v1/telemetry/snapshot?pin=protected-owner-pin`, {
            headers: { cookie: mainCookies }
        });
        assert.equal(queryPin.status, 401);

        const login = await fetch(`${baseUrl}/api/v1/telemetry/snapshot/login`, {
            method: "POST",
            headers: { ...headers, "x-csrf-token": csrfToken },
            body: "pin=protected-owner-pin"
        });
        assert.equal(login.status, 200);
        const protectedCookie = cookiePair(login.headers.get("set-cookie"));
        assert.match(protectedCookie, /^__shadow=/);

        const dashboard = await fetch(`${baseUrl}/api/v1/telemetry/snapshot`, {
            headers: { cookie: `${mainCookies}; ${protectedCookie}` }
        });
        assert.equal(dashboard.status, 200);
        assert.match(await dashboard.text(), /Dashboard ควบคุมบอท/i);

        const logout = await fetch(`${baseUrl}/api/v1/telemetry/snapshot/logout`, {
            method: "POST",
            headers: {
                ...headers,
                cookie: `${mainCookies}; ${protectedCookie}`,
                "x-csrf-token": csrfToken
            },
            body: ""
        });
        assert.equal(logout.status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
        systemProvider.shutdownSystemHooks();
        sessionManager.getSetting = originalGetSetting;
        sessionManager.setSetting = originalSetSetting;
        restoreEnv(env);
    }
});
