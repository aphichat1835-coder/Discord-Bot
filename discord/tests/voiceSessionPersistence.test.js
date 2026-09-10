"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sessionManager = require("../sessionManager");

const {
    buildSessionSaveOperation,
    saveDatabase,
    queuePendingSessionDelete,
    buildPendingSessionDeleteFilter,
    flushPendingSessionDeletes
} = sessionManager._test;

function session(generation = "generation-current") {
    return {
        lifecycleGeneration: generation,
        token: "encrypted-token",
        serverId: "guild-1",
        voiceId: "voice-1",
        ownerId: "owner-1",
        state: "active",
        lastActivity: 123
    };
}

test("periodic voice session saves are generation-fenced and cannot upsert", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const operation = buildSessionSaveOperation("session-1", session("generation-old"));

    assert.deepEqual(operation.updateOne.filter, {
        sessionId: "session-1",
        lifecycleGeneration: "generation-old"
    });
    assert.equal(operation.updateOne.upsert, false);
    assert.equal(operation.updateOne.update.$set.lifecycleGeneration, "generation-old");
    assert.equal(buildSessionSaveOperation("session-1", session(null)), null);
});

test("periodic save skips an empty map and writes only the current generation", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let writes = 0;
    const model = {
        async bulkWrite(operations) {
            writes++;
            assert.equal(operations.length, 1);
            assert.equal(operations[0].updateOne.filter.lifecycleGeneration, "generation-current");
            return { matchedCount: 1 };
        }
    };

    await saveDatabase({ dbConnected: true, sessions: new Map(), sessionModel: model });
    assert.equal(writes, 0);

    await saveDatabase({
        dbConnected: true,
        sessions: new Map([["session-1", session()]]),
        sessionModel: model
    });
    assert.equal(writes, 1);
});

test("deferred deletes keep their generation and do not target a recreated session", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const pendingDeletes = new Map();
    queuePendingSessionDelete("session-1", "generation-old", pendingDeletes);
    queuePendingSessionDelete("session-2", "generation-two", pendingDeletes);

    const filter = buildPendingSessionDeleteFilter([...pendingDeletes]);
    assert.deepEqual(filter, {
        $or: [
            { sessionId: "session-1", lifecycleGeneration: "generation-old" },
            { sessionId: "session-2", lifecycleGeneration: "generation-two" }
        ]
    });
    assert.equal(JSON.stringify(filter).includes("generation-new"), false);

    let receivedFilter = null;
    await flushPendingSessionDeletes({
        dbConnected: true,
        pendingDeletes,
        sessionModel: {
            async deleteMany(value) {
                receivedFilter = value;
                return { acknowledged: true };
            }
        }
    });

    assert.deepEqual(receivedFilter, filter);
    assert.equal(pendingDeletes.size, 0);
});
