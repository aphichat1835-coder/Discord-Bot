const assert = require("node:assert/strict");
const test = require("node:test");

const roleSweep = require("../commands/roleSweep");
const commands = require("../commands");
const voiceAdmin = require("../features/voiceAdmin");
const config = require("../config.json");

const GUILD_ID = "100000000000000001";
const ACTOR_ID = "100000000000000002";
const TARGET_ID = "100000000000000003";
const BOT_ID = "100000000000000004";

function role(id, position, options = {}) {
    return { id, name: options.name || id, position, managed: options.managed === true };
}

function member(id, roles, options = {}) {
    const calls = [];
    const output = {
        id,
        user: { id, bot: options.bot === true },
        manageable: options.manageable !== false,
        roles: {
            cache: new Map(roles.map(item => [item.id, item])),
            highest: options.highest || [...roles].sort((left, right) => right.position - left.position)[0],
            async remove(roleIds) {
                calls.push([...roleIds]);
                if (typeof options.remove === "function") return await options.remove(roleIds);
                if (options.removeFails) throw new Error("remove failed");
                return null;
            }
        },
        calls
    };
    return output;
}

function guildFixture(options = {}) {
    const everyone = role(GUILD_ID, 0, { name: "@everyone" });
    const regular = role("100000000000000101", 1);
    const exempt = role("100000000000000102", 2);
    const managed = role("100000000000000103", 3, { managed: true });
    const botRole = role("100000000000000104", 10);
    const aboveBot = role("100000000000000105", 11);
    const actor = member(ACTOR_ID, [everyone, regular, exempt]);
    const target = member(TARGET_ID, [everyone, regular, exempt, managed]);
    const protectedMember = member("100000000000000005", [everyone, regular, aboveBot], { highest: aboveBot });
    const bot = member(BOT_ID, [everyone, regular], { bot: true });
    let botCanOperate = options.botCanOperate !== false;
    const me = member("100000000000000099", [everyone, botRole], { bot: true });
    me.permissionsIn = () => ({ has: () => botCanOperate });
    me.permissions = { has: () => botCanOperate };
    const members = new Map([
        [actor.id, actor],
        [target.id, target],
        [protectedMember.id, protectedMember],
        [bot.id, bot],
        [me.id, me]
    ]);
    const guild = {
        id: GUILD_ID,
        ownerId: options.ownerId || ACTOR_ID,
        memberCount: members.size,
        roles: { cache: new Map([everyone, regular, exempt, managed, botRole, aboveBot].map(item => [item.id, item])) },
        members: {
            me,
            cache: members,
            fetch: async () => members
        }
    };
    return {
        guild,
        members,
        everyone,
        regular,
        exempt,
        managed,
        botRole,
        aboveBot,
        actor,
        target,
        protectedMember,
        bot,
        me,
        setBotCanOperate: value => { botCanOperate = value; }
    };
}

function confirmationMessage(guild, actorId = ACTOR_ID, channelId = "channel") {
    const replies = [];
    return {
        guild,
        author: { id: actorId, bot: false },
        channel: { id: channelId },
        content: "ยืนยัน",
        replies,
        async reply(payload) { replies.push(payload); return payload; }
    };
}

test.afterEach(() => roleSweep._test.resetForTests());

test("shortcut parser accepts no IDs and deduplicates valid IDs", () => {
    assert.deepEqual(roleSweep._test.parseShortcutRoleIds("//รียศ"), { matched: true, roleIds: [] });
    assert.deepEqual(
        roleSweep._test.parseShortcutRoleIds("//รียศ 100000000000000101 100000000000000101 100000000000000102"),
        { matched: true, roleIds: ["100000000000000101", "100000000000000102"] }
    );
    assert.equal(roleSweep._test.parseShortcutRoleIds("//รียศ invalid").error, "รูปแบบ Role ID ไม่ถูกต้อง");
    assert.equal(roleSweep._test.parseShortcutRoleIds("//รียศอื่น").matched, false);
});

