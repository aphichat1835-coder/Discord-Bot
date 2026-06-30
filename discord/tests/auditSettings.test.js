const assert = require("node:assert/strict");
const test = require("node:test");

const settings = require("../logging/auditSettings");

test("audit settings normalizes booleans and limits", () => {
    const normalized = settings.normalizeAuditSettings({
        messageCreateEnabled: "true",
        reconcilerEnabled: "false",
        reconcilerIntervalMs: 100,
        reconcilerLimit: 999,
        categories: { message: "false" }
    });
    assert.equal(normalized.messageCreateEnabled, true);
    assert.equal(normalized.reconcilerEnabled, false);
    assert.equal(normalized.reconcilerIntervalMs, 60000);
    assert.equal(normalized.reconcilerLimit, 50);
    assert.equal(normalized.categories.message, false);
});

test("audit settings treats string zero retention as forever", () => {
    assert.equal(settings.normalizeAuditSettings({ retentionDays: "0" }).retentionDays, 0);
});

test("audit settings key and category helper", () => {
    assert.equal(settings.settingKey("guild1"), "audit_settings_guild1");
    assert.equal(settings.categoryEnabled({ categories: { server: false } }, "server"), false);
    assert.equal(settings.categoryEnabled({}, "message"), true);
});
