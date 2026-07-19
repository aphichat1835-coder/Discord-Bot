const assert = require("node:assert/strict");
const test = require("node:test");

const { slashCommandsData, validateSlashCommandsData } = require("../commands/registry");
const commands = require("../commands");

test("registry exports the command definitions consumed by commands.js", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(commands.slashCommandsData, slashCommandsData);
    assert.equal(Array.isArray(slashCommandsData), true);
    assert.ok(slashCommandsData.length > 0);
});

test("slash command names are unique and include supported command groups", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const names = slashCommandsData.map(command => command.name);
    const unique = new Set(names);

    assert.equal(unique.size, names.length);
    assert.equal(names.length, 15);

    for (const expected of [
        "voice-online",
        "clear",
        "ban",
        "kick",
        "timeout",
        "voicekickall",
        "say",
        "announce",
        "backup",
        "restore",
        "setup-verify"
    ]) {
        assert.equal(unique.has(expected), true, `missing /${expected}`);
    }
    assert.equal(unique.has("help"), false, "retired /help command must stay unregistered");
    assert.equal(unique.has("setup"), false, "retired /setup command must stay unregistered");
    assert.equal(unique.has("stats"), false, "retired /stats command must stay unregistered");
    assert.equal(unique.has("whitelist"), false, "retired /whitelist command must stay unregistered");
    assert.equal(unique.has("setup-log"), false, "retired /setup-log command must stay unregistered");
});

test("slash command definitions have stable required shape", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    for (const command of slashCommandsData) {
        assert.equal(typeof command.name, "string");
        assert.match(command.name, /^[a-z0-9-]{1,32}$/);
        assert.equal(typeof command.description, "string");
        assert.ok(command.description.length > 0);
        assert.equal(command.dmPermission, false);

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

test("announce exposes safe mention opt-in", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const announce = slashCommandsData.find(command => command.name === "announce");
    const allowMentions = announce.options.find(option => option.name === "allow_mentions");

    assert.equal(allowMentions.type, 5);
    assert.equal(allowMentions.required, false);
});

test("restore exposes dry-run option", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const restore = slashCommandsData.find(command => command.name === "restore");
    const dryRun = restore.options.find(option => option.name === "dry_run");

    assert.equal(dryRun.type, 5);
    assert.equal(dryRun.required, false);
});

test("slash command registry validation rejects empty or malformed payloads", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(() => validateSlashCommandsData([]), /empty/);
    assert.throws(() => validateSlashCommandsData([{ name: "Bad Name", description: "ok" }]), /invalid slash-command name/);
    assert.throws(() => validateSlashCommandsData([{ name: "ok", description: "" }]), /invalid description/);
    assert.throws(() => validateSlashCommandsData([
        { name: "dup", description: "first", dmPermission: false },
        { name: "dup", description: "second", dmPermission: false }
    ]), /duplicate/);
    assert.throws(() => validateSlashCommandsData([
        { name: "ok", description: "valid", dmPermission: false, options: [{ type: 999, name: "x", description: "bad", required: true }] }
    ]), /invalid type/);
});