test("chat shortcut rejects role IDs that do not belong to the guild", async () => {
    const fixture = guildFixture();
    const replies = [];
    const message = {
        guild: fixture.guild,
        author: { id: ACTOR_ID, bot: false },
        channel: { id: "channel" },
        content: "//รียศ 100000000000000199",
        async reply(payload) { replies.push(payload); return payload; }
    };

    assert.equal(await roleSweep.handleMessage(message), true);
    assert.match(replies[0].content, /ไม่มีอยู่ในเซิร์ฟเวอร์/);
});

test("scan reports all human role assignments but targets only removable non-exempt roles", () => {
    const fixture = guildFixture();
    const scan = roleSweep._test.scanGuildRoles(fixture.guild, fixture.members, ACTOR_ID, [fixture.exempt.id]);

    assert.equal(scan.stats.totalRoles, 5);
    assert.equal(scan.stats.totalAssignments, 7);
    assert.equal(scan.targets.length, 1);
    assert.equal(scan.targets[0].member.id, TARGET_ID);
    assert.deepEqual(scan.targets[0].roleIds, [fixture.regular.id]);
});

test("scan skips explicitly unmanageable and equal-hierarchy members", () => {
    const fixture = guildFixture();
    const equalRole = role("100000000000000106", fixture.botRole.position);
    const unmanageable = member("100000000000000006", [fixture.everyone, fixture.regular], { manageable: false });
    const equalHierarchy = member("100000000000000007", [fixture.everyone, fixture.regular, equalRole], { highest: equalRole });
    fixture.guild.roles.cache.set(equalRole.id, equalRole);
    fixture.members.set(unmanageable.id, unmanageable);
    fixture.members.set(equalHierarchy.id, equalHierarchy);
    fixture.guild.memberCount = fixture.members.size;

    const scan = roleSweep._test.scanGuildRoles(fixture.guild, fixture.members, ACTOR_ID, [fixture.exempt.id]);
    assert.deepEqual(scan.targets.map(target => target.member.id), [TARGET_ID]);
});

test("a normal role named @everyone is counted and remains eligible for removal", () => {
    const fixture = guildFixture();
    const lookalike = role("100000000000000106", 4, { name: "@everyone" });
    fixture.guild.roles.cache.set(lookalike.id, lookalike);
    fixture.target.roles.cache.set(lookalike.id, lookalike);

    const scan = roleSweep._test.scanGuildRoles(fixture.guild, fixture.members, ACTOR_ID, [fixture.exempt.id]);

    assert.equal(scan.stats.totalRoles, 6);
    assert.equal(scan.stats.totalAssignments, 8);
    assert.deepEqual(scan.targets[0].roleIds, [fixture.regular.id, lookalike.id]);
});

test("fingerprint changes when a human member's role assignments change", () => {
    const fixture = guildFixture();
    const before = roleSweep._test.roleAssignmentFingerprint(fixture.guild, fixture.members);
    fixture.target.roles.cache.delete(fixture.regular.id);
    const after = roleSweep._test.roleAssignmentFingerprint(fixture.guild, fixture.members);
    assert.notEqual(before, after);
});

test("fingerprint changes when the bot hierarchy changes", () => {
    const fixture = guildFixture();
    const before = roleSweep._test.roleAssignmentFingerprint(fixture.guild, fixture.members);
    fixture.me.roles.cache.set(fixture.aboveBot.id, fixture.aboveBot);
    fixture.me.roles.highest = fixture.aboveBot;
    const after = roleSweep._test.roleAssignmentFingerprint(fixture.guild, fixture.members);
    assert.notEqual(before, after);
});

test("fingerprint changes when the role catalog changes", () => {
    const fixture = guildFixture();
    const before = roleSweep._test.roleAssignmentFingerprint(fixture.guild, fixture.members);
    fixture.regular.position = 4;
    const after = roleSweep._test.roleAssignmentFingerprint(fixture.guild, fixture.members);
    assert.notEqual(before, after);
});

