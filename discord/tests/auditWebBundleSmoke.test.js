const assert = require("node:assert/strict");
const test = require("node:test");

const bundle = require("../index/auditWebBundle");

test("audit web bundle exports registration function", () => {
    assert.equal(typeof bundle.registerAuditWebBundle, "function");
});

test("audit web bundle reports successful registration", () => {
    const paths = [];
    const app = { get: path => paths.push(path), post: path => paths.push(path) };
    const ok = bundle.registerAuditWebBundle({
        app,
        express: { json: () => (req, res, next) => next?.() },
        sessionManager: {},
        client: { guilds: { cache: new Map() } },
        auditLogger: {},
        checkAuth: () => true
    });
    assert.equal(ok, true);
    assert.ok(paths.includes("/audit-logs"));
    assert.ok(paths.includes("/api/audit/logs"));
    assert.ok(paths.includes("/api/audit/dead-letters"));
});
