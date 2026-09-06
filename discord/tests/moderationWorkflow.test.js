const assert = require("node:assert/strict");
const test = require("node:test");

const workflow = require("../commands/moderationWorkflow");

test("moderation workflow exposes action handlers", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(typeof workflow.handleModerationCommand, "function");
    assert.equal(typeof workflow.ACTION_HANDLERS.ban, "function");
    assert.equal(typeof workflow.ACTION_HANDLERS.kick, "function");
    assert.equal(typeof workflow.ACTION_HANDLERS.timeout, "function");
});

test("moderation workflow reads full timeout input", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = {
        commandName: "timeout",
        options: {
            getMember: key => {
                assert.equal(key, "target");
                return { id: "target1" };
            },
            getString: key => {
                assert.equal(key, "reason");
                return "reason";
            },
            getInteger: key => {
                assert.equal(key, "minutes");
                return 10;
            }
        }
    };
    const input = workflow.readFullModerationInput(interaction);
    assert.equal(input.action, "timeout");
    assert.equal(input.reason, "reason");
    assert.equal(input.duration.durationMs, 600000);
});

test("moderation workflow validates missing target reply", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const replies = [];
    const reply = workflow.rejectMissingTarget({ reply: body => replies.push(body) }, null);
    assert.equal(replies.length, 1);
    assert.equal(reply, 1);
});

test("ban validation uses Discord bannable state before creating a case", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const replies = [];
    const interaction = { reply: body => replies.push(body) };

    const rejected = workflow.rejectUnmanageableTarget(
        interaction,
        { manageable: false, bannable: false },
        "ban"
    );
    assert.equal(replies.length, 1);
    assert.equal(rejected, 1);
    assert.match(replies[0].content, /ไม่สามารถแบน/);

    const allowed = workflow.rejectUnmanageableTarget(
        interaction,
        { manageable: false, bannable: true },
        "ban"
    );
    assert.equal(allowed, null);
});

test("moderation workflow persists pending case before applying action", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const order = [];
    const interaction = { guild: { id: "guild1" } };
    const input = { action: "ban" };
    const result = await workflow.performModeration(interaction, input, {
        createCase: async () => {
            order.push("pending");
            return { guildId: "guild1", caseNumber: 7, metadata: {} };
        },
        applyAction: async () => {
            order.push("action");
            return true;
        },
        updateStatus: async (_guildId, _caseNumber, status) => {
            order.push(status);
            return { guildId: "guild1", caseNumber: 7, status, metadata: {} };
        },
        sendCaseLog: async () => true
    });
    assert.deepEqual(order, ["pending", "action", "completed"]);
    assert.equal(result.caseCompleted, true);
});

test("moderation workflow does not apply action when pending persistence fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let actionCalled = false;
    await assert.rejects(workflow.performModeration({ guild: { id: "guild1" } }, { action: "kick" }, {
        createCase: async () => { throw new Error("db unavailable"); },
        applyAction: async () => { actionCalled = true; },
        sendCaseLog: async () => true
    }), /db unavailable/);
    assert.equal(actionCalled, false);
});

test("moderation workflow reports a successful action with pending reconciliation", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = await workflow.performModeration({ guild: { id: "guild1" } }, { action: "timeout" }, {
        createCase: async () => ({ guildId: "guild1", caseNumber: 8, metadata: {} }),
        applyAction: async () => true,
        updateStatus: async () => null,
        sendCaseLog: async () => true
    });
    assert.equal(result.dmSent, undefined);
    assert.equal(result.caseCompleted, false);
    assert.equal(result.caseDoc.caseNumber, 8);
    assert.equal(result.caseDoc.metadata.dmSent, undefined);
});

test("moderation workflow marks the pending case failed when Discord action fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const updates = [];
    const actionError = new Error("discord failed");
    await assert.rejects(workflow.performModeration({ guild: { id: "guild1" } }, { action: "ban" }, {
        createCase: async () => ({ guildId: "guild1", caseNumber: 9, metadata: {} }),
        applyAction: async () => { throw actionError; },
        updateStatus: async (_guildId, _caseNumber, status, metadata) => {
            updates.push({ status, metadata });
            return { status };
        },
        sendCaseLog: async () => true
    }), /discord failed/);
    assert.deepEqual(updates, [{
        status: "failed",
        metadata: { actionApplied: false, failureCode: "action_failed" }
    }]);
});

function makeModerationActionHarness(actionFails = false) {
    const order = [];
    const user = {
        id: "111111111111111111",
        username: "target",
        globalName: "Target",
        discriminator: "0",
        displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
        send: async () => { throw new Error("member DM must not be sent"); }
    };
    const target = {
        id: user.id,
        user,
        ban: async () => {
            order.push("discord_action");
            if (actionFails) throw new Error("discord failed");
        }
    };
    const interaction = {
        guild: {
            id: "222222222222222222",
            name: "Guild",
            members: { me: { permissions: { has: () => true } } }
        },
        user: { id: "333333333333333333", tag: "moderator" }
    };
    const input = {
        target,
        action: "ban",
        reason: "reason",
        duration: { minutes: null, durationMs: null }
    };
    return { order, interaction, input };
}

test("ban succeeds without sending a member DM", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeModerationActionHarness();
    await workflow.applyBan(harness.interaction, harness.input, { caseNumber: 10 });

    assert.deepEqual(harness.order, ["discord_action"]);
});

test("failed ban preserves the Discord failure without sending a member DM", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeModerationActionHarness(true);
    await assert.rejects(
        workflow.applyBan(harness.interaction, harness.input, { caseNumber: 11 }),
        /discord failed/
    );

    assert.deepEqual(harness.order, ["discord_action"]);
});

test("kick and timeout never send a member DM", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const calls = [];
    const target = {
        id: "111111111111111111",
        user: { send: async () => { throw new Error("member DM must not be sent"); } },
        kick: async reason => calls.push(`kick:${reason}`),
        timeout: async (duration, reason) => calls.push(`timeout:${duration}:${reason}`)
    };
    const interaction = { guild: { members: { me: { permissions: { has: () => true } } } } };
    const input = { target, reason: "reason", duration: { durationMs: 60_000, minutes: 1 } };

    await workflow.applyKick(interaction, input, { caseNumber: 12 });
    await workflow.applyTimeout(interaction, input, { caseNumber: 13 });

    assert.deepEqual(calls, ["kick:reason", "timeout:60000:reason"]);
});