test("preview performs no role mutation and confirmation removes the planned roles", async () => {
    const fixture = guildFixture();
    const responses = [];
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [fixture.exempt.id],
        respond: async content => responses.push(content)
    });

    assert.equal(fixture.target.calls.length, 0);
    assert.match(responses[0], /ยศทั้งหมด \(ไม่รวม @everyone\): \*\*5\*\*/);
    assert.match(responses[0], /ยศที่สมาชิกถือรวมแบบนับซ้ำ: \*\*7\*\*/);

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.deepEqual(fixture.target.calls, [[fixture.regular.id]]);
    assert.match(message.replies.at(-1).content, /กวาดยศเสร็จแล้ว/);
});

test("only the initiating owner can confirm in the original channel", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });

    assert.equal(await roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild, TARGET_ID)), false);
    assert.equal(await roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild, ACTOR_ID, "other-channel")), false);
    assert.equal(fixture.target.calls.length, 0);
});

test("confirmation requires the exact text with no surrounding whitespace", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });

    const whitespaceConfirmation = confirmationMessage(fixture.guild);
    whitespaceConfirmation.content = " ยืนยัน ";
    assert.equal(await roleSweep._test.handleConfirmation(whitespaceConfirmation), false);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), true);
    assert.equal(fixture.target.calls.length, 0);

    assert.equal(await roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild)), true);
});

test("pending confirmation expires without removing any role", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        timeoutMs: 1,
        respond: async () => {}
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(await roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild)), false);
    assert.equal(fixture.target.calls.length, 0);
});

test("confirmation checks the absolute deadline even before the timer callback runs", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    roleSweep._test.pendingByGuild.get(GUILD_ID).expiresAt = Date.now() - 1;

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.equal(fixture.target.calls.length, 0);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
    assert.match(message.replies.at(-1).content, /หมดเวลายืนยัน/);
});

test("a second role sweep cannot replace a pending sweep in the same guild", async () => {
    const fixture = guildFixture();
    const first = [];
    const second = [];
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => first.push(content)
    }), true);
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel-two" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => second.push(content)
    }), false);
    assert.match(second[0], /รอยืนยันหรือกำลังทำงานอยู่/);
});

test("a second role sweep is rejected while the first preview is still fetching", async () => {
    const fixture = guildFixture();
    let resolveFetch;
    fixture.guild.members.fetch = async () => await new Promise(resolve => { resolveFetch = resolve; });
    const first = roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    await Promise.resolve();
    const second = [];
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel-two" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => second.push(content)
    }), false);
    assert.match(second[0], /รอยืนยันหรือกำลังทำงานอยู่/);

    roleSweep.cleanupGuild(GUILD_ID);
    resolveFetch(fixture.members);
    assert.equal(await first, false);
    assert.deepEqual(roleSweep.getRuntimeDiagnostics(), { previewing: 0, pending: 0, active: 0 });
});

test("a failed preview delivery does not leave the guild locked", async () => {
    const fixture = guildFixture();
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => { throw new Error("delivery failed"); }
    }), false);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
});

test("a rejected member fetch aborts before creating a pending sweep", async () => {
    const fixture = guildFixture();
    const replies = [];
    fixture.guild.members.fetch = async () => { throw new Error("fetch failed"); };
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => replies.push(content)
    }), false);
    assert.match(replies.at(-1), /ดึงรายชื่อสมาชิกไม่ครบ/);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
});

test("incomplete or malformed member fetches abort before creating a pending sweep", async () => {
    const fixture = guildFixture();
    const replies = [];
    fixture.guild.members.fetch = async () => new Map([[fixture.actor.id, fixture.actor]]);
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => replies.push(content)
    }), false);
    assert.match(replies.at(-1), /ดึงรายชื่อสมาชิกไม่ครบ/);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
    assert.equal(fixture.target.calls.length, 0);

    fixture.guild.members.fetch = async () => ({ size: fixture.guild.memberCount });
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => replies.push(content)
    }), false);
    assert.match(replies.at(-1), /ดึงรายชื่อสมาชิกไม่ครบ/);
});

