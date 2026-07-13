const assert = require("node:assert/strict");
const test = require("node:test");

const utility = require("../commands/utility");

function interactionFixture({ administrator, botCanSend = true, message = "hello" }) {
    const replies = [];
    const sent = [];
    const edits = [];
    const channel = {
        id: "32345678901234567",
        send: async value => sent.push(value)
    };
    const interaction = {
        deferred: false,
        replied: false,
        options: { getString: () => message },
        user: { id: "22345678901234567" },
        member: { permissions: { has: permission => permission === "ADMINISTRATOR" && administrator } },
        channel,
        guild: {
            id: "12345678901234567",
            members: {
                me: {
                    permissionsIn: () => ({
                        permissions: {
                            has: permission => botCanSend && ["SEND_MESSAGES", "VIEW_CHANNEL"].includes(permission)
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

test("say rejects non-administrators without sending a message", async () => {
    const fixture = interactionFixture({ administrator: false });

    await utility._test.handleSay(fixture.interaction);

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.replies.length, 1);
    assert.match(fixture.replies[0].content, /Administrator/);
    assert.equal(fixture.replies[0].ephemeral, true);
});

test("say preserves bot permission checks for administrators", async () => {
    const fixture = interactionFixture({ administrator: true, botCanSend: false });

    await utility._test.handleSay(fixture.interaction);

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.replies.length, 1);
    assert.match(fixture.replies[0].content, /SEND_MESSAGES/);
});

test("say sanitizes and sends administrator messages", async () => {
    const fixture = interactionFixture({ administrator: true, message: "@everyone hello" });

    await utility._test.handleSay(fixture.interaction);

    assert.deepEqual(fixture.sent, ["@\u200beveryone hello"]);
    assert.equal(fixture.edits.length, 1);
    assert.match(fixture.edits[0].content, /ส่งเรียบร้อย/);
});
