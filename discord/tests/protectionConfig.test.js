"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const sessionManager = require("../sessionManager");
const protection = require("../features/protection");

test("protection config clamps numeric values, validates actions, and normalizes domains", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const normalized = protection.normalizeProtectionConfig({
        actionMode: "unknown",
        antiRaid: {
            enabled: "yes",
            spamThreshold: -10,
            spamWindowMs: "Infinity",
            timeoutMinutes: 999999,
            blockNewAccounts: true,
            newAccountDays: 0
        },
        antiSpam: {
            enabled: true,
            maxMessages: "3",
            windowMs: 100,
            action: "delete_everything"
        },
        linkFilter: {
            enabled: true,
            allowedDomains: [" Example.COM. ", "example.com", "https://bad.example/path", "localhost"]
        }
    });

    assert.equal(normalized.actionMode, "audit_only");
    assert.equal(normalized.antiRaid.enabled, true);
    assert.equal(normalized.antiRaid.spamThreshold, 2);
    assert.equal(normalized.antiRaid.spamWindowMs, 60000);
    assert.equal(normalized.antiRaid.timeoutMinutes, 40320);
    assert.equal(normalized.antiRaid.newAccountDays, 1);
    assert.equal(normalized.antiSpam.maxMessages, 3);
    assert.equal(normalized.antiSpam.windowMs, 500);
    assert.equal(normalized.antiSpam.action, "timeout");
    assert.deepEqual(normalized.linkFilter.allowedDomains, ["example.com"]);
});

test("protection config ignores prototype-pollution keys", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"antiSpam":{"enabled":true}}');
    const normalized = protection.normalizeProtectionConfig(payload);
    assert.equal(normalized.antiSpam.enabled, true);
    assert.equal({}.polluted, undefined);
});

test("protection config reports database persistence failures instead of returning success", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalGetSetting = sessionManager.getSetting;
    const originalSetSetting = sessionManager.setSetting;
    sessionManager.getSetting = async () => null;
    sessionManager.setSetting = async () => false;
    try {
        await assert.rejects(
            protection.setProtectionConfig("111111111111111111", { antiSpam: { enabled: true } }),
            error => error?.code === "PROTECTION_PERSISTENCE_FAILED"
        );
    } finally {
        sessionManager.getSetting = originalGetSetting;
        sessionManager.setSetting = originalSetSetting;
    }
});

test("protection config returns the exact normalized value that was persisted", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalGetSetting = sessionManager.getSetting;
    const originalSetSetting = sessionManager.setSetting;
    let persisted = null;
    sessionManager.getSetting = async () => null;
    sessionManager.setSetting = async (_key, value) => {
        persisted = value;
        return true;
    };
    try {
        const result = await protection.setProtectionConfig("111111111111111111", {
            actionMode: "enforce",
            antiSpam: { enabled: true, action: "ban", maxMessages: 9 },
            linkFilter: { allowedDomains: ["shop.example.com"] }
        });
        assert.deepEqual(result, persisted);
        assert.equal(result.actionMode, "enforce");
        assert.equal(result.antiSpam.action, "ban");
        assert.equal(result.antiSpam.maxMessages, 9);
        assert.deepEqual(result.linkFilter.allowedDomains, ["shop.example.com"]);
    } finally {
        sessionManager.getSetting = originalGetSetting;
        sessionManager.setSetting = originalSetSetting;
    }
});