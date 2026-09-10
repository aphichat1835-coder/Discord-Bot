"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { runBootLifecycle } = require("../core/bootLifecycle");

function runner(failed = new Set()) {
    return async (category, label, task, options = {}) => {
        if (failed.has(label)) return { ok: false };
        return { ok: true, value: await task(), category, options };
    };
}

test("mocked boot preserves HTTP Mongo verification settings Discord order", async () => {
    const calls = []; const mark = name => async () => { calls.push(name); return { name }; };
    const result = await runBootLifecycle({ runStage: runner(), startHttpServer: mark("http"),
        connectDatabase: mark("mongo-connect"), loadDatabase: mark("mongo-load"), verificationEnabled: true,
        startVerification: mark("verification"), loadDisabledCommands: mark("settings"), loginDiscord: mark("discord") });
    assert.deepEqual(calls, ["http", "mongo-connect", "mongo-load", "verification", "settings", "discord"]);
    assert.equal(result.discordReady, true); assert.deepEqual(result.degradedStages, []);
});

test("optional boot failures stay degraded and Discord still starts", async () => {
    let logins = 0; const failed = new Set(["04/06 Start verification lifecycle", "05/06 Load disabled commands"]);
    const result = await runBootLifecycle({ runStage: runner(failed), startHttpServer: async () => ({}),
        connectDatabase: async () => ({}), loadDatabase: async () => ({}), verificationEnabled: true,
        startVerification: async () => ({}), loadDisabledCommands: async () => ({}),
        loginDiscord: async () => { logins++; return {}; } });
    assert.equal(logins, 1); assert.equal(result.discordReady, true);
    assert.deepEqual(result.degradedStages, ["verification", "command_settings"]);
});

test("shutdown aborts before Discord login", async () => {
    let logins = 0;
    const result = await runBootLifecycle({ runStage: runner(), startHttpServer: async () => ({}),
        connectDatabase: async () => ({}), loadDatabase: async () => ({}), verificationEnabled: false,
        loadDisabledCommands: async () => ({}), loginDiscord: async () => { logins++; },
        shouldAbort: stage => stage === "before Discord login" });
    assert.equal(result.aborted, true); assert.equal(result.abortedAt, "before Discord login"); assert.equal(logins, 0);
});

test("Discord login failure leaves boot degraded without aborting", async () => {
    const failed = new Set(["06/06 Login Discord client"]);
    const result = await runBootLifecycle({
        runStage: runner(failed),
        startHttpServer: async () => ({}),
        connectDatabase: async () => ({}),
        loadDatabase: async () => ({}),
        verificationEnabled: false,
        loadDisabledCommands: async () => ({}),
        loginDiscord: async () => ({})
    });

    assert.equal(result.aborted, false);
    assert.equal(result.discordReady, false);
    assert.deepEqual(result.degradedStages, ["discord"]);
});
