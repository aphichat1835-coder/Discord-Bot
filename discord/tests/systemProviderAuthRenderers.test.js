const assert = require("node:assert/strict");
const test = require("node:test");

const {
    createShadowPortalAuth,
    createShadowSessionToken,
    verifyShadowSessionToken
} = require("../systemProvider/auth");
const { buildShadowPortalViewData } = require("../systemProvider/renderers");
const { renderShadowDashboardPage } = require("../systemProvider/dashboardHtml");

function createResponse() {
    return {
        statusCode: 200,
        sent: "",
        cookies: [],
        headers: {},
        cookie(name, value, options) {
            this.cookies.push({ name, value, options });
        },
        clearCookie(name, options) {
            this.cookies.push({ name, value: "", options: { ...options, cleared: true } });
        },
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = String(value);
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(html) {
            this.sent = html;
            return this;
        }
    };
}

function createAuth(overrides = {}) {
    return createShadowPortalAuth({
        cookieName: "shadow_cookie",
        ttlMs: 60_000,
        getPin: () => "protected-pin-2468",
        getCookieSecret: () => "unit-secret-that-is-long-enough",
        getSessionVersion: () => 1,
        shadowCss: ".login-wrap{}",
        ...overrides
    });
}

test("protected portal auth accepts configured PIN and issues a strict versioned session cookie", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const auth = createAuth();
    const req = { ip: "127.0.0.1", headers: {} };
    const res = createResponse();

    assert.equal(auth.authorize(req, res, {}, "protected-pin-2468"), true);
    assert.equal(res.cookies.length, 1);
    assert.equal(res.cookies[0].name, "shadow_cookie");
    assert.equal(res.cookies[0].options.httpOnly, true);
    assert.equal(res.cookies[0].options.sameSite, "strict");
    assert.equal(res.cookies[0].options.path, "/api/v1/telemetry/snapshot");
    assert.equal(verifyShadowSessionToken(res.cookies[0].value, {
        ttlMs: 60_000,
        getCookieSecret: () => "unit-secret-that-is-long-enough",
        getSessionVersion: () => 1
    }), true);
    assert.equal(res.headers["cache-control"], "no-store, private");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("protected portal fails closed when PIN or signing secret is unavailable", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    for (const auth of [
        createAuth({ getPin: () => "" }),
        createAuth({ getCookieSecret: () => "" })
    ]) {
        const res = createResponse();
        assert.equal(auth.authorize({ ip: "127.0.0.2", headers: {} }, res, {}, "anything"), false);
        assert.equal(res.statusCode, 503);
        assert.equal(res.cookies.length, 0);
        assert.match(res.sent, /ยังไม่พร้อมใช้งาน/);
    }
});

test("main dashboard PIN is not accepted as an automatic protected recovery credential", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldDashboardPin = process.env.DASHBOARD_PIN;
    process.env.DASHBOARD_PIN = "main-dashboard-owner-pin";
    try {
        const auth = createAuth();
        const res = createResponse();
        assert.equal(auth.authorize(
            { ip: "127.0.0.3", headers: {} },
            res,
            {},
            "main-dashboard-owner-pin"
        ), false);
        assert.equal(res.statusCode, 401);
        assert.equal(res.cookies.length, 0);
    } finally {
        if (oldDashboardPin === undefined) delete process.env.DASHBOARD_PIN;
        else process.env.DASHBOARD_PIN = oldDashboardPin;
    }
});

test("break-glass credential is accepted only while explicitly enabled", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let enabled = false;
    const auth = createAuth({
        getRecoveryPin: () => "temporary-break-glass-pin",
        isBreakGlassEnabled: () => enabled
    });

    const denied = createResponse();
    assert.equal(auth.authorize({ ip: "127.0.0.4", headers: {} }, denied, {}, "temporary-break-glass-pin"), false);
    enabled = true;
    const accepted = createResponse();
    assert.equal(auth.authorize({ ip: "127.0.0.4", headers: {} }, accepted, {}, "temporary-break-glass-pin"), true);
});

