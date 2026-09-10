const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const helpers = require("../commands/moderationHelpers");
const config = require("../config.json");

test("moderation helpers map required permissions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(helpers.requiredModerationPermission("ban"), PermissionFlagsBits.BanMembers);
    assert.equal(helpers.requiredModerationPermission("kick"), PermissionFlagsBits.KickMembers);
    assert.equal(helpers.requiredModerationPermission("timeout"), PermissionFlagsBits.ModerateMembers);
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

test("moderation success reply no longer reports member DM delivery", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const embed = helpers.buildModerationReplyEmbed(
        {
            guild: { iconURL: () => null },
            user: { id: "mod1", tag: "mod#0001" }
        },
        {
            id: "target1",
            user: { displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" }
        },
        "ban",
        "reason",
        42
    ).toJSON();

    assert.doesNotMatch(embed.description, /DM:/);
    assert.match(embed.description, /Case:.*42/);
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

test("moderation helpers support timeout units and auto-clamp to 28 days", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const hoursInteraction = {
        options: {
            getInteger: name => (name === "duration" ? 2 : null),
            getString: name => (name === "unit" ? "hours" : null)
        }
    };
    const hoursRes = helpers.parseTimeoutDuration(hoursInteraction, "timeout");
    assert.equal(hoursRes.ok, true);
    assert.equal(hoursRes.durationMs, 2 * 60 * 60 * 1000);
    assert.equal(hoursRes.minutes, 120);
    assert.equal(hoursRes.clamped, false);

    const clampInteraction = {
        options: {
            getInteger: name => (name === "duration" ? 50 : null),
            getString: name => (name === "unit" ? "days" : null)
        }
    };
    const clampRes = helpers.parseTimeoutDuration(clampInteraction, "timeout");
    assert.equal(clampRes.ok, true);
    assert.equal(clampRes.clamped, true);
    assert.equal(clampRes.durationMs, 28 * 24 * 60 * 60 * 1000);

    const untimeoutInteraction = {
        options: {
            getInteger: name => (name === "duration" ? 0 : null)
        }
    };
    const untimeoutRes = helpers.parseTimeoutDuration(untimeoutInteraction, "timeout");
    assert.equal(untimeoutRes.ok, true);
    assert.equal(untimeoutRes.isUntimeout, true);
    assert.equal(untimeoutRes.durationMs, null);
});

test("moderation helpers format delete seconds accurately", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(helpers.formatDeleteSeconds(0), "ไม่ลบข้อความ");
    assert.equal(helpers.formatDeleteSeconds(3600), "1 ชั่วโมง");
    assert.equal(helpers.formatDeleteSeconds(86400), "1 วัน");
    assert.equal(helpers.formatDeleteSeconds(604800), "7 วัน");
});

test("moderation helpers build rich reply embeds with appropriate colors and titles", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = {
        guild: { name: "Test Server", iconURL: () => "https://example.com/icon.png" },
        user: { id: "mod1", tag: "Mod#0001", displayAvatarURL: () => "https://example.com/mod.png" }
    };
    const target = {
        id: "target1",
        user: { tag: "Target#0002", displayAvatarURL: () => "https://example.com/user.png" }
    };

    const banEmbed = helpers.buildModerationReplyEmbed(interaction, target, "ban", "spamming", 101, {
        deleteMessageSeconds: 86400
    }).toJSON();
    assert.match(banEmbed.author.name, /แบน/);
    assert.match(banEmbed.description, /ลบข้อความ.*1 วัน/);

    const untimeoutEmbed = helpers.buildModerationReplyEmbed(interaction, target, "timeout", "reformed", 102, {
        isUntimeout: true
    }).toJSON();
    assert.match(untimeoutEmbed.author.name, /ปลดระงับ/);
    assert.match(untimeoutEmbed.description, /UNTIMEOUT/);
});