test("a member count change during the initial fetch aborts before preview", async () => {
    const fixture = guildFixture();
    const replies = [];
    fixture.guild.members.fetch = async () => {
        fixture.guild.memberCount++;
        return fixture.members;
    };
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => replies.push(content)
    }), false);
    assert.match(replies.at(-1), /ดึงรายชื่อสมาชิกไม่ครบ/);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
});

test("role changes after preview invalidate confirmation before any removal", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    fixture.target.roles.cache.delete(fixture.regular.id);

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.equal(fixture.target.calls.length, 0);
    assert.match(message.replies.at(-1).content, /ข้อมูลยศเปลี่ยนหลังพรีวิว/);
});

test("bot hierarchy changes after preview invalidate confirmation before any removal", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    fixture.me.roles.cache.set(fixture.aboveBot.id, fixture.aboveBot);
    fixture.me.roles.highest = fixture.aboveBot;

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.equal(fixture.target.calls.length, 0);
    assert.equal(fixture.protectedMember.calls.length, 0);
    assert.match(message.replies.at(-1).content, /ข้อมูลยศเปลี่ยนหลังพรีวิว/);
});

test("role catalog changes after preview invalidate confirmation before any removal", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    fixture.regular.position = 4;

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.equal(fixture.target.calls.length, 0);
    assert.match(message.replies.at(-1).content, /ข้อมูลยศเปลี่ยนหลังพรีวิว/);
});

test("a changed member count during the confirmation fetch aborts without removal", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    fixture.guild.members.fetch = async () => {
        fixture.guild.memberCount++;
        return fixture.members;
    };

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.equal(fixture.target.calls.length, 0);
    assert.equal(roleSweep._test.activeByGuild.has(GUILD_ID), false);
    assert.match(message.replies.at(-1).content, /ดึงรายชื่อสมาชิกใหม่ไม่สำเร็จ/);
});

test("a rejected confirmation fetch aborts without removal and releases the active lock", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    fixture.guild.members.fetch = async () => { throw new Error("fetch failed"); };

    const message = confirmationMessage(fixture.guild);
    assert.equal(await roleSweep._test.handleConfirmation(message), true);
    assert.equal(fixture.target.calls.length, 0);
    assert.equal(roleSweep._test.activeByGuild.has(GUILD_ID), false);
    assert.match(message.replies.at(-1).content, /ดึงรายชื่อสมาชิกใหม่ไม่สำเร็จ/);
});

test("chat shortcut is handled before the legacy Voice // command router", async () => {
    const fixture = guildFixture({ ownerId: "different-owner" });
    const original = voiceAdmin.handleSecretMessage;
    let voiceCalled = false;
    voiceAdmin.handleSecretMessage = async () => { voiceCalled = true; return false; };
    const message = {
        guild: fixture.guild,
        author: { id: config.system.ownerId, bot: false },
        channel: { id: "channel" },
        content: "//รียศ",
        async reply() { return null; }
    };
    try {
        assert.equal(await commands.handleMessage(message), true);
        assert.equal(voiceCalled, false);
        assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), true);
    } finally {
        voiceAdmin.handleSecretMessage = original;
    }
});

test("unrelated Voice // commands still reach the legacy Voice router", async () => {
    const fixture = guildFixture();
    const original = voiceAdmin.handleSecretMessage;
    let receivedContent = null;
    voiceAdmin.handleSecretMessage = async message => {
        receivedContent = message.content;
        return true;
    };
    const message = {
        guild: fixture.guild,
        author: { id: ACTOR_ID, bot: false },
        channel: { id: "channel" },
        content: "//legacy-voice-command"
    };
    try {
        assert.equal(await commands.handleMessage(message), true);
        assert.equal(receivedContent, "//legacy-voice-command");
    } finally {
        voiceAdmin.handleSecretMessage = original;
    }
});

