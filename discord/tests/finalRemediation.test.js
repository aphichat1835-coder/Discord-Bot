"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const actions = require("../systemProvider/actions");
const pinCredential = require("../systemProvider/pinCredential");
const portalAuth = require("../systemProvider/auth");
const { createShutdownCoordinator } = require("../core/runtimeLifecycle");
const protection = require("../features/protection");
const secretGuard = require("../../scripts/checkSecretLeaks");
const protectedGuard = require("../../scripts/checkProtectedPaths");

function actionContext() {
    return {
        ownerId: "111111111111111111",
        actorId: "111111111111111111",
        actorCapability: "owner_only",
        systemToggles: {},
        globalAdminCache: new Set(),
        armedGuilds: new Map(),
        protectedSessions: new Set(),
        safeDiscordId: String,
        auditOwnerAction: async () => true
    };
}

test("PIN credentials never contain plaintext and verify with scrypt", () => { // NOSONAR
    const credential = pinCredential.createPinCredential("very-private-owner-pin", { salt: Buffer.alloc(16, 7) });
    assert.equal(credential.includes("very-private-owner-pin"), false);
    assert.equal(pinCredential.isPinCredential(credential), true);
    assert.equal(pinCredential.verifyPinCredential("very-private-owner-pin", credential), true);
    assert.equal(pinCredential.verifyPinCredential("wrong-pin", credential), false);
    assert.equal(portalAuth.timingSafePinEqual("very-private-owner-pin", credential), true);
});

test("protected action allowlist rejects inherited object properties", async () => { // NOSONAR
    for (const action of ["constructor", "toString", "valueOf", "__proto__", "prototype"]) {
        const result = await actions.applyShadowPortalAction({ action }, actionContext());
        assert.equal(result.ok, false);
        assert.equal(result.code, "invalid_action");
    }
});

test("portal session uses a session-bound double-submit CSRF token", () => { // NOSONAR
    const cookies = new Map();
    const res = { cookie(name, value) { cookies.set(name, value); } };
    const options = {
        cookieName: "__shadow_console",
        ttlMs: 60_000,
        getCookieSecret: () => "x".repeat(64),
        getSessionVersion: () => 1
    };
    assert.equal(portalAuth.issueShadowSessionCookie(res, options), true);
    const session = cookies.get("__shadow_console");
    const csrf = cookies.get("__shadow_console_csrf");
    const req = {
        headers: {
            cookie: `__shadow_console=${encodeURIComponent(session)}; __shadow_console_csrf=${encodeURIComponent(csrf)}`,
            "x-csrf-token": csrf
        }
    };
    assert.equal(portalAuth.verifyShadowCsrf(req, options), true);
    req.headers["x-csrf-token"] = "wrong";
    assert.equal(portalAuth.verifyShadowCsrf(req, options), false);
});

test("fatal shutdown request escalates an in-progress graceful exit", async () => { // NOSONAR
    let release;
    const blocker = new Promise(resolve => { release = resolve; });
    const exits = [];
    const shutdown = createShutdownCoordinator({
        dmService: { stop: () => blocker },
        processRef: { exit: code => exits.push(code) },
        setTimer: () => ({ unref() {} }),
        clearTimer() {},
        logger: { log() {}, warn() {}, error() {} },
        getServer: () => null
    });
    const first = shutdown("SIGTERM", 0);
    const second = shutdown("FATAL_uncaughtException", 1);
    assert.equal(first, second);
    release();
    const result = await first;
    assert.equal(result.exitCode, 1);
    assert.deepEqual(exits, [1]);
});

test("protection configuration is bounded and domain-normalized", () => { // NOSONAR
    const normalized = protection.normalizeProtectionConfig({
        antiRaid: { spamThreshold: "", spamWindowMs: -1 },
        antiSpam: { action: "constructor", maxMessages: 1000 },
        linkFilter: { allowedDomains: ["Example.COM", "https://bad.example/path", "example.com"] }
    });
    assert.equal(normalized.antiRaid.spamThreshold, 5);
    assert.equal(normalized.antiRaid.spamWindowMs, 1000);
    assert.equal(normalized.antiSpam.action, "timeout");
    assert.equal(normalized.antiSpam.maxMessages, 100);
    assert.deepEqual(normalized.linkFilter.allowedDomains, ["example.com"]);
});

test("secret scanner stays bounded on adversarial long assignments", () => { // NOSONAR
    const source = `password="${"a".repeat(750_000)}"`;
    const started = Date.now();
    const findings = secretGuard.analyzeText(source, "fixture.js");
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(findings, []);
});

test("protected approval lookup follows pagination", async () => { // NOSONAR
    const originalFetch = global.fetch;
    const headSha = "a".repeat(40);
    let calls = 0;
    try {
        global.fetch = async url => {
            calls++;
            const page = new URL(url).searchParams.get("page");
            return {
                ok: true,
                async json() {
                    if (page === "1") {
                        return Array.from({ length: 100 }, (_, index) => ({
                            user: { login: "someone" },
                            body: `comment-${index}`
                        }));
                    }
                    return [{
                        user: { login: "repo-owner" },
                        body: `<!-- protected-owner-approval:${headSha} -->`
                    }];
                }
            };
        };
        assert.equal(await protectedGuard.fetchOwnerApproval({
            repository: "repo-owner/project",
            owner: "repo-owner",
            pullNumber: 71,
            headSha,
            token: "token"
        }), true);
        assert.equal(calls, 2);
    } finally {
        global.fetch = originalFetch;
    }
});
