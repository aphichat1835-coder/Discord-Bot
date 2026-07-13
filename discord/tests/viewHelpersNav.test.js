const assert = require("node:assert/strict");
const test = require("node:test");

const { createViewHelpers } = require("../index/viewHelpers");

test("dashboard nav does not expose removed enterprise audit routes", () => {
    const { navBar } = createViewHelpers("");
    const html = navBar("/");
    assert.doesNotMatch(html, /\/audit-logs/);
    assert.doesNotMatch(html, /Enterprise Audit/);
});
