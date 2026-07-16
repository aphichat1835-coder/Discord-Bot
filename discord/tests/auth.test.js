const assert = require("node:assert/strict");
const test = require("node:test");

const auth = require("../index/auth");

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

test("dashboard auth has no fallback secret", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldSecret = process.env.API_SECRET;
    delete process.env.API_SECRET;

    assert.throws(() => auth.makeToken(), /API_SECRET is required/);
    assert.equal(auth.verifyToken("123.fake"), false);

    restoreEnv("API_SECRET", oldSecret);
});

test("production check trims NODE_ENV", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = " production ";
    assert.equal(auth.isProduction(), true);

    process.env.NODE_ENV = "development";
    assert.equal(auth.isProduction(), false);

    restoreEnv("NODE_ENV", oldEnv);
});

test("parseCookies skips malformed cookie encoding without throwing", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const req = {
        headers: {
            cookie: "good=value; broken=%E0%A4%A; another=ok"
        }
    };

    assert.deepEqual(auth.parseCookies(req), {
        good: "value",
        another: "ok"
    });
});

test("pin page escapes hidden next attribute", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const html = auth.pinPageHTML(false, "/ok?x=\"&y=<tag>'");
    assert.match(html, /value="\/ok\?x=&quot;&amp;y=&lt;tag&gt;&#39;"/);
    assert.match(html, /autocomplete="current-password"/);
    assert.match(auth.pinPageHTML(true, "/"), /role="alert"/);
    assert.match(html, /prefers-reduced-motion/);
});

test("csrf token is bound to a valid dashboard session token", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldSecret = process.env.API_SECRET;
    process.env.API_SECRET = "csrf-test-secret";

    const token = auth.makeToken();
    const csrf = auth.makeCsrfToken(token);

    assert.equal(auth.verifyCsrfToken(token, csrf), true);
    assert.equal(auth.verifyCsrfToken(token, "bad"), false);
    assert.equal(auth.verifyCsrfToken("bad.session", csrf), false);

    restoreEnv("API_SECRET", oldSecret);
});

test("dashboard auth session duration is configurable and bounded", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const oldMaxAge = process.env.DASHBOARD_SESSION_MAX_AGE_MS;
    const oldRefresh = process.env.DASHBOARD_SESSION_REFRESH_AFTER_MS;

    process.env.DASHBOARD_SESSION_MAX_AGE_MS = String(2 * 60 * 60 * 1000);
    process.env.DASHBOARD_SESSION_REFRESH_AFTER_MS = String(10 * 60 * 1000);

    assert.equal(auth.getSessionMaxAgeMs(), 2 * 60 * 60 * 1000);
    assert.equal(auth.getSessionRefreshAfterMs(), 10 * 60 * 1000);

    process.env.DASHBOARD_SESSION_MAX_AGE_MS = "1";
    assert.equal(auth.getSessionMaxAgeMs(), 5 * 60 * 1000);

    restoreEnv("DASHBOARD_SESSION_MAX_AGE_MS", oldMaxAge);
    restoreEnv("DASHBOARD_SESSION_REFRESH_AFTER_MS", oldRefresh);
});

test("dashboard auth can identify sessions that need rolling refresh", () => {
    const oldSecret = process.env.API_SECRET;
    const oldMaxAge = process.env.DASHBOARD_SESSION_MAX_AGE_MS;
    const oldRefresh = process.env.DASHBOARD_SESSION_REFRESH_AFTER_MS;
    process.env.API_SECRET = "refresh-test-secret";
    process.env.DASHBOARD_SESSION_MAX_AGE_MS = String(60 * 60 * 1000);
    process.env.DASHBOARD_SESSION_REFRESH_AFTER_MS = String(5 * 60 * 1000);

    const issuedAt = String(Date.now() - 10 * 60 * 1000);
    const sig = require("node:crypto")
        .createHmac("sha256", process.env.API_SECRET)
        .update(issuedAt)
        .digest("hex")
        .slice(0, 40);

    assert.equal(auth.shouldRefreshToken(`${issuedAt}.${sig}`), true);

    restoreEnv("API_SECRET", oldSecret);
    restoreEnv("DASHBOARD_SESSION_MAX_AGE_MS", oldMaxAge);
    restoreEnv("DASHBOARD_SESSION_REFRESH_AFTER_MS", oldRefresh);
});
