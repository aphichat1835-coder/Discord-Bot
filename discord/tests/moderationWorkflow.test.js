const assert = require("node:assert/strict");
const test = require("node:test");

const workflow = require("../commands/moderationWorkflow");

test("moderation workflow exposes action handlers", () => {
    assert.equal(typeof workflow.handleModerationCommand, "function");
    assert.equal(typeof workflow.ACTION_HANDLERS.ban, "function");
    assert.equal(typeof workflow.ACTION_HANDLERS.kick, "function");
    assert.equal(typeof workflow.ACTION_HANDLERS.timeout, "function");
});

test("moderation workflow reads full timeout input", () => {
    const interaction = {
        commandName: "timeout",
        options: {
            getMember: () => ({ id: "target1" }),
            getString: () => "reason",
            getInteger: () => 10
        }
    };
    const input = workflow.readFullModerationInput(interaction);
    assert.equal(input.action, "timeout");
    assert.equal(input.reason, "reason");
    assert.equal(input.duration.durationMs, 600000);
});

test("moderation workflow validates missing target reply", () => {
    const replies = [];
    const reply = workflow.rejectMissingTarget({ reply: body => replies.push(body) }, null);
    assert.equal(replies.length, 1);
    assert.equal(reply, 1);
});
