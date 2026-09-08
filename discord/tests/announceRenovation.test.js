"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");
const utility = require("../commands/utility");

const {
    handleAnnounce,
    buildAnnouncementEmbed,
    buildAnnouncementComponents,
    isValidHttpUrl,
    resolveEmbedColor
} = utility._test;

test("announce isValidHttpUrl validates protocols properly", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(isValidHttpUrl("https://example.com"), true);
    assert.equal(isValidHttpUrl("http://example.com/path?q=1"), true);
    assert.equal(isValidHttpUrl("ftp://example.com"), false);
    assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
    assert.equal(isValidHttpUrl("invalid-string"), false);
    assert.equal(isValidHttpUrl(null), false);
    assert.equal(isValidHttpUrl(""), false);
});

test("announce resolveEmbedColor resolves hex and fallbacks", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(resolveEmbedColor("#FF5500", "#5865F2"), "#FF5500");
    assert.equal(resolveEmbedColor("00FFAA", "#5865F2"), "#00FFAA");
    assert.equal(resolveEmbedColor("invalid", "#5865F2"), "#5865F2");
    assert.equal(resolveEmbedColor(null, "#5865F2"), "#5865F2");
});

test("announce buildAnnouncementEmbed constructs rich embed matching all options", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const embed = buildAnnouncementEmbed({
        messageText: "Hello world\nSecond line",
        title: "Announcement Title",
        colorHex: "#123456",
        url: "https://example.com/news",
        authorName: "Staff Team",
        authorIcon: "https://example.com/author.png",
        thumbnailUrl: "https://example.com/thumb.png",
        imageUrl: "https://example.com/banner.png",
        footerText: "Community Server",
        footerIcon: "https://example.com/footer.png",
        timestamp: true
    }).toJSON();

    assert.equal(embed.description, "Hello world\nSecond line");
    assert.equal(embed.title, "Announcement Title");
    assert.equal(embed.url, "https://example.com/news");
    assert.equal(embed.color, 0x123456);
    assert.equal(embed.author.name, "Staff Team");
    assert.equal(embed.author.icon_url, "https://example.com/author.png");
    assert.equal(embed.thumbnail.url, "https://example.com/thumb.png");
    assert.equal(embed.image.url, "https://example.com/banner.png");
    assert.equal(embed.footer.text, "Community Server");
    assert.equal(embed.footer.icon_url, "https://example.com/footer.png");
    assert.ok(embed.timestamp);
});

test("announce buildAnnouncementComponents returns link button when valid", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const rows = buildAnnouncementComponents("Click Here", "https://discord.gg/test");
    assert.equal(rows.length, 1);
    const json = rows[0].toJSON();
    assert.equal(json.components.length, 1);
    assert.equal(json.components[0].label, "Click Here");
    assert.equal(json.components[0].style, 5); // Link button
    assert.equal(json.components[0].url, "https://discord.gg/test");

    assert.deepEqual(buildAnnouncementComponents(null, "https://example.com"), []);
    assert.deepEqual(buildAnnouncementComponents("Click", "invalid"), []);
});

test("announce handleAnnounce sends announcement to specified target channel", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sentMessages = [];
    const targetChannel = {
        id: "channel999",
        send: async payload => {
            sentMessages.push(payload);
            return { id: "msg123", url: "https://discord.com/channels/1/channel999/msg123" };
        }
    };

    const replies = [];
    const editReplies = [];
    const interaction = {
        commandName: "announce",
        channel: { id: "channelCurrent" },
        member: { permissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.MentionEveryone]) },
        guild: {
            id: "guild1",
            name: "My Server",
            members: {
                me: {
                    permissionsIn: () => new PermissionsBitField([
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.MentionEveryone
                    ])
                }
            }
        },
        options: {
            getChannel: name => (name === "channel" ? targetChannel : null),
            getString: name => {
                const map = {
                    message: "Custom Announcement Message",
                    title: "Special Update",
                    content: "@everyone Check this out",
                    button_text: "Join Now",
                    button_url: "https://discord.gg/join"
                };
                return map[name] || null;
            },
            getBoolean: name => (name === "timestamp" ? true : false)
        },
        reply: async body => replies.push(body),
        deferReply: async () => true,
        editReply: async body => editReplies.push(body)
    };

    await handleAnnounce(interaction);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].content, "@everyone Check this out");
    assert.equal(sentMessages[0].embeds.length, 1);
    assert.equal(sentMessages[0].components.length, 1);
    assert.equal(editReplies.length, 1);
    assert.match(editReplies[0].content, /channel999/);
    assert.match(editReplies[0].content, /เปิดดูข้อความ/);
});

test("announce handleAnnounce rejects caller without ManageGuild or Administrator", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const replies = [];
    const interaction = {
        commandName: "announce",
        channel: { id: "c1" },
        member: { permissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages]) },
        guild: {
            id: "guild1",
            members: { me: { permissionsIn: () => new PermissionsBitField([PermissionFlagsBits.Administrator]) } }
        },
        options: {
            getChannel: () => null,
            getString: () => "message"
        },
        reply: async body => replies.push(body)
    };

    await handleAnnounce(interaction);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /จัดการเซิร์ฟเวอร์/);
});
