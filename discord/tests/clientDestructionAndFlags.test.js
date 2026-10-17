"use strict";

const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DEFAULT_FLAGS,
    envNameFor,
    isFeatureEnabled,
    getFeatureFlags
} = require("../core/featureFlags");

function loadDestroyDiscordClientSafely(client, bootLog) {
    const indexSource = fs.readFileSync("discord/index.js", "utf8");
    const funcMatch = indexSource.match(/function destroyDiscordClientSafely\(reason\)\s*\{[\s\S]*?\n\}/);
    if (!funcMatch) {
        throw new Error("Could not find destroyDiscordClientSafely in discord/index.js");
    }
    const context = {
        client,
        bootLog,
        Promise,
        console
    };
    vm.runInNewContext(`${funcMatch[0]}; this.destroyDiscordClientSafely = destroyDiscordClientSafely;`, context);
    return context.destroyDiscordClientSafely;
}

test("isFeatureEnabled: returns default flag value or fallback when env is undefined or empty string", () => {
    const testKey = "FEATURE_CUSTOM_TEST_FLAG";
    const originalVal = process.env[testKey];

    try {
        // 1. undefined case
        delete process.env[testKey];
        assert.equal(isFeatureEnabled("customTestFlag", true), true);
        assert.equal(isFeatureEnabled("customTestFlag", false), false);
        assert.equal(isFeatureEnabled("customTestFlag"), true); // default fallback = true

        // 2. empty string case
        process.env[testKey] = "";
        assert.equal(isFeatureEnabled("customTestFlag", true), true);
        assert.equal(isFeatureEnabled("customTestFlag", false), false);
        assert.equal(isFeatureEnabled("customTestFlag"), true);

        // 3. Known default flags when undefined
        const voiceKey = envNameFor("voice");
        const originalVoice = process.env[voiceKey];
        delete process.env[voiceKey];
        try {
            assert.equal(isFeatureEnabled("voice", false), true, "DEFAULT_FLAGS.voice should take precedence over fallback");
            assert.equal(DEFAULT_FLAGS.voice, true);
        } finally {
            if (originalVoice !== undefined) process.env[voiceKey] = originalVoice;
        }
    } finally {
        if (originalVal !== undefined) {
            process.env[testKey] = originalVal;
        } else {
            delete process.env[testKey];
        }
    }
});

test("isFeatureEnabled: recognizes all truthy values (case-insensitive, trimmed)", () => {
    const testKey = "FEATURE_TRUTHY_TEST";
    const originalVal = process.env[testKey];
    const truthyValues = ["1", "true", "yes", "on", "enabled", "TRUE", "Yes", " ON ", "\tenabled\n"];

    try {
        for (const val of truthyValues) {
            process.env[testKey] = val;
            assert.equal(isFeatureEnabled("truthyTest", false), true, `Value "${val}" should be truthy`);
        }
    } finally {
        if (originalVal !== undefined) {
            process.env[testKey] = originalVal;
        } else {
            delete process.env[testKey];
        }
    }
});

test("isFeatureEnabled: recognizes all falsy values (case-insensitive, trimmed)", () => {
    const testKey = "FEATURE_FALSY_TEST";
    const originalVal = process.env[testKey];
    const falsyValues = ["0", "false", "no", "off", "disabled", "FALSE", "No", " OFF ", "\tdisabled\n"];

    try {
        for (const val of falsyValues) {
            process.env[testKey] = val;
            assert.equal(isFeatureEnabled("falsyTest", true), false, `Value "${val}" should be falsy`);
        }
    } finally {
        if (originalVal !== undefined) {
            process.env[testKey] = originalVal;
        } else {
            delete process.env[testKey];
        }
    }
});

test("isFeatureEnabled: envNameFor and getFeatureFlags behavior", () => {
    assert.equal(envNameFor("voice"), "FEATURE_VOICE");
    assert.equal(envNameFor("sensitiveAccess"), "FEATURE_SENSITIVE_ACCESS");
    assert.equal(envNameFor("memoryMonitor"), "FEATURE_MEMORY_MONITOR");

    const flags = getFeatureFlags();
    assert.equal(typeof flags, "object");
    for (const key of Object.keys(DEFAULT_FLAGS)) {
        assert.equal(key in flags, true);
    }
});

