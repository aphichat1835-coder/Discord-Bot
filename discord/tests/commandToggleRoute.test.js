"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index/server");

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

test("command toggle keeps runtime state unchanged when persistence fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const disabledCommands = new Set(["ping"]);
    const result = await _test.persistCommandToggle({
        setSetting: async (_key, value) => {
            assert.deepEqual(value, []);
            assert.deepEqual([...disabledCommands], ["ping"]);
            return false;
        }
    }, disabledCommands, "ping");

    assert.equal(result.ok, false);
    assert.deepEqual([...disabledCommands], ["ping"]);
});

test("command toggle applies the new runtime state only after persistence succeeds", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const disabledCommands = new Set();
    const result = await _test.persistCommandToggle({
        setSetting: async (key, value) => {
            assert.equal(key, "disabledCommands");
            assert.deepEqual(value, ["ping"]);
            assert.equal(disabledCommands.has("ping"), false);
            return true;
        }
    }, disabledCommands, "ping");

    assert.deepEqual(result, { ok: true, nowEnabled: false });
    assert.equal(disabledCommands.has("ping"), true);
});

test("command toggle route reports unavailable storage without cooldown or audit side effects", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const res = responseRecorder();
    const disabledCommands = new Set();
    const commandAuditLog = [];
    const toggleCooldowns = new Map();

    await _test.handleCommandToggle({
        req: { body: { commandName: "ping" }, ip: "127.0.0.1" },
        res,
        checkAuth: () => true,
        commands: { slashCommandsData: [{ name: "ping" }] },
        sessionManager: { setSetting: async () => false },
        disabledCommands,
        commandAuditLog,
        toggleCooldowns,
        now: () => 10_000
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(disabledCommands.size, 0);
    assert.equal(commandAuditLog.length, 0);
    assert.equal(toggleCooldowns.size, 0);
});
