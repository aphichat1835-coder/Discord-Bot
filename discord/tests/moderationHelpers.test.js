const assert = require("node:assert/strict");
const test = require("node:test");

const helpers = require("../commands/moderationHelpers");
const moderation = require("../commands/moderation");
const config = require("../config.json");

test("moderation helpers map required permissions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(helpers.requiredModerationPermission("ban"), "BAN_MEMBERS");
    assert.equal(helpers.requiredModerationPermission("kick"), "KICK_MEMBERS");
    assert.equal(helpers.requiredModerationPermission("timeout"), "MODERATE_MEMBERS");
});

test("moderation helpers parse timeout duration", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = { options: { getInteger: () => 15 } };
    const result = helpers.parseTimeoutDuration(interaction, "timeout");
    assert.equal(result.ok, true);
    assert.equal(result.minutes, 15);
    assert.equal(result.durationMs, 900000);
});

test("moderation helpers build case input", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const input = helpers.buildCaseInput(
        {
            guild: { id: "guild1" },
            user: { id: "mod1", tag: "mod#0001" },
            channel: { id: "channel1" }
        },
        { id: "target1", user: { tag: "target#0001" } },
        "timeout",
        "reason",
        60000
    );
    assert.equal(input.guildId, "guild1");
    assert.equal(input.userId, "target1");
    assert.equal(input.metadata.dmSent, undefined);
    assert.equal(input.evidence.some(item => item.includes("DM sent")), false);
});

test("moderation helpers avoid exposing raw exception messages", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(
        helpers.moderationErrorReply(new Error("database password leaked")),
        `> ${config.emojis.error} ไม่สามารถดำเนินการได้ โปรดลองอีกครั้งหรือติดต่อผู้ดูแลระบบ`
    );
    assert.equal(
        helpers.moderationErrorReply(new Error("MISSING_PERMS")),
        `> ${config.emojis.error} บอทไม่มีสิทธิ์ที่จำเป็น!`
    );
});

test("voice kick result state distinguishes complete, partial, and failed", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(moderation._test.voiceKickResultState({ kicked: ["<@1>"], failed: 0, timedOut: false }, 1), "complete");
    assert.equal(moderation._test.voiceKickResultState({ kicked: ["<@1>"], failed: 1, timedOut: false }, 2), "partial");
    assert.equal(moderation._test.voiceKickResultState({ kicked: [], failed: 1, timedOut: false }, 1), "failed");
    assert.equal(moderation._test.voiceKickResultState({ kicked: [], failed: 0, timedOut: false }, 0), "no_target");
});

test("voice kick processing skips administrators and counts disconnect failures", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const disconnected = [];
    const member = (id, administrator, fails = false) => ({
        id,
        permissions: { has: permission => permission === "ADMINISTRATOR" && administrator },
        voice: {
            disconnect: async () => {
                if (fails) throw new Error("disconnect failed");
                disconnected.push(id);
            }
        }
    });
    const result = await moderation._test.disconnectVoiceMembers(
        [member("admin", true), member("ok", false), member("failed", false, true)],
        { pause: async () => {}, yieldTurn: async () => {} }
    );

    assert.deepEqual(disconnected, ["ok"]);
    assert.deepEqual(result, { kicked: ["<@ok>"], failed: 1, timedOut: false });
});