test("changing the protected session version immediately revokes older cookies", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let version = 1;
    const token = createShadowSessionToken({
        getCookieSecret: () => "unit-secret-that-is-long-enough",
        getSessionVersion: () => version
    });
    const verify = () => verifyShadowSessionToken(token, {
        ttlMs: 60_000,
        getCookieSecret: () => "unit-secret-that-is-long-enough",
        getSessionVersion: () => version
    });
    assert.equal(verify(), true);
    version = 2;
    assert.equal(verify(), false);
});

test("protected portal auth accepts a valid cookie session without another PIN", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const auth = createAuth();
    const token = createShadowSessionToken({
        getCookieSecret: () => "unit-secret-that-is-long-enough",
        getSessionVersion: () => 1
    });
    const req = { ip: "127.0.0.1", headers: { cookie: `shadow_cookie=${encodeURIComponent(token)}` } };
    const res = createResponse();

    assert.equal(auth.authorize(req, res, {}, undefined), true);
    assert.equal(res.sent, "");
});

test("failed PIN attempts are rate-limited and brute-force state remains bounded", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const auth = createAuth({ maxAttempts: 2, maxBruteKeys: 3, bruteTtlMs: 60_000 });

    for (let index = 0; index < 5; index++) {
        const req = { ip: `10.0.0.${index}`, headers: {} };
        auth.authorize(req, createResponse(), {}, "bad-protected-pin");
    }
    assert.ok(auth.bruteGuard.size <= 3);

    const lockedReq = { ip: "192.0.2.10", headers: {} };
    assert.equal(auth.authorize(lockedReq, createResponse(), {}, "bad-one"), false);
    assert.equal(auth.authorize(lockedReq, createResponse(), {}, "bad-two"), false);
    const blocked = createResponse();
    assert.equal(auth.authorize(lockedReq, blocked, {}, "bad-three"), false);
    assert.equal(blocked.statusCode, 429);
});

test("protected portal renderers escape dynamic values without exposing internal command details", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = {
        systemToggles: { feature: true },
        traceGuildPolicies: new Map([["123456789012345678", "<policy>"]]),
        traceMetrics: { unsafe: "<metric>" },
        normalizeTracePolicy: value => String(value),
        armedGuilds: new Map([["123456789012345678", { expiresAt: Date.now() + 60_000 }]]),
        globalAdminCache: new Set(["234567890123456789"]),
        protectedSessions: new Set(["session-1"]),
        sessionManager: {
            getAllSessions() {
                return new Map([["session-1", {
                    sessionId: "session-1<script>",
                    serverName: "<server>",
                    startedAt: Date.now()
                }]]);
            }
        },
        logSuppressedError() {}
    };
    const mainClient = {
        guilds: { cache: new Map([["123456789012345678", {
            id: "123456789012345678",
            name: "<guild>",
            memberCount: "<7>"
        }]]) },
        ws: { ping: 12 },
        user: { tag: "<bot>" }
    };

    const view = buildShadowPortalViewData(mainClient, context);
    const html = renderShadowDashboardPage({ ...view, SHADOW_CSS: ".x{}" }, {
        ghostModeEnabled: false,
        protectedSessionCount: 1,
        armedGuildCount: 1,
        globalAdminCount: 1,
        tracePolicyDefault: "<default>",
        protectedChannelCount: 1,
        traceRateLimitMax: 5,
        traceRateLimitWindowSeconds: 60
    });

    assert.match(html, /&lt;guild&gt;/);
    assert.match(html, /&lt;metric&gt;/);
    assert.match(html, /&lt;default&gt;/);
    assert.doesNotMatch(html, /<guild>/);
    assert.doesNotMatch(html, /<metric>/);
    assert.doesNotMatch(html, /<default>/);
    assert.doesNotMatch(html, /ไม่มีร่องรอย/);
    assert.doesNotMatch(html, /SECRET_PHRASE|trigger phrase|คำสั่งลับ/i);
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tabpanel"/);
    assert.match(html, /prefers-reduced-motion/);
});
