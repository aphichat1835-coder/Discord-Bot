"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ActivityType, ChannelType } = require("discord.js");
const {
    MessageButton,
    MessageEmbed,
    getLegacyChannelType,
    resolveActivityType,
    resolveChannelType
} = require("../core/discordCompat");

test("Discord v14 compatibility preserves existing component and embed payloads", () => {
    const button = new MessageButton()
        .setCustomId("compat_action")
        .setLabel("Compat")
        .setStyle("SUCCESS");
    const embed = new MessageEmbed().addField("สถานะ", "พร้อม", true);

    assert.equal(button.toJSON().style, 3);
    assert.equal(button.customId, "compat_action");
    assert.deepEqual(embed.toJSON().fields, [{ name: "สถานะ", value: "พร้อม", inline: true }]);
});

test("Discord v14 compatibility maps legacy channel and activity identifiers", () => {
    assert.equal(resolveChannelType("GUILD_TEXT"), ChannelType.GuildText);
    assert.equal(getLegacyChannelType(ChannelType.GuildVoice), "GUILD_VOICE");
    assert.equal(resolveActivityType("WATCHING"), ActivityType.Watching);
    assert.equal(resolveChannelType(12345), 12345);
});
