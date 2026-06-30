const assert = require("node:assert/strict");
const test = require("node:test");

const { escapeHtml, buildAuditDashboardPage } = require("../index/auditDashboardPage");

test("audit dashboard escapes page title", () => {
    assert.equal(escapeHtml("<Audit & Logs>"), "&lt;Audit &amp; Logs&gt;");
});

test("audit dashboard includes CSRF header support for settings POST", () => {
    const html = buildAuditDashboardPage();
    assert.match(html, /__da_csrf/);
    assert.match(html, /x-csrf-token/);
    assert.match(html, /\/api\/audit\/settings/);
});
