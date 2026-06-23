const assert = require("node:assert/strict");
const test = require("node:test");

const helpers = require("../commands/moderationHelpers");

test("moderation helpers map required permissions", () => {
    assert.equal(helpers.requiredModerationPermission("ban"), "BAN_MEMBERS");
    assert.equal(helpers.requiredModerationPermission("kick"), "KICK_MEMBERS");
    assert.equal(helpers.requiredModerationPermission("timeout"), "MODERATE_MEMBERS");
});

test("moderation helpers parse timeout duration", () => {
    const interaction = { options: { getInteger: () => 15 } };
    const result = helpers.parseTimeoutDuration(interaction, "timeout");
    assert.equal(result.ok, true);
    assert.equal(result.minutes, 15);
    assert.equal(result.durationMs, 900000);
});

test("moderation helpers build case input", () => {
    const input = helpers.buildCaseInput(
        {
            guild: { id: "guild1" },
            user: { id: "mod1", tag: "mod#0001" },
            channel: { id: "channel1" }
        },
        { id: "target1", user: { tag: "target#0001" } },
        "timeout",
        "reason",
        60000,
        true
    );
    assert.equal(input.guildId, "guild1");
    assert.equal(input.userId, "target1");
    assert.equal(input.metadata.dmSent, true);
});
