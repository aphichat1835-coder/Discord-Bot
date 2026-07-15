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
        cookie(name, value, options) {
            this.cookies.push({ name, value, options });
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

function createAuth() {
    return createShadowPortalAuth({
        cookieName: "shadow_cookie",
        ttlMs: 60_000,
        getPin: () => "2468",
        getCookieSecret: () => "unit-secret",
        shadowCss: ".login-wrap{}"
    });
}

test("shadow portal auth accepts the configured PIN and issues a session cookie", () => {
    const auth = createAuth();
    const req = { ip: "127.0.0.1", headers: {} };
    const res = createResponse();

    assert.equal(auth.authorize(req, res, { pin: "2468" }, "2468"), true);
    assert.equal(res.cookies.length, 1);
    assert.equal(res.cookies[0].name, "shadow_cookie");
    assert.equal(res.cookies[0].options.httpOnly, true);
    assert.equal(verifyShadowSessionToken(res.cookies[0].value, {
        ttlMs: 60_000,
        getCookieSecret: () => "unit-secret"
    }), true);
});

test("shadow portal auth accepts a valid cookie session without a PIN", () => {
    const auth = createAuth();
    const token = createShadowSessionToken({ ttlMs: 60_000, getCookieSecret: () => "unit-secret" });
    const req = { ip: "127.0.0.1", headers: { cookie: `shadow_cookie=${encodeURIComponent(token)}` } };
    const res = createResponse();

    assert.equal(auth.authorize(req, res, {}, undefined), true);
    assert.equal(res.sent, "");
});

test("shadow portal auth locks repeated invalid PIN attempts", () => {
    const auth = createAuth();
    const req = { ip: "10.0.0.5", headers: {} };

    for (let i = 0; i < 5; i++) {
        const res = createResponse();
        assert.equal(auth.authorize(req, res, { pin: "bad" }, "bad"), false);
    }

    const blocked = createResponse();
    assert.equal(auth.authorize(req, blocked, { pin: "bad" }, "bad"), false);
    assert.equal(blocked.statusCode, 429);
    assert.match(blocked.sent, /Blocked|ล็อก/);
});

test("shadow portal renderers escape dynamic guild, metric, and dashboard values", () => {
    const context = {
        SECRET_PHRASE: "<secret>",
        systemToggles: { feature: true },
        traceGuildPolicies: new Map([["12345", "<policy>"]]),
        traceMetrics: { unsafe: "<metric>" },
        normalizeTracePolicy: value => String(value),
        armedGuilds: new Set(["12345"]),
        globalAdminCache: new Set(["67890"]),
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
        guilds: { cache: new Map([["12345", { id: "12345", name: "<guild>", memberCount: "<7>" }]]) },
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
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tabpanel"/);
    assert.match(html, /href="#shadow-main"/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /aria-label="คัดลอกลิงก์ Portal"|title="คัดลอกลิงก์ Portal"/);
    assert.doesNotMatch(html, /CSS\.escape/);
});
