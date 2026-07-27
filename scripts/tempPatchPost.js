#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function replaceOnce(file, search, replacement) {
    const absolute = path.join(root, file);
    const source = fs.readFileSync(absolute, "utf8");
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`POST_PATCH_SOURCE_NOT_FOUND:${file}`);
    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`POST_PATCH_SOURCE_NOT_UNIQUE:${file}`);
    fs.writeFileSync(absolute, source.slice(0, first) + replacement + source.slice(first + search.length));
}

replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`        try {
            await refreshOneOAuthUser(doc, {`,
`        try {
            const result = await refreshOneOAuthUser(doc, {`
);

replaceOnce(
    "verification-tests/unifiedRuntime.test.js",
`function readIndexServer() {
    return fs.readFileSync("discord/index/server.js", "utf8");
}

function readIndexSystem() {`,
`function readIndexServer() {
    return fs.readFileSync("discord/index/server.js", "utf8");
}

function readCoreHttp() {
    return fs.readFileSync("discord/core/http.js", "utf8");
}

function readIndexSystem() {`
);

replaceOnce(
    "verification-tests/unifiedRuntime.test.js",
`    test("keeps ping as liveness and exposes combined readiness on health and ready", () => {
        const server = readIndexServer();
        expect(server).toContain("dbConnected");
        expect(server).toContain("botOnline");
        expect(server).toContain("voiceReady");
        expect(server).toContain("verificationReady");
        expect(server).toContain('app.get("/ping", (req, res) => res.status(200).send("OK"))');
        expect(server).toContain('app.get("/health", sendReadiness)');
        expect(server).toContain('app.get("/ready", sendReadiness)');
        expect(server).toContain("voice?.ready === true");
        expect(server).not.toContain("sendLiveness");
        expect(server).not.toContain("alive: true");
    });`,
`    test("keeps ping as transport liveness, core health as process liveness, and ready as dependency readiness", () => {
        const server = readIndexServer();
        const coreHttp = readCoreHttp();
        expect(server).toContain("dbConnected");
        expect(server).toContain("botOnline");
        expect(server).toContain("voiceReady");
        expect(server).toContain("verificationReady");
        expect(server).toContain('app.get("/ping", (req, res) => res.status(200).send("OK"))');
        expect(server).not.toContain('app.get("/health", sendReadiness)');
        expect(server).toContain('app.get("/ready", sendReadiness)');
        expect(coreHttp).toContain('app.get("/health", (_req, res) => {');
        expect(coreHttp).toContain("getReleaseIdentity");
        expect(server).toContain("voice?.ready === true");
        expect(server).not.toContain("sendLiveness");
        expect(server).not.toContain("alive: true");
    });`
);

console.log("[TEMP-PATCH] post-patch invariants applied");