test("chat shortcut rejects a bot without its required permissions", async () => {
    const fixture = guildFixture({ botCanOperate: false });
    const replies = [];
    const message = {
        guild: fixture.guild,
        author: { id: ACTOR_ID, bot: false },
        channel: { id: "channel" },
        content: "//รียศ",
        async reply(payload) { replies.push(payload); return payload; }
    };

    assert.equal(await roleSweep.handleMessage(message), true);
    assert.match(replies.at(-1).content, /MANAGE_ROLES/);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
});

test("configured bot owner can use the slash command outside a guild they own", async () => {
    const fixture = guildFixture({ ownerId: "different-guild-owner" });
    const calls = [];
    const interaction = {
        guild: fixture.guild,
        channel: { id: "channel" },
        user: { id: config.system.ownerId },
        member: { permissions: { has: () => true } },
        options: { getRole: () => null },
        isCommand: () => true,
        deferred: false,
        replied: false,
        async reply(payload) { calls.push(["reply", payload]); this.replied = true; },
        async deferReply(payload) { calls.push(["deferReply", payload]); this.deferred = true; },
        async editReply(payload) { calls.push(["editReply", payload]); }
    };

    await roleSweep.handleSlashCommand(interaction);
    assert.deepEqual(calls[0], ["deferReply", { ephemeral: true }]);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), true);
});

test("slash command reads all five selected exception roles", async () => {
    const fixture = guildFixture();
    const exceptions = [1, 2, 3, 4, 5].map(index => role(`10000000000000020${index}`, index + 3));
    for (const exception of exceptions) fixture.guild.roles.cache.set(exception.id, exception);
    const interaction = {
        guild: fixture.guild,
        channel: { id: "channel" },
        user: { id: ACTOR_ID },
        member: { permissions: { has: () => true } },
        options: { getRole: name => exceptions[Number(name.at(-1)) - 1] || null },
        isCommand: () => true,
        deferred: false,
        replied: false,
        async reply() { this.replied = true; },
        async deferReply() { this.deferred = true; },
        async editReply() {}
    };

    await roleSweep.handleSlashCommand(interaction);
    assert.deepEqual(roleSweep._test.pendingByGuild.get(GUILD_ID).exceptRoleIds, exceptions.map(role => role.id));
});

test("slash command deduplicates repeated exception roles", async () => {
    const fixture = guildFixture();
    const interaction = {
        guild: fixture.guild,
        channel: { id: "channel" },
        user: { id: ACTOR_ID },
        member: { permissions: { has: () => true } },
        options: { getRole: () => fixture.exempt },
        isCommand: () => true,
        deferred: false,
        replied: false,
        async reply() { this.replied = true; },
        async deferReply() { this.deferred = true; },
        async editReply() {}
    };

    await roleSweep.handleSlashCommand(interaction);
    assert.deepEqual(roleSweep._test.pendingByGuild.get(GUILD_ID).exceptRoleIds, [fixture.exempt.id]);
});

test("slash command is owner-only and accepts the selected exception roles", async () => {
    const fixture = guildFixture();
    const calls = [];
    const interaction = {
        guild: fixture.guild,
        channel: { id: "channel" },
        user: { id: ACTOR_ID },
        member: { permissions: { has: () => true } },
        options: { getRole: name => name === "except_role_1" ? fixture.exempt : null },
        isCommand: () => true,
        deferred: false,
        replied: false,
        async reply(payload) { calls.push(["reply", payload]); this.replied = true; },
        async deferReply(payload) { calls.push(["deferReply", payload]); this.deferred = true; },
        async editReply(payload) { calls.push(["editReply", payload]); }
    };

    await roleSweep.handleSlashCommand(interaction);
    assert.deepEqual(calls[0], ["deferReply", { ephemeral: true }]);
    assert.match(calls.at(-1)[1].content, /ยศที่สมาชิกถือรวมแบบนับซ้ำ/);
    assert.equal(roleSweep._test.pendingByGuild.get(GUILD_ID).exceptRoleIds[0], fixture.exempt.id);

    const denied = { ...interaction, user: { id: TARGET_ID }, deferred: false, replied: false };
    await roleSweep.handleSlashCommand(denied);
    assert.equal(calls.at(-1)[0], "reply");
});

