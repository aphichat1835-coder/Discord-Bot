const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const utility = require("../commands/utility");

function interactionFixture({
    administrator,
    memberCanMention = true,
    botCanSend = true,
    botCanMention = true,
    message = "hello"
}) {
    const replies = [];
    const sent = [];
    const edits = [];
    const channel = {
        id: "32345678901234567",
        send: async value => sent.push(value)
    };
    const interaction = {
        commandName: "say",
        deferred: false,
        replied: false,
        options: { getString: () => message },
        user: { id: "22345678901234567" },
        member: {
            permissions: {
                has: permission => (permission === PermissionFlagsBits.Administrator && administrator) ||
                    (permission === PermissionFlagsBits.MentionEveryone && memberCanMention)
            }
        },
        channel,
        guild: {
            id: "12345678901234567",
            roles: { cache: new Map() },
            members: {
                me: {
                    permissionsIn: () => ({
                        permissions: {
                            has: permission => (botCanSend && [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel].includes(permission)) ||
                                (permission === PermissionFlagsBits.MentionEveryone && botCanMention)
                        }
                    })
                }
            },
            channels: { cache: new Map() }
        },
        reply: async payload => {
            replies.push(payload);
            interaction.replied = true;
        },
        deferReply: async () => {
            interaction.deferred = true;
        },
        editReply: async payload => edits.push(payload)
    };
    return { interaction, replies, sent, edits };
}

test("say rejects non-administrators without sending a message", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const fixture = interactionFixture({ administrator: false });

    await utility._test.handleSay(fixture.interaction);

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.replies.length, 1);
    assert.match(fixture.replies[0].content, /Administrator/);
    assert.equal(fixture.replies[0].ephemeral, true);
});

test("say preserves bot permission checks for administrators", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const fixture = interactionFixture({ administrator: true, botCanSend: false });

    await utility._test.handleSay(fixture.interaction);

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.replies.length, 1);
    assert.match(fixture.replies[0].content, /SEND_MESSAGES/);
});

test("say rejects mass mentions when the administrator lacks MentionEveryone", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const fixture = interactionFixture({ administrator: true, memberCanMention: false, message: "@everyone hello" });

    await utility._test.handleSay(fixture.interaction);

    assert.equal(fixture.sent.length, 0);
    assert.match(fixture.replies[0].content, /ไม่มีสิทธิ์ Mention/);
});

test("say rejects mass mentions when the bot lacks MentionEveryone", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const fixture = interactionFixture({ administrator: true, botCanMention: false, message: "@here hello" });

    await utility._test.handleSay(fixture.interaction);

    assert.equal(fixture.sent.length, 0);
    assert.match(fixture.replies[0].content, /บอทไม่มีสิทธิ์ Mention/);
});

test("say preserves and sends authorized administrator messages", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const fixture = interactionFixture({ administrator: true, message: "@everyone hello" });

    await utility._test.handleSay(fixture.interaction);

    assert.deepEqual(fixture.sent, [{
        content: "@everyone hello",
        allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
    }]);
    assert.equal(fixture.edits.length, 1);
    assert.match(fixture.edits[0].content, /ส่งเรียบร้อย/);
});
