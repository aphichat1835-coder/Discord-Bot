const assert = require("node:assert/strict");
const test = require("node:test");

const { createViewHelpers } = require("../index/viewHelpers");

test("dashboard nav includes audit logs link", () => {
    const { navBar } = createViewHelpers("");
    const html = navBar("/audit-logs");
    assert.match(html, /\/audit-logs/);
    assert.match(html, /Audit/);
    assert.match(html, /class="active"/);
});
