const assert = require("node:assert/strict");
const test = require("node:test");

const {
    revealTokenAttempts,
    shouldBypassDashboardReadApi,
    createRateLimiter,
    makeCheckAuth,
    makeCheckRevealPin,
    cleanupRevealAttempts
} = require("../guards/dashboardGuards");

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

test("dashboard read API bypass matches safe GET routes only", () => {
    assert.equal(shouldBypassDashboardReadApi({ method: "GET", baseUrl: "/api", path: "/status" }), true);
    assert.equal(shouldBypassDashboardReadApi({ method: "GET", baseUrl: "/api", path: "/session/vc_1" }), true);
    assert.equal(shouldBypassDashboardReadApi({ method: "POST", baseUrl: "/api", path: "/status" }), false);
});

test("rate limiter blocks after configured request count", () => {
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

test("checkAuth accepts exact secret and rejects mismatches", () => {
    const checkAuth = makeCheckAuth("secret");

    const goodRes = createRes();
    const badRes = createRes();

    assert.equal(checkAuth({ ip: "1.1.1.1", path: "/api", headers: { authorization: "secret" } }, goodRes), true);
    assert.equal(checkAuth({ ip: "1.1.1.1", path: "/api", headers: { authorization: "wrong" } }, badRes), false);
    assert.equal(badRes.statusCode, 401);
});

test("reveal PIN guard locks after repeated failures and can clean expired attempts", () => {
    revealTokenAttempts.clear();

    const checkPin = makeCheckRevealPin(() => "1234");
    const req = { ip: "2.2.2.2", path: "/api/reveal-token", body: { pin: "bad" } };

    for (let i = 0; i < 5; i++) {
        checkPin(req, createRes());
    }

    const lockedRes = createRes();
    assert.equal(checkPin(req, lockedRes), null);
    assert.equal(lockedRes.statusCode, 429);

    const rec = revealTokenAttempts.get("2.2.2.2");
    rec.lockedUntil = Date.now() - 1;
    cleanupRevealAttempts();
    assert.equal(revealTokenAttempts.has("2.2.2.2"), false);

    const goodRes = createRes();
    assert.equal(checkPin({ ip: "2.2.2.2", path: "/api/reveal-token", body: { pin: "1234" } }, goodRes), true);
});
