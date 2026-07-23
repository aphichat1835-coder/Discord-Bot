"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, Options } = require("discord.js");
const { buildMainClientOptions } = require("../core/mainClientOptions");

test("builds discord.js v14 client options with cache and default sweepers", async () => {
    const options = buildMainClientOptions({
        DISCORD_MESSAGE_CACHE_MAX: "42",
        DISCORD_MESSAGE_SWEEP_INTERVAL_SEC: "60",
        DISCORD_MESSAGE_SWEEP_LIFETIME_SEC: "120"
    });

    assert.equal(typeof options.makeCache, "function");
    assert.equal(options.sweepers.messages.interval, 60);
    assert.equal(options.sweepers.messages.lifetime, 120);
    assert.equal(
        options.sweepers.threads.interval,
        Options.DefaultSweeperSettings.threads.interval
    );
    assert.equal(
        options.sweepers.threads.lifetime,
        Options.DefaultSweeperSettings.threads.lifetime
    );

    const client = new Client(options);
    assert.equal(client.options.sweepers.messages.interval, 60);
    assert.equal(client.options.sweepers.messages.lifetime, 120);
    await client.destroy();
});

test("entrypoint uses the v14 client option boundary without stale v13 sweepers", () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

    assert.match(entrypoint, /new Client\(buildMainClientOptions\(process\.env\)\)/);
    assert.doesNotMatch(entrypoint, /LimitedCollection\.filterByLifetime/);
    assert.doesNotMatch(entrypoint, /Options\.defaultSweeperSettings/);
});
