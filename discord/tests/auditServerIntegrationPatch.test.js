const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("audit server integration patch documents safe mount", () => {
    const doc = fs.readFileSync(path.join(__dirname, "../../docs/AUDIT_SERVER_INTEGRATION_PATCH.md"), "utf8");
    assert.match(doc, /registerAuditWebBundle/);
    assert.match(doc, /\/api\/audit\/dead-letters/);
    assert.match(doc, /Do not remove `rateLimiter`/);
    assert.match(doc, /Do not touch reveal-token routes/);
});
