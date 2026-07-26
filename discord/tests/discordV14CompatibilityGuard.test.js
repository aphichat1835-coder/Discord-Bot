"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { analyzeSource } = require("../../scripts/checkDiscordV14Compatibility");

function codes(source) {
    return analyzeSource(source, "fixture.js").map(item => item.code);
}

test("Discord.js v14 guard rejects legacy permission and channel APIs", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(codes('member.permissions.has("ADMINISTRATOR");'), ["LEGACY_PERMISSION_HAS"]);
    assert.deepEqual(codes('channel.permissionOverwrites.edit(id, { SEND_MESSAGES: false });'), ["LEGACY_PERMISSION_OBJECT_KEY"]);
    assert.deepEqual(codes('channel.isText();'), ["DEPRECATED_IS_TEXT"]);
});

test("Discord.js v14 guard rejects credential query, app.all, direct cache clear, and prefix origin checks", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = codes(`
        const pin = req.query.pin;
        app.all('/private', handler);
        client.channels.cache.clear();
        raw.startsWith(window.location.origin);
    `);
    assert.deepEqual(result.sort(), [
        "DIRECT_CHANNEL_CACHE_CLEAR",
        "QUERY_PIN",
        "STATE_ROUTE_APP_ALL",
        "UNSAFE_SAME_ORIGIN_PREFIX"
    ]);
});

test("Discord.js v14 guard accepts canonical runtime patterns", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(codes(`
        member.permissions.has(PermissionFlagsBits.Administrator);
        channel.permissionOverwrites.edit(id, { SendMessages: false });
        channel.isTextBased();
        app.post('/private', handler);
        const target = new URL(raw, window.location.href);
        if (target.origin === window.location.origin) use(target);
    `), []);
});
