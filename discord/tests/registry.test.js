const assert = require("node:assert/strict");
const test = require("node:test");

const { slashCommandsData } = require("../commands/registry");
const commands = require("../commands");

test("registry exports the command definitions consumed by commands.js", () => {
    assert.equal(commands.slashCommandsData, slashCommandsData);
    assert.equal(Array.isArray(slashCommandsData), true);
    assert.ok(slashCommandsData.length > 0);
});

test("slash command names are unique and include supported command groups", () => {
    const names = slashCommandsData.map(command => command.name);
    const unique = new Set(names);

    assert.equal(unique.size, names.length);

    for (const expected of [
        "panel",
        "help",
        "stats",
        "clear",
        "ban",
        "kick",
        "timeout",
        "voicekickall",
        "say",
        "announce",
        "backup",
        "restore",
        "setup-log",
        "whitelist",
        "setup",
        "setup-verify"
    ]) {
        assert.equal(unique.has(expected), true, `missing /${expected}`);
    }
});

test("slash command definitions have stable required shape", () => {
    for (const command of slashCommandsData) {
        assert.equal(typeof command.name, "string");
        assert.match(command.name, /^[a-z0-9-]{1,32}$/);
        assert.equal(typeof command.description, "string");
        assert.ok(command.description.length > 0);

        if (command.options) {
            assert.equal(Array.isArray(command.options), true);
            for (const option of command.options) {
                assert.equal(typeof option.type, "number");
                assert.equal(typeof option.name, "string");
                assert.equal(typeof option.description, "string");
                assert.equal(typeof option.required, "boolean");
            }
        }
    }
});
