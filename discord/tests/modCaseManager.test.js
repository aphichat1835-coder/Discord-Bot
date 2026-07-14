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
        async deleteSetting(key) {
            store.delete(key);
            return true;
        },
        _store: store
    };
}

test("createCase assigns increasing case numbers", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("createCase fallback serializes concurrent counters and user indexes", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessionManager = createFakeSessionManager();
    const [first, second] = await Promise.all([
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "ban", userId: "u1" }),
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "kick", userId: "u1" })
    ]);

    assert.deepEqual([first.caseNumber, second.caseNumber].sort((a, b) => a - b), [1, 2]);
    const list = await modCaseManager.listUserCases(sessionManager, "g1", "u1", 5);
    assert.equal(list.length, 2);
});

test("getCase and listUserCases work with settings fallback", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("updateCaseReason amends existing case", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("case fallback fails closed when a database write reports false", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessionManager = createFakeSessionManager();
    sessionManager.setSetting = async () => false;
    await assert.rejects(
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "ban", userId: "u1" }),
        /CASE_SAVE_FAILED|CASE_COUNTER_SAVE_FAILED/
    );
});


test("settings fallback removes an orphan case when user-index persistence fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessionManager = createFakeSessionManager();
    const originalSet = sessionManager.setSetting.bind(sessionManager);
    sessionManager.setSetting = async (key, value) => {
        if (key === "modcase_index_g1_u1") return false;
        return originalSet(key, value);
    };

    await assert.rejects(
        modCaseManager.createCase(sessionManager, { guildId: "g1", action: "ban", userId: "u1" }),
        /CASE_SAVE_FAILED/
    );

    assert.equal(sessionManager._store.has("modcase_g1_1"), false);
    assert.equal(sessionManager._store.has("modcase_index_g1_u1"), false);
});

test("settings fallback rolls back the case when index access throws", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessionManager = createFakeSessionManager();
    const originalGet = sessionManager.getSetting.bind(sessionManager);
    sessionManager.getSetting = async (key, fallback) => {
        if (key === "modcase_index_g1_u1") throw new Error("index unavailable");
        return originalGet(key, fallback);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
        await assert.rejects(
            modCaseManager.createCase(sessionManager, { guildId: "g1", action: "ban", userId: "u1" }),
            /CASE_SAVE_FAILED/
        );
    } finally {
        console.warn = warn;
    }
    assert.equal(sessionManager._store.has("modcase_g1_1"), false);
});

test("settings fallback restores a previous case when re-indexing the replacement fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sessionManager = createFakeSessionManager();
    sessionManager._store.set("modcase_g1_9", {
        guildId: "g1", caseNumber: 9, action: "kick", userId: "u1", reason: "old", metadata: {}
    });
    const originalSet = sessionManager.setSetting.bind(sessionManager);
    sessionManager.setSetting = async (key, value) => {
        if (key === "modcase_index_g1_u1") return false;
        return originalSet(key, value);
    };

    await assert.rejects(
        modCaseManager.createCase(sessionManager, {
            guildId: "g1", caseNumber: 9, action: "ban", userId: "u1", reason: "new"
        }),
        /CASE_SAVE_FAILED/
    );

    assert.equal(sessionManager._store.get("modcase_g1_9").action, "kick");
    assert.equal(sessionManager._store.get("modcase_g1_9").reason, "old");
});


test("legacy settings cases stay settings-backed when MongoDB is connected", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const mongoose = require("mongoose");
    const modCaseStore = require("../logging/modCaseStore");
    const sessionManager = createFakeSessionManager();
    sessionManager._store.set("modcase_g1_7", {
        guildId: "g1",
        caseNumber: 7,
        action: "timeout",
        userId: "u7",
        status: "pending",
        evidence: [],
        metadata: {}
    });

    const readyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
    const originalGetCase = modCaseStore.getCase;
    const originalUpdateCase = modCaseStore.updateCase;
    let mongoUpdates = 0;
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value: 1 });
    modCaseStore.getCase = async () => null;
    modCaseStore.updateCase = async () => { mongoUpdates++; return null; };

    try {
        const loaded = await modCaseManager.getCase(sessionManager, "g1", 7);
        assert.equal(loaded.metadata.persistenceStore, "settings");
        const amended = await modCaseManager.updateCaseReason(sessionManager, "g1", 7, "updated reason", "m1");
        const completed = await modCaseManager.updateCaseStatus(
            sessionManager, "g1", 7, "completed", { actionApplied: true }
        );
        assert.equal(amended.reason, "updated reason");
        assert.equal(amended.metadata.persistenceStore, "settings");
        assert.equal(completed.status, "completed");
        assert.equal(completed.metadata.persistenceStore, "settings");
        assert.equal(mongoUpdates, 0);
        assert.equal(sessionManager._store.has("modcase_reconcile_g1_7"), false);
    } finally {
        modCaseStore.getCase = originalGetCase;
        modCaseStore.updateCase = originalUpdateCase;
        if (readyStateDescriptor) Object.defineProperty(mongoose.connection, "readyState", readyStateDescriptor);
        else delete mongoose.connection.readyState;
    }
});


