const assert = require("node:assert/strict");
const test = require("node:test");

const { createViewHelpers } = require("../index/viewHelpers");

test("dashboard nav does not expose removed enterprise audit routes", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { navBar } = createViewHelpers("");
    const html = navBar("/");
    assert.doesNotMatch(html, /\/audit-logs/);
    assert.doesNotMatch(html, /Enterprise Audit/);
});
