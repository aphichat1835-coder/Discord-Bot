const assert = require("node:assert/strict");
const test = require("node:test");

const protectionCase = require("../features/protectionCase");

test("buildProtectionEvent normalizes evidence and action results", () => {
    const event = protectionCase.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        channelId: "c1",
        trigger: "Anti-Spam Triggered",
        reason: "sent too many messages",
        messageCount: 7,
        channelCount: 3,
        action: "timeout",
        success: true,
        timeoutMs: 300000,
        dmSent: true
    });

    assert.equal(event.trigger, "Anti-Spam Triggered");
    assert.equal(event.actionResult.action, "timeout");
    assert.equal(event.actionResult.success, true);
    assert.ok(event.evidence.some(item => item.includes("Messages")));
});

test("createActionResult records failed action details without an Audit renderer", () => {
    const result = protectionCase.createActionResult({
        action: "ban",
        attempted: true,
        success: false,
        error: "role hierarchy"
    });

    assert.equal(result.action, "ban");
    assert.equal(result.attempted, true);
    assert.equal(result.success, false);
    assert.equal(result.error, "role hierarchy");
});

test("createProtectionCase skips failed or skipped punitive actions", async () => {
    const sessionManager = {
        async getSetting(_key, fallback) { return fallback; },
        async setSetting() { throw new Error("case should not be saved"); }
    };
    const failedEvent = protectionCase.buildProtectionEvent({
        guildId: "g1", userId: "u1", action: "ban", attempted: true, success: false
    });
    const skippedEvent = protectionCase.buildProtectionEvent({
        guildId: "g1", userId: "u1", action: "ban", attempted: false, success: true
    });

    assert.equal(await protectionCase.createProtectionCase(sessionManager, failedEvent), null);
    assert.equal(await protectionCase.createProtectionCase(sessionManager, skippedEvent), null);
});

test("recordProtectionResult leaves audit-only detections silent and unpersisted", async () => {
    let writes = 0;
    const event = protectionCase.buildProtectionEvent({
        guildId: "g1", userId: "u1", action: "timeout", attempted: false, success: true
    });
    const result = await protectionCase.recordProtectionResult({
        sessionManager: { async setSetting() { writes++; return true; } },
        event,
        createCase: true
    });

    assert.equal(result, event);
    assert.equal(writes, 0);
    assert.equal(event.caseNumber, undefined);
});

test("recordProtectionResult persists a ModCase after successful enforcement", async () => {
    const store = new Map();
    const sessionManager = {
        async getSetting(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
        async getSettingStrict(key) { return { found: store.has(key), value: store.get(key) ?? null }; },
        async setSetting(key, value) { store.set(key, value); return true; }
    };
    const event = protectionCase.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        actorId: "bot",
        action: "timeout",
        attempted: true,
        success: true,
        reason: "anti-spam",
        timeoutMs: 300000
    });

    await protectionCase.recordProtectionResult({ sessionManager, event, createCase: true });

    assert.equal(event.caseNumber, 1);
    assert.equal(store.get("modcase_g1_1").source, "protection");
    assert.equal(store.get("modcase_g1_1").action, "timeout");
});

test("recordProtectionResult surfaces case persistence failure and writes reconciliation metadata", async () => {
    const modCaseManager = require("../logging/modCaseManager");
    const originalCreateCase = modCaseManager.createCase;
    const store = new Map();
    modCaseManager.createCase = async () => {
        throw new Error("CASE_SAVE_FAILED: private database detail");
    };
    const event = protectionCase.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        action: "ban",
        attempted: true,
        success: true,
        createdAt: 1000
    });
    try {
        const result = await protectionCase.recordProtectionResult({
            sessionManager: {
                async setSetting(key, value) { store.set(key, value); return true; }
            },
            event,
            createCase: true
        });
        assert.equal(result.casePersistence.complete, false);
        assert.equal(result.casePersistence.reconciliationPersisted, true);
        assert.equal(result.casePersistence.errorCode, "CASE_SAVE_FAILED");
        assert.equal(store.get("protection_case_reconcile_g1_u1_1000").status, "reconciliation_required");
    } finally {
        modCaseManager.createCase = originalCreateCase;
    }
});