test("case lookup and lists preserve settings fallback records alongside Mongo cases", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const mongoose = require("mongoose");
    const modCaseStore = require("../logging/modCaseStore");
    const sessionManager = createFakeSessionManager();
    sessionManager._store.set("modcase_g1_4", {
        guildId: "g1", caseNumber: 4, action: "kick", userId: "u1",
        status: "completed", createdAt: 400, metadata: {}
    });
    sessionManager._store.set("modcase_index_g1_u1", [4]);

    const readyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
    const originalGetCase = modCaseStore.getCase;
    const originalList = modCaseStore.listUserCases;
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value: 1 });
    modCaseStore.getCase = async () => ({
        guildId: "g1", caseNumber: 4, action: "ban", userId: "u1",
        status: "completed", createdAt: 450, metadata: {}
    });
    modCaseStore.listUserCases = async () => [
        { guildId: "g1", caseNumber: 5, action: "timeout", userId: "u1", createdAt: 500, metadata: {} },
        { guildId: "g1", caseNumber: 4, action: "ban", userId: "u1", createdAt: 450, metadata: {} }
    ];

    try {
        const loaded = await modCaseManager.getCase(sessionManager, "g1", 4);
        assert.equal(loaded.action, "kick");
        assert.equal(loaded.metadata.persistenceStore, "settings");

        const listed = await modCaseManager.listUserCases(sessionManager, "g1", "u1", 10);
        assert.deepEqual(listed.map(item => [item.caseNumber, item.action, item.metadata.persistenceStore]), [
            [5, "timeout", "mongo"],
            [4, "kick", "settings"]
        ]);
    } finally {
        modCaseStore.getCase = originalGetCase;
        modCaseStore.listUserCases = originalList;
        if (readyStateDescriptor) Object.defineProperty(mongoose.connection, "readyState", readyStateDescriptor);
        else delete mongoose.connection.readyState;
    }
});

test("Mongo-backed case update failures create reconciliation without copying the case into settings", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const mongoose = require("mongoose");
    const modCaseStore = require("../logging/modCaseStore");
    const sessionManager = createFakeSessionManager();
    const readyStateDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
    const originalGetCase = modCaseStore.getCase;
    const originalUpdateCase = modCaseStore.updateCase;
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value: 1 });
    modCaseStore.getCase = async () => ({
        guildId: "g1", caseNumber: 9, action: "ban", userId: "u9",
        status: "pending", evidence: [], metadata: { persistenceStore: "mongo" }
    });
    modCaseStore.updateCase = async () => null;

    try {
        const amended = await modCaseManager.updateCaseReason(sessionManager, "g1", 9, "new reason", "m1");
        assert.equal(amended, null);
        assert.equal(sessionManager._store.has("modcase_g1_9"), false);
        const reasonRecovery = sessionManager._store.get("modcase_reconcile_g1_9");
        assert.equal(reasonRecovery.operation, "update_reason");
        assert.equal(reasonRecovery.patch.reason, "new reason");

        const completed = await modCaseManager.updateCaseStatus(
            sessionManager, "g1", 9, "completed", { actionApplied: true }
        );
        assert.equal(completed, null);
        assert.equal(sessionManager._store.has("modcase_g1_9"), false);
        const statusRecovery = sessionManager._store.get("modcase_reconcile_g1_9");
        assert.equal(statusRecovery.operation, "update_status");
        assert.equal(statusRecovery.patch.status, "completed");
    } finally {
        modCaseStore.getCase = originalGetCase;
        modCaseStore.updateCase = originalUpdateCase;
        if (readyStateDescriptor) Object.defineProperty(mongoose.connection, "readyState", readyStateDescriptor);
        else delete mongoose.connection.readyState;
    }
});

test("updateCaseStatus persists pending workflow outcomes", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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
