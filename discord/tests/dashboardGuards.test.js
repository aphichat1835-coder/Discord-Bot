const assert = require("node:assert/strict");
const test = require("node:test");

const {
    revealTokenAttempts,
    shouldBypassDashboardReadApi,
    createRateLimiter,
    makeCheckAuth,
    makeCheckRevealPin,
    safeSecretEqual,
    cleanupRevealAttempts,
    getRevealAttemptStats,
    getRateLimitStats,
    trimRateLimitBuckets,
    safeDiscordInlineCode,
    safeDiscordSummaryText,
    getRequestPath
} = require("../guards/dashboardGuards");
const dashboardAuth = require("../index/auth");
const TEST_CLIENT_A = "test-client-a";
const TEST_CLIENT_B = "test-client-b";

function createRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

test("sensitive secret comparison is constant-time and type-strict", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(safeSecretEqual("1234", "1234"), true);
    assert.equal(safeSecretEqual("1235", "1234"), false);
    assert.equal(safeSecretEqual("12345", "1234"), false);
    assert.equal(safeSecretEqual(1234, "1234"), false);
    assert.equal(safeSecretEqual(null, "1234"), false);
});

test("dashboard intrusion text cannot break Discord formatting", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const inline = safeDiscordInlineCode("/path`\n@everyone", 180);
    assert.equal(inline.includes("`"), false);
    assert.equal(inline.includes("\n"), false);
    const summary = safeDiscordSummaryText("**bold**\n> mention", 180);
    assert.match(summary, /\\\*\\\*bold/);
    assert.equal(summary.includes("\n"), false);
});

test("dashboard security logs keep the mounted API path and omit query data", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(getRequestPath({ originalUrl: "/api/graphql?token=secret", baseUrl: "/api", path: "/graphql" }), "/api/graphql");
    assert.equal(getRequestPath({ baseUrl: "/api", path: "/gql" }), "/api/gql");
});

test("dashboard read APIs do not bypass owner auth", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(shouldBypassDashboardReadApi({ method: "GET", baseUrl: "/api", path: "/status" }), false);
    assert.equal(shouldBypassDashboardReadApi({ method: "GET", baseUrl: "/api", path: "/session/vc_1" }), false);
    assert.equal(shouldBypassDashboardReadApi({ method: "POST", baseUrl: "/api", path: "/status" }), false);
});

test("rate limiter blocks after configured request count", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const counts = new Map();
    const limiter = createRateLimiter(counts, {
        limits: {
            rateLimitWindowMs: 60000,
            rateLimitRequests: 1
        }
    });

    const req = { ip: "127.0.0.1", path: "/write" };
    const first = createRes();
    const second = createRes();
    let nextCalled = 0;

    limiter(req, first, () => { nextCalled++; });
    limiter(req, second, () => { nextCalled++; });

    assert.equal(nextCalled, 1);
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.error, "Too Many Requests");
});

test("rate limiter buckets expire stale entries and stay capped", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const counts = new Map();
    const staleAt = Date.now() - 120000;

    counts.set("stale-client", [staleAt]);
    trimRateLimitBuckets(counts, Date.now(), 60000);
    assert.equal(counts.has("stale-client"), false);

    const maxBuckets = getRateLimitStats(counts).maxBuckets;
    for (let i = 0; i < maxBuckets + 5; i++) {
        counts.set(`client-${i}`, [Date.now()]);
    }

    trimRateLimitBuckets(counts, Date.now(), 60000);
    assert.ok(counts.size <= maxBuckets);
    assert.equal(getRateLimitStats(counts).buckets, counts.size);
});

test("checkAuth accepts exact secret and rejects mismatches", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldPin = process.env.DASHBOARD_PIN;
    const oldSecret = process.env.API_SECRET;
    process.env.DASHBOARD_PIN = "1234";
    process.env.API_SECRET = "cookie-secret";

    const checkAuth = makeCheckAuth("secret");

    const goodRes = createRes();
    const badRes = createRes();
    const cookieRes = createRes();
    const token = dashboardAuth.makeToken();

    const secretRequest = { ip: TEST_CLIENT_A, path: "/api", headers: { authorization: "secret" } };
    const rejectedRequest = { ip: TEST_CLIENT_A, path: "/api", headers: { authorization: "wrong" } };
    const cookieRequest = {
        ip: TEST_CLIENT_A,
        path: "/api",
        headers: { cookie: `${dashboardAuth.COOKIE_NAME}=${encodeURIComponent(token)}` }
    };

    assert.equal(checkAuth(secretRequest, goodRes), true);
    assert.equal(secretRequest.authenticatedByServerSecret, true);
    assert.equal(checkAuth(rejectedRequest, badRes), false);
    assert.equal(rejectedRequest.authenticatedByServerSecret, false);
    assert.equal(checkAuth(cookieRequest, cookieRes), true);
    assert.equal(cookieRequest.authenticatedByServerSecret, false);
    assert.equal(badRes.statusCode, 401);

    if (oldPin === undefined) delete process.env.DASHBOARD_PIN;
    else process.env.DASHBOARD_PIN = oldPin;
    if (oldSecret === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = oldSecret;
});

test("checkAuth fails closed when API_SECRET is not configured", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldPin = process.env.DASHBOARD_PIN;
    process.env.DASHBOARD_PIN = "1234";

    const checkAuth = makeCheckAuth("");
    const res = createRes();

    assert.equal(checkAuth({ ip: TEST_CLIENT_A, path: "/api", headers: {} }, res), false);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);

    if (oldPin === undefined) delete process.env.DASHBOARD_PIN;
    else process.env.DASHBOARD_PIN = oldPin;
});

test("reveal PIN guard locks after repeated failures and can clean expired attempts", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    revealTokenAttempts.clear();

    const checkPin = makeCheckRevealPin(() => "1234");
    const req = { ip: TEST_CLIENT_B, path: "/api/reveal-token", body: { pin: "bad" } };

    for (let i = 0; i < 5; i++) {
        checkPin(req, createRes());
    }

    const lockedRes = createRes();
    assert.equal(checkPin(req, lockedRes), null);
    assert.equal(lockedRes.statusCode, 429);

    const rec = revealTokenAttempts.get(TEST_CLIENT_B);
    rec.lockedUntil = Date.now() - 1;
    cleanupRevealAttempts();
    assert.equal(revealTokenAttempts.has(TEST_CLIENT_B), false);

    const goodRes = createRes();
    assert.equal(checkPin({ ip: TEST_CLIENT_B, path: "/api/reveal-token", body: { pin: "1234" } }, goodRes), true);
});

test("reveal PIN attempts expire stale unlocked records and stay capped", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    revealTokenAttempts.clear();

    const staleAt = Date.now() - 31 * 60 * 1000;
    revealTokenAttempts.set("stale-ip", {
        count: 1,
        lockedUntil: 0,
        updatedAt: staleAt
    });

    cleanupRevealAttempts();
    assert.equal(revealTokenAttempts.has("stale-ip"), false);

    for (let i = 0; i < 1005; i++) {
        revealTokenAttempts.set(`ip-${i}`, {
            count: 1,
            lockedUntil: 0,
            updatedAt: Date.now()
        });
    }

    cleanupRevealAttempts();
    assert.ok(revealTokenAttempts.size <= getRevealAttemptStats().maxKeys);
    assert.equal(getRevealAttemptStats().tracked, revealTokenAttempts.size);

    revealTokenAttempts.clear();
});
