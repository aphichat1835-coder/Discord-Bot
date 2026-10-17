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
    assert.equal(names.length, 19);
    assert.equal(names.at(-1), "join-panel");

    for (const expected of [
        "voice-online",
        "clear",
        "ban",
        "kick",
        "timeout",
        "re-role",
        "voice-admin",
        "say",
        "embed",
        "copy-emojis",
        "setup-verify",
        "quest",
        "token-check",
        "dm-panel",
        "join-panel",
        "user"
    ]) {
        assert.equal(unique.has(expected), true, `missing /${expected}`);
    }
    assert.equal(unique.has("announce"), false, "retired /announce command must stay unregistered");
    assert.equal(unique.has("backup"), false, "retired /backup command must stay unregistered");
    assert.equal(unique.has("restore"), false, "retired /restore command must stay unregistered");
    assert.equal(unique.has("help"), false, "retired /help command must stay unregistered");
    assert.equal(unique.has("setup"), false, "retired /setup command must stay unregistered");
    assert.equal(unique.has("stats"), false, "retired /stats command must stay unregistered");
    assert.equal(unique.has("whitelist"), false, "retired /whitelist command must stay unregistered");
    assert.equal(unique.has("setup-log"), false, "retired /setup-log command must stay unregistered");
    assert.equal(unique.has("voicekickall"), false, "replaced /voicekickall command must stay unregistered");
    assert.equal(unique.has("rerole"), false, "replaced /rerole command must stay unregistered");
});

test("re-role exposes target role and five optional role exceptions", () => {
    const rerole = slashCommandsData.find(command => command.name === "re-role");

    assert.ok(rerole);
    assert.equal(rerole.options.length, 6);
    assert.deepEqual(rerole.options.map(option => option.name), [
        "target_role",
        "role_1",
        "role_2",
        "role_3",
        "role_4",
        "role_5"
    ]);
    assert.equal(rerole.options.every(option => option.type === 8 && option.required === false), true);
});

test("quest panel exposes optional auto_daily boolean option", () => {
    const quest = slashCommandsData.find(command => command.name === "quest");
    assert.ok(quest);
    assert.equal(Array.isArray(quest.options), true);
    const panelSubcommand = quest.options.find(opt => opt.name === "panel");
    assert.ok(panelSubcommand);
    assert.equal(panelSubcommand.type, 1);
    assert.equal(Array.isArray(panelSubcommand.options), true);
    const autoDaily = panelSubcommand.options.find(opt => opt.name === "auto_daily");
    assert.ok(autoDaily);
    assert.equal(autoDaily.type, 5);
    assert.equal(autoDaily.required, false);
});

test("user exposes avatar subcommand with optional member option", () => {
    const user = slashCommandsData.find(command => command.name === "user");
    assert.ok(user);
    assert.equal(Array.isArray(user.options), true);
    const avatarSubcommand = user.options.find(opt => opt.name === "avatar");
    assert.ok(avatarSubcommand);
    assert.equal(avatarSubcommand.type, 1);
    assert.equal(avatarSubcommand.required, false);
    assert.equal(Array.isArray(avatarSubcommand.options), true);
    const memberOption = avatarSubcommand.options.find(opt => opt.name === "member");
    assert.ok(memberOption);
    assert.equal(memberOption.type, 6);
    assert.equal(memberOption.required, false);
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

test("embed command defines subcommand create with standard options and thai descriptions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const embed = slashCommandsData.find(command => command.name === "embed");
    assert.ok(embed, "missing /embed command in registry");
    assert.equal(embed.description, "ระบบสร้างข้อความประกาศแบบ Embed");

    const create = embed.options?.find(option => option.name === "create");
    assert.ok(create, "missing /embed create subcommand");
    assert.equal(create.type, 1, "subcommand type must be 1");
    assert.equal(create.description, "สร้างและส่งข้อความ Embed สำหรับประกาศ");

    const optionNames = create.options.map(opt => opt.name);
    const expectedOrder = [
        "description", "title", "channel", "content", "color",
        "image", "thumbnail", "footer", "url", "timestamp",
        "button_label", "button_url"
    ];
    assert.deepEqual(optionNames, expectedOrder);

    const descOpt = create.options.find(opt => opt.name === "description");
    assert.equal(descOpt.required, true);
    assert.equal(descOpt.type, 3);
    assert.equal(descOpt.max_length, 4096);
    assert.equal(descOpt.description, "เนื้อหาหลักของ Embed รองรับ Markdown และขึ้นบรรทัดใหม่");

    // Verify removed options
    assert.equal(create.options.find(opt => opt.name === "message"), undefined);
    assert.equal(create.options.find(opt => opt.name === "button_text"), undefined);
    assert.equal(create.options.find(opt => opt.name === "author_name"), undefined);
    assert.equal(create.options.find(opt => opt.name === "author_icon"), undefined);
    assert.equal(create.options.find(opt => opt.name === "footer_icon"), undefined);

    // Verify all other options are optional (required !== true)
    for (const opt of create.options) {
        if (opt.name !== "description") {
            assert.notEqual(opt.required, true, `${opt.name} must be optional`);
        }
    }
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
