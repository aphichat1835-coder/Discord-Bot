const assert = require("node:assert/strict");
const test = require("node:test");

const { slashCommandsData, validateSlashCommandsData } = require("../commands/registry");
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
        "voice-online",
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
        "setup-verify"
    ]) {
        assert.equal(unique.has(expected), true, `missing /${expected}`);
    }
    assert.equal(unique.has("setup"), false, "retired /setup command must stay unregistered");
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

test("announce exposes safe mention opt-in", () => {
    const announce = slashCommandsData.find(command => command.name === "announce");
    const allowMentions = announce.options.find(option => option.name === "allow_mentions");

    assert.equal(allowMentions.type, 5);
    assert.equal(allowMentions.required, false);
});

test("restore exposes dry-run option", () => {
    const restore = slashCommandsData.find(command => command.name === "restore");
    const dryRun = restore.options.find(option => option.name === "dry_run");

    assert.equal(dryRun.type, 5);
    assert.equal(dryRun.required, false);
});

test("slash command registry validation rejects empty or malformed payloads", () => {
    assert.throws(() => validateSlashCommandsData([]), /empty/);
    assert.throws(() => validateSlashCommandsData([{ name: "Bad Name", description: "ok" }]), /invalid slash-command name/);
    assert.throws(() => validateSlashCommandsData([{ name: "ok", description: "" }]), /invalid description/);
    assert.throws(() => validateSlashCommandsData([
        { name: "dup", description: "first" },
        { name: "dup", description: "second" }
    ]), /duplicate/);
    assert.throws(() => validateSlashCommandsData([
        { name: "ok", description: "valid", options: [{ type: 999, name: "x", description: "bad", required: true }] }
    ]), /invalid type/);
});
