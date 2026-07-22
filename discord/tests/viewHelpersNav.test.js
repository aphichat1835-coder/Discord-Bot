const assert = require("node:assert/strict");
const test = require("node:test");

const { createViewHelpers } = require("../index/viewHelpers");
const { BASE_CSS } = require("../index/viewStyles");

test("dashboard nav does not expose removed enterprise audit routes", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { navBar } = createViewHelpers("");
    const html = navBar("/");
    assert.doesNotMatch(html, /\/audit-logs/);
    assert.doesNotMatch(html, /Enterprise Audit/);
});

test("dashboard shell exposes grouped navigation and accessibility helpers", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { navBar, shell } = createViewHelpers(BASE_CSS);
    const nav = navBar("/logs");
    const html = shell("ทดสอบ", "<p>เนื้อหา</p>");

    assert.match(nav, /aria-label="เมนูหลักของ Owner Dashboard"/);
    assert.match(nav, /aria-current="page"/);
    assert.match(nav, /ติดตามและช่วยเหลือ/);
    assert.match(html, /href="#main-content"/);
    assert.match(html, /<main id="main-content"/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /dashboardInterval/);
});