test("destroyDiscordClientSafely: handles successful asynchronous resolution without throwing or returning Promise", async () => {
    let destroyed = false;
    const warnings = [];
    const client = {
        destroy: async () => {
            destroyed = true;
        }
    };
    const bootLog = {
        warn: (tag, msg, meta) => warnings.push({ tag, msg, meta })
    };

    const destroyDiscordClientSafely = loadDestroyDiscordClientSafely(client, bootLog);
    const result = destroyDiscordClientSafely("login failure");

    assert.equal(result, undefined, "Must return undefined synchronously to avoid affecting callers");
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(destroyed, true);
    assert.equal(warnings.length, 0, "No warning should be logged on successful destroy");
});

test("destroyDiscordClientSafely: catches asynchronous client.destroy() rejection without unhandled rejection", async () => {
    const warnings = [];
    const clientError = new Error("Gateway connection reset");
    clientError.code = "ECONNRESET";

    const client = {
        destroy: async () => {
            throw clientError;
        }
    };
    const bootLog = {
        warn: (tag, msg, meta) => warnings.push({ tag, msg, meta })
    };

    const destroyDiscordClientSafely = loadDestroyDiscordClientSafely(client, bootLog);
    const result = destroyDiscordClientSafely("ready timeout");

    assert.equal(result, undefined);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].tag, "DISCORD");
    assert.equal(warnings[0].msg, "Discord client cleanup failed");
    assert.equal(warnings[0].meta?.code, "ECONNRESET");
    assert.equal(warnings[0].meta?.reason, "ready timeout");
});

test("destroyDiscordClientSafely: catches synchronous throws inside client.destroy() safely", async () => {
    const warnings = [];
    const clientError = new Error("Sync destruction crash");
    clientError.name = "SyncCrash";

    const client = {
        destroy: () => {
            throw clientError;
        }
    };
    const bootLog = {
        warn: (tag, msg, meta) => warnings.push({ tag, msg, meta })
    };

    const destroyDiscordClientSafely = loadDestroyDiscordClientSafely(client, bootLog);

    assert.doesNotThrow(() => {
        const result = destroyDiscordClientSafely("ready event during shutdown");
        assert.equal(result, undefined);
    });

    await new Promise(resolve => setImmediate(resolve));

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].tag, "DISCORD");
    assert.equal(warnings[0].msg, "Discord client cleanup failed");
    assert.equal(warnings[0].meta?.code, "SyncCrash");
    assert.equal(warnings[0].meta?.reason, "ready event during shutdown");
});

test("destroyDiscordClientSafely: provides default error code when error is missing code and name", async () => {
    const warnings = [];
    const client = {
        destroy: () => Promise.reject("string error reason")
    };
    const bootLog = {
        warn: (tag, msg, meta) => warnings.push({ tag, msg, meta })
    };

    const destroyDiscordClientSafely = loadDestroyDiscordClientSafely(client, bootLog);
    destroyDiscordClientSafely("unspecified failure");

    await new Promise(resolve => setImmediate(resolve));

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].meta?.code, "destroy_failed");
    assert.equal(warnings[0].meta?.reason, "unspecified failure");
});

test("destroyDiscordClientSafely: source code matches safe async pattern and call sites in discord/index.js", () => {
    const indexSource = fs.readFileSync("discord/index.js", "utf8");

    // Verify pattern
    assert.match(indexSource, /void Promise\.resolve\(\)\s*\.then\(\(\) => client\.destroy\(\)\)\s*\.catch\(err => \{/);

    // Verify call sites remain intact
    assert.match(indexSource, /destroyDiscordClientSafely\("ready timeout"\);/);
    assert.match(indexSource, /destroyDiscordClientSafely\("login failure"\);/);
    assert.match(indexSource, /destroyDiscordClientSafely\("ready event during shutdown"\);/);
});
