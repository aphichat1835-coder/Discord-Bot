"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");

const {
    getElevatedMentionRequirement,
    requireMemberPermission,
    requireBotPermission
} = require("../guards/commandGuards");

function fixture({ content, memberPermissions = [], botPermissions = [], role = null }) {
    const replies = [];
    const channel = {};
    const roles = new Map();
    if (role) roles.set(role.id, role);
    const interaction = {
        commandName: "announce",
        deferred: false,
        replied: false,
        options: {
            getString(name) {
                if (name === "content") return content;
                return name === "title" ? "title" : "message";
            }
        },
        member: { permissions: new PermissionsBitField(memberPermissions) },
        channel,
        guild: {
            roles: { cache: roles },
            members: {
                me: {
                    permissionsIn: () => new PermissionsBitField(botPermissions)
                }
            }
        },
        async reply(payload) {
            replies.push(payload);
            this.replied = true;
        },
        async followUp(payload) {
            replies.push(payload);
        },
        async editReply(payload) {
            replies.push(payload);
        }
    };
    return { interaction, replies, channel };
}

const BASE_MEMBER = [PermissionFlagsBits.ManageMessages];
const BASE_BOT = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks];

test("announce mass mentions require the caller MentionEveryone permission", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { interaction, replies } = fixture({
        content: "@everyone update",
        memberPermissions: BASE_MEMBER,
        botPermissions: [...BASE_BOT, PermissionFlagsBits.MentionEveryone]
    });

    assert.equal(getElevatedMentionRequirement(interaction), "everyone");
    assert.equal(await requireMemberPermission(interaction, PermissionFlagsBits.ManageMessages, "missing"), false);
    assert.match(replies[0].content, /ไม่มีสิทธิ์ Mention/);
});

test("announce mass mentions require the bot MentionEveryone permission", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { interaction, replies, channel } = fixture({
        content: "@here update",
        memberPermissions: [...BASE_MEMBER, PermissionFlagsBits.MentionEveryone],
        botPermissions: BASE_BOT
    });

    assert.equal(await requireMemberPermission(interaction, PermissionFlagsBits.ManageMessages, "missing"), true);
    assert.equal(await requireBotPermission(interaction, BASE_BOT, "missing bot", channel), false);
    assert.match(replies[0].content, /บอทไม่มีสิทธิ์ Mention/);
});

test("mentionable roles and normal user mentions do not require elevated permission", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const roleId = "42345678901234567";
    const { interaction, channel } = fixture({
        content: `<@&${roleId}> <@22345678901234567> update`,
        memberPermissions: BASE_MEMBER,
        botPermissions: BASE_BOT,
        role: { id: roleId, mentionable: true }
    });

    assert.equal(getElevatedMentionRequirement(interaction), null);
    assert.equal(await requireMemberPermission(interaction, PermissionFlagsBits.ManageMessages, "missing"), true);
    assert.equal(await requireBotPermission(interaction, BASE_BOT, "missing bot", channel), true);
});

test("non-mentionable roles require elevated permission", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const roleId = "42345678901234567";
    const { interaction } = fixture({
        content: `<@&${roleId}> update`,
        memberPermissions: BASE_MEMBER,
        botPermissions: BASE_BOT,
        role: { id: roleId, mentionable: false }
    });

    assert.equal(getElevatedMentionRequirement(interaction), "role");
});
