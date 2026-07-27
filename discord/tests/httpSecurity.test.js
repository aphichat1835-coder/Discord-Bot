"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

const {
    buildHealthPayload,
    buildStoppingReadinessPayload,
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

function saveEnv(keys) {
    return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

test("health is unique liveness and ready becomes unavailable immediately during shutdown", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const previousShutdown = global.__APP_SHUTTING_DOWN;
    const env = saveEnv(["RELEASE_COMMIT_SHA", "IS_PULL_REQUEST"]);
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.RELEASE_COMMIT_SHA = sha;
    process.env.IS_PULL_REQUEST = "true";
    const app = createHttpApp(express);
    let duplicateHealthCalled = 0;
    let readinessCalled = 0;

    app.get("/health", (_req, res) => {
        duplicateHealthCalled++;
        return res.status(500).json({ wrong: true });
    });
    app.get("/ready", (_req, res) => {
        readinessCalled++;
        return res.status(200).json({
            status: "ok",
            ready: true,
            release: { commitSha: sha, provider: "unknown", preview: true }
        });
    });

    try {
        await withServer(app, async baseUrl => {
            global.__APP_SHUTTING_DOWN = false;
            const healthyResponse = await fetch(`${baseUrl}/health`);
            const healthyPayload = await healthyResponse.json();
            assert.equal(healthyResponse.status, 200);
            assert.equal(healthyPayload.healthy, true);
            assert.equal(healthyPayload.status, "ok");
            assert.equal(healthyPayload.release.commitSha, sha);
            assert.equal(healthyPayload.release.preview, true);
            assert.equal(duplicateHealthCalled, 0);

            const readyResponse = await fetch(`${baseUrl}/ready`);
            const readyPayload = await readyResponse.json();
            assert.equal(readyResponse.status, 200);
            assert.equal(readyPayload.ready, true);
            assert.equal(readinessCalled, 1);

            global.__APP_SHUTTING_DOWN = true;
            const stoppingHealthResponse = await fetch(`${baseUrl}/health`);
            const stoppingHealthPayload = await stoppingHealthResponse.json();
            assert.equal(stoppingHealthResponse.status, 503);
            assert.equal(stoppingHealthPayload.healthy, false);
            assert.equal(stoppingHealthPayload.status, "stopping");

            const stoppingReadyResponse = await fetch(`${baseUrl}/ready`);
            const stoppingReadyPayload = await stoppingReadyResponse.json();
            assert.equal(stoppingReadyResponse.status, 503);
            assert.equal(stoppingReadyPayload.ready, false);
            assert.equal(stoppingReadyPayload.status, "stopping");
            assert.equal(stoppingReadyPayload.release.commitSha, sha);
            assert.equal(readinessCalled, 1);
        });
    } finally {
        if (previousShutdown === undefined) delete global.__APP_SHUTTING_DOWN;
        else global.__APP_SHUTTING_DOWN = previousShutdown;
        restoreEnv(env);
    }
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

test("health and stopping readiness payloads expose exact release identity", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const release = { commitSha: "a".repeat(40), provider: "test", preview: true };
    const health = buildHealthPayload({ shuttingDown: false, release, timestamp: 10, uptimeSec: 20 });
    const stopping = buildStoppingReadinessPayload({ release });

    assert.equal(health.healthy, true);
    assert.equal(health.timestamp, 10);
    assert.equal(health.uptimeSec, 20);
    assert.equal(health.release, release);
    assert.equal(stopping.ready, false);
    assert.equal(stopping.release, release);
});
