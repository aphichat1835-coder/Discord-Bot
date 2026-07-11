"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    resolvePublicBaseUrl,
    assertConsistentPublicOrigins
} = require("../core/publicUrl");

test("public URL resolver uses one canonical alias order", () => {
    const env = {
        PUBLIC_BASE_URL: "https://canonical.example/",
        PUBLIC_DASHBOARD_URL: "https://legacy.example"
    };
    assert.equal(resolvePublicBaseUrl(env), "https://canonical.example");
});

test("public URL aliases accept the same normalized base URL", () => {
    const env = {
        PUBLIC_BASE_URL: "https://example.test/",
        DASHBOARD_URL: "https://example.test"
    };
    assert.equal(assertConsistentPublicOrigins(env), "https://example.test");
});

test("public URL aliases reject different production origins", () => {
    assert.throws(() => assertConsistentPublicOrigins({
        PUBLIC_BASE_URL: "https://one.example",
        PUBLIC_DASHBOARD_URL: "https://two.example"
    }), error => error?.code === "public_url_alias_mismatch");
});