test("slash router dispatches rerole to the dedicated handler", async () => {
    const original = roleSweep.handleSlashCommand;
    let dispatched = false;
    roleSweep.handleSlashCommand = async () => { dispatched = true; return "handled"; };
    try {
        assert.equal(await commands._test.handleSlashCommand({ commandName: "rerole" }), "handled");
        assert.equal(dispatched, true);
    } finally {
        roleSweep.handleSlashCommand = original;
    }
});

test("bot permissions are checked again before a confirmed sweep starts", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    fixture.setBotCanOperate(false);

    const message = confirmationMessage(fixture.guild);
    await roleSweep._test.handleConfirmation(message);
    assert.equal(fixture.target.calls.length, 0);
    assert.equal(roleSweep._test.activeByGuild.has(GUILD_ID), false);
    assert.match(message.replies.at(-1).content, /MANAGE_ROLES/);
});

test("slash command rejects a bot missing its required permissions before preview", async () => {
    const fixture = guildFixture({ botCanOperate: false });
    const calls = [];
    const interaction = {
        guild: fixture.guild,
        channel: { id: "channel" },
        user: { id: ACTOR_ID },
        member: { permissions: { has: () => true } },
        options: { getRole: () => null },
        isCommand: () => true,
        deferred: false,
        replied: false,
        async reply(payload) { calls.push(payload); this.replied = true; },
        async deferReply() { throw new Error("must not defer"); },
        async editReply() {}
    };

    await roleSweep.handleSlashCommand(interaction);
    assert.match(calls.at(-1).content, /MANAGE_ROLES/);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
});

test("slash command rejects an exception role that is no longer in the guild", async () => {
    const fixture = guildFixture();
    const missingRole = role("100000000000000199", 1);
    const calls = [];
    const interaction = {
        guild: fixture.guild,
        channel: { id: "channel" },
        user: { id: ACTOR_ID },
        member: { permissions: { has: () => true } },
        options: { getRole: () => missingRole },
        isCommand: () => true,
        deferred: false,
        replied: false,
        async reply(payload) { calls.push(["reply", payload]); this.replied = true; },
        async deferReply(payload) { calls.push(["deferReply", payload]); this.deferred = true; },
        async editReply(payload) { calls.push(["editReply", payload]); }
    };

    await roleSweep.handleSlashCommand(interaction);
    assert.equal(calls.at(-1)[0], "editReply");
    assert.match(calls.at(-1)[1].content, /ไม่มีอยู่ในเซิร์ฟเวอร์/);
    assert.equal(roleSweep._test.pendingByGuild.has(GUILD_ID), false);
});

test("a Discord removal failure is reported without leaving a running lock", async () => {
    const fixture = guildFixture();
    fixture.target.roles.remove = async () => { throw new Error("forbidden"); };
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });

    const message = confirmationMessage(fixture.guild);
    await roleSweep._test.handleConfirmation(message);
    assert.match(message.replies.at(-1).content, /ยศที่ถอดไม่สำเร็จ: \*\*2\*\*/);
    assert.equal(roleSweep._test.activeByGuild.has(GUILD_ID), false);
});

