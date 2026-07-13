const assert = require("node:assert/strict");
const test = require("node:test");

const modCaseManager = require("../logging/modCaseManager");

function createFakeSessionManager() {
    const store = new Map();
    return {
        async getSetting(key, fallback = null) {
            return store.has(key) ? store.get(key) : fallback;
        },
        async setSetting(key, value) {
            store.set(key, value);
            return true;
        },
        _store: store
    };
}

test("createCase assigns increasing case numbers", async () => {
    const sessionManager = createFakeSessionManager();
    const first = await modCaseManager.createCase(sessionManager, {
        guildId: "g1",
        action: "ban",
        userId: "u1",
        moderatorId: "m1",
        reason: "test reason",
        evidence: ["message spam"]
    });
    const second = await modCaseManager.createCase(sessionManager, {
        guildId: "g1",
        action: "timeout",
        userId: "u1",
        moderatorId: "m1",
        durationMs: 60000
    });

    assert.equal(first.caseNumber, 1);
    assert.equal(second.caseNumber, 2);
    assert.equal(first.evidence[0], "message spam");
});

test("createCase fallback serializes concurrent counters and user indexes", async () => {
    const sessionManager = createFakeSessionManager();
    const [first, second] = await Promise.all([
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "ban", userId: "u1" }),
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "kick", userId: "u1" })
    ]);

    assert.deepEqual([first.caseNumber, second.caseNumber].sort((a, b) => a - b), [1, 2]);
    const list = await modCaseManager.listUserCases(sessionManager, "g1", "u1", 5);
    assert.equal(list.length, 2);
});

test("getCase and listUserCases work with settings fallback", async () => {
    const sessionManager = createFakeSessionManager();
    const created = await modCaseManager.createCase(sessionManager, {
        guildId: "g1",
        action: "kick",
        userId: "u2",
        moderatorId: "m1"
    });

    const loaded = await modCaseManager.getCase(sessionManager, "g1", created.caseNumber);
    const list = await modCaseManager.listUserCases(sessionManager, "g1", "u2");

    assert.equal(loaded.action, "kick");
    assert.equal(list.length, 1);
    assert.equal(list[0].caseNumber, created.caseNumber);
});

test("updateCaseReason amends existing case", async () => {
    const sessionManager = createFakeSessionManager();
    const created = await modCaseManager.createCase(sessionManager, {
        guildId: "g1",
        action: "warn",
        userId: "u3",
        moderatorId: "m1",
        reason: "old"
    });

    const updated = await modCaseManager.updateCaseReason(sessionManager, "g1", created.caseNumber, "new reason", "m2");
    assert.equal(updated.reason, "new reason");
    assert.equal(updated.amendedBy, "m2");
});

test("case fallback fails closed when a database write reports false", async () => {
    const sessionManager = createFakeSessionManager();
    sessionManager.setSetting = async () => false;
    await assert.rejects(
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "ban", userId: "u1" }),
        /CASE_SAVE_FAILED|CASE_COUNTER_SAVE_FAILED/
    );
});

test("updateCaseStatus persists pending workflow outcomes", async () => {
    const sessionManager = createFakeSessionManager();
    const created = await modCaseManager.createCase(sessionManager, {
        guildId: "g1", action: "kick", userId: "u4", status: "pending"
    });
    const completed = await modCaseManager.updateCaseStatus(
        sessionManager, "g1", created.caseNumber, "completed", { actionApplied: true, dmSent: true }
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.metadata.actionApplied, true);
    assert.equal(completed.evidence.includes("DM sent: yes"), true);
    await assert.rejects(
        modCaseManager.updateCaseStatus(sessionManager, "g1", created.caseNumber, "unknown"),
        /CASE_STATUS_INVALID/
    );
});
