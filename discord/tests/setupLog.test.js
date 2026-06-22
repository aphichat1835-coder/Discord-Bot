const assert = require("node:assert/strict");
const test = require("node:test");

const setupLog = require("../commands/setupLog");

test("setup-log category list includes moderation", () => {
    assert.ok(setupLog.LOG_CATEGORIES.includes("moderation"));
    assert.equal(setupLog._test.getConfiguredChannelName("moderation"), "log-การลงโทษ");
});

test("setup-log detects text channels by v13 isText", () => {
    assert.equal(setupLog._test.isTextChannel({ isText: () => true }), true);
    assert.equal(setupLog._test.isTextChannel({ isText: () => false }), false);
});

test("setup-log finds existing named log channel", () => {
    const channel = { id: "c1", name: "log-การลงโทษ", isText: () => true };
    const guild = {
        channels: {
            cache: {
                get: () => null,
                find: (fn) => fn(channel) ? channel : null
            }
        }
    };
    assert.equal(setupLog._test.findExistingLogChannel(guild, "moderation"), channel);
});
