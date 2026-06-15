const assert = require("node:assert/strict");
const test = require("node:test");

const auth = require("../index/auth");

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

test("dashboard auth has no fallback secret", () => {
    const oldSecret = process.env.API_SECRET;
    delete process.env.API_SECRET;

    assert.throws(() => auth.makeToken(), /API_SECRET is required/);
    assert.equal(auth.verifyToken("123.fake"), false);

    restoreEnv("API_SECRET", oldSecret);
});

test("production check trims NODE_ENV", () => {
    const oldEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = " production ";
    assert.equal(auth.isProduction(), true);

    process.env.NODE_ENV = "development";
    assert.equal(auth.isProduction(), false);

    restoreEnv("NODE_ENV", oldEnv);
});

test("parseCookies skips malformed cookie encoding without throwing", () => {
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

test("pin page escapes hidden next attribute", () => {
    const html = auth.pinPageHTML(false, "/ok?x=\"&y=<tag>'");
    assert.match(html, /value="\/ok\?x=&quot;&amp;y=&lt;tag&gt;&#39;"/);
});

test("csrf token is bound to a valid dashboard session token", () => {
    const oldSecret = process.env.API_SECRET;
    process.env.API_SECRET = "csrf-test-secret";

    const token = auth.makeToken();
    const csrf = auth.makeCsrfToken(token);

    assert.equal(auth.verifyCsrfToken(token, csrf), true);
    assert.equal(auth.verifyCsrfToken(token, "bad"), false);
    assert.equal(auth.verifyCsrfToken("bad.session", csrf), false);

    restoreEnv("API_SECRET", oldSecret);
});
