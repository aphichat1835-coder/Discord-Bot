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
    assert.equal(result.dmSent, true);
    assert.equal(result.caseCompleted, false);
    assert.equal(result.caseDoc.caseNumber, 8);
});

test("moderation workflow marks the pending case failed when Discord action fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const updates = [];
    const actionError = new Error("discord failed");
    actionError.moderationDmSent = true;
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
        metadata: { actionApplied: false, dmSent: true, failureCode: "action_failed" }
    }]);
});

function makeModerationActionHarness(actionFails = false) {
    const order = [];
    const edits = [];
    const message = {
        edit: async payload => {
            order.push("dm_final");
            edits.push(payload);
            return message;
        }
    };
    const user = {
        id: "111111111111111111",
        username: "target",
        globalName: "Target",
        discriminator: "0",
        displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
        send: async payload => {
            order.push("dm_pending");
            return Object.assign(message, { initialPayload: payload });
        }
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
    return { order, edits, message, interaction, input };
}

test("ban DM starts pending and is confirmed only after Discord succeeds", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeModerationActionHarness();
    const dmSent = await workflow.applyBan(harness.interaction, harness.input, { caseNumber: 10 });

    assert.equal(dmSent, true);
    assert.deepEqual(harness.order, ["dm_pending", "discord_action", "dm_final"]);
    assert.match(JSON.stringify(harness.message.initialPayload), /ยังไม่ยืนยันผล/);
    assert.match(JSON.stringify(harness.edits[0]), /ยืนยันแล้ว.*สำเร็จ/);
});

test("failed ban edits the pending DM to say the action had no effect", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const harness = makeModerationActionHarness(true);
    await assert.rejects(
        workflow.applyBan(harness.interaction, harness.input, { caseNumber: 11 }),
        /discord failed/
    );

    assert.deepEqual(harness.order, ["dm_pending", "discord_action", "dm_final"]);
    assert.match(JSON.stringify(harness.edits[0]), /คำสั่งครั้งนี้จึงไม่มีผล/);
});
