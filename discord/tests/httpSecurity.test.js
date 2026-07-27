"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

const {
    buildHealthPayload,
    createHttpApp
} = require("../core/http");

async function withServer(app, fn) {
    const server = await new Promise((resolve, reject) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
        instance.once("error", reject);
    });
    try {
        const address = server.address();
        return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test("health is process liveness while ready remains available for dependency readiness", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const previous = global.__APP_SHUTTING_DOWN;
    const app = createHttpApp(express);

    await withServer(app, async baseUrl => {
        global.__APP_SHUTTING_DOWN = false;
        const healthyResponse = await fetch(`${baseUrl}/health`);
        const healthyPayload = await healthyResponse.json();
        assert.equal(healthyResponse.status, 200);
        assert.equal(healthyPayload.healthy, true);
        assert.equal(healthyPayload.status, "ok");

        global.__APP_SHUTTING_DOWN = true;
        const stoppingResponse = await fetch(`${baseUrl}/health`);
        const stoppingPayload = await stoppingResponse.json();
        assert.equal(stoppingResponse.status, 503);
        assert.equal(stoppingPayload.healthy, false);
        assert.equal(stoppingPayload.status, "stopping");
    });

    if (previous === undefined) delete global.__APP_SHUTTING_DOWN;
    else global.__APP_SHUTTING_DOWN = previous;
});

test("sensitive API and auth responses are never cacheable", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const app = createHttpApp(express);
    app.get("/api/session/example", (_req, res) => res.json({ token: "owner-visible" }));
    app.get("/auth/example", (_req, res) => res.send("auth"));
    app.get("/public/example", (_req, res) => res.send("public"));

    await withServer(app, async baseUrl => {
        for (const path of ["/api/session/example", "/auth/example"]) {
            const response = await fetch(`${baseUrl}${path}`);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(response.headers.get("pragma"), "no-cache");
            assert.equal(response.headers.get("expires"), "0");
        }

        const publicResponse = await fetch(`${baseUrl}/public/example`);
        assert.equal(publicResponse.headers.get("cache-control"), null);
    });
});

test("health payload is deterministic for explicit shutdown state", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(buildHealthPayload({ shuttingDown: false }).healthy, true);
    assert.equal(buildHealthPayload({ shuttingDown: true }).healthy, false);
});
