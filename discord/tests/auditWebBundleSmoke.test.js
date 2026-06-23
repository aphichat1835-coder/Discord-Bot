const assert = require("node:assert/strict");
const test = require("node:test");

const bundle = require("../index/auditWebBundle");

test("audit web bundle exports registration function", () => {
    assert.equal(typeof bundle.registerAuditWebBundle, "function");
});