test("partial failures report failed assignments and keep one sequential request per member", async () => {
    const fixture = guildFixture();
    const extraRole = role("100000000000000106", 4);
    const successMember = member("100000000000000006", [fixture.everyone, fixture.regular, extraRole]);
    const failedMember = member("100000000000000007", [fixture.everyone, fixture.regular, extraRole], { removeFails: true });
    fixture.guild.roles.cache.set(extraRole.id, extraRole);
    fixture.members.set(successMember.id, successMember);
    fixture.members.set(failedMember.id, failedMember);
    fixture.guild.memberCount = fixture.members.size;

    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [fixture.exempt.id],
        respond: async () => {}
    });

    const message = confirmationMessage(fixture.guild);
    await roleSweep._test.handleConfirmation(message);
    assert.equal(fixture.target.calls.length, 1);
    assert.equal(successMember.calls.length, 1);
    assert.equal(failedMember.calls.length, 1);
    assert.match(message.replies.at(-1).content, /สมาชิกที่เปลี่ยนแปลง: \*\*2\*\*/);
    assert.match(message.replies.at(-1).content, /ยศที่ถอดสำเร็จ: \*\*3\*\*/);
    assert.match(message.replies.at(-1).content, /ยศที่ถอดไม่สำเร็จ: \*\*2\*\*/);
});

test("a second sweep is rejected while the active sweep is awaiting Discord", async () => {
    const fixture = guildFixture();
    let releaseRemoval;
    let removalStarted;
    const removalStartedPromise = new Promise(resolve => { removalStarted = resolve; });
    fixture.target.roles.remove = async roleIds => {
        fixture.target.calls.push([...roleIds]);
        removalStarted();
        await new Promise(resolve => { releaseRemoval = resolve; });
    };
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    const execution = roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild));
    await removalStartedPromise;

    const responses = [];
    assert.equal(await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "other-channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async content => responses.push(content)
    }), false);
    assert.match(responses.at(-1), /รอยืนยันหรือกำลังทำงานอยู่/);
    releaseRemoval();
    await execution;
    assert.equal(roleSweep._test.activeByGuild.has(GUILD_ID), false);
});

test("guild cleanup cancels an active sweep before the next member and clears all state", async () => {
    const fixture = guildFixture();
    const extraMember = member("100000000000000006", [fixture.everyone, fixture.regular]);
    fixture.members.set(extraMember.id, extraMember);
    fixture.guild.memberCount = fixture.members.size;
    let releaseRemoval;
    let removalStarted;
    const removalStartedPromise = new Promise(resolve => { removalStarted = resolve; });
    fixture.target.roles.remove = async roleIds => {
        fixture.target.calls.push([...roleIds]);
        removalStarted();
        await new Promise(resolve => { releaseRemoval = resolve; });
    };
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    const execution = roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild));
    await removalStartedPromise;
    roleSweep.cleanupGuild(GUILD_ID);
    releaseRemoval();
    await execution;
    assert.equal(extraMember.calls.length, 0);
    assert.deepEqual(roleSweep.getRuntimeDiagnostics(), { previewing: 0, pending: 0, active: 0 });
});

test("guild cleanup during preview delivery cannot recreate a pending sweep", async () => {
    const fixture = guildFixture();
    let releaseReply;
    let replyStarted;
    const replyStartedPromise = new Promise(resolve => { replyStarted = resolve; });
    const preview = roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {
            replyStarted();
            await new Promise(resolve => { releaseReply = resolve; });
        }
    });
    await replyStartedPromise;
    roleSweep.cleanupGuild(GUILD_ID);
    releaseReply();
    assert.equal(await preview, false);
    assert.deepEqual(roleSweep.getRuntimeDiagnostics(), { previewing: 0, pending: 0, active: 0 });
});

test("guild cleanup clears a pending sweep and prevents its later confirmation", async () => {
    const fixture = guildFixture();
    await roleSweep._test.startPreview({
        guild: fixture.guild,
        channel: { id: "channel" },
        actorId: ACTOR_ID,
        exceptRoleIds: [],
        respond: async () => {}
    });
    roleSweep.cleanupGuild(GUILD_ID);
    assert.equal(await roleSweep._test.handleConfirmation(confirmationMessage(fixture.guild)), false);
    assert.equal(fixture.target.calls.length, 0);
    assert.deepEqual(roleSweep.getRuntimeDiagnostics(), { previewing: 0, pending: 0, active: 0 });
});
