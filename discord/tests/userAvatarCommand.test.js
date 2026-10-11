"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const information = require("../commands/information");
const commands = require("../commands");
const config = require("../config.json");

function createMockUser({ id = "123456789012345678", username = "tester", avatar = null } = {}) {
    return {
        id,
        username,
        avatar,
        displayAvatarURL({ extension = "webp", size = 512, forceStatic = false } = {}) {
            if (!this.avatar) {
                return `https://cdn.discordapp.com/embed/avatars/0.${extension}`;
            }
            const isAnim = this.avatar.startsWith("a_");
            const ext = (!forceStatic && isAnim) ? "gif" : extension;
            return `https://cdn.discordapp.com/avatars/${this.id}/${this.avatar}.${ext}?size=${size}`;
        }
    };
}

test("buildAvatarEmbed sets primary color and image URL with no extraneous fields", () => {
    const staticUser = createMockUser({ avatar: "static_hash_123" });
    const embed = information._test.buildAvatarEmbed(staticUser);
    const json = embed.toJSON();

    assert.ok(json.image?.url);
    assert.match(json.image.url, /static_hash_123\.png\?size=4096/);
    assert.equal(json.title, undefined);
    assert.equal(json.description, undefined);
    assert.equal(json.fields, undefined);
    assert.equal(json.footer, undefined);
    assert.equal(json.thumbnail, undefined);
    assert.equal(json.author, undefined);
});

test("buildAvatarEmbed displays GIF for animated avatars", () => {
    const animUser = createMockUser({ avatar: "a_animated_hash_456" });
    const embed = information._test.buildAvatarEmbed(animUser);
    const json = embed.toJSON();

    assert.ok(json.image?.url);
    assert.match(json.image.url, /a_animated_hash_456\.gif\?size=4096/);
});

test("buildAvatarEmbed falls back to PNG for default avatar users", () => {
    const defaultUser = createMockUser({ avatar: null });
    const embed = information._test.buildAvatarEmbed(defaultUser);
    const json = embed.toJSON();

    assert.ok(json.image?.url);
    assert.match(json.image.url, /avatars\/0\.png/);
});

test("buildAvatarActionRow generates PNG, JPG, WEBP, and GIF link buttons", () => {
    const animUser = createMockUser({ avatar: "a_animated_789" });
    const rows = information._test.buildAvatarActionRow(animUser);

    assert.equal(rows.length, 1);
    const rowJson = rows[0].toJSON();
    assert.equal(rowJson.type, 1);
    assert.equal(rowJson.components.length, 4);

    const [pngBtn, jpgBtn, webpBtn, gifBtn] = rowJson.components;

    // Check PNG button
    assert.equal(pngBtn.type, 2);
    assert.equal(pngBtn.style, 5); // Link
    assert.equal(pngBtn.label, "PNG");
    assert.match(pngBtn.url, /\.png\?size=4096/);
    assert.equal(pngBtn.disabled, undefined);

    // Check JPG button
    assert.equal(jpgBtn.type, 2);
    assert.equal(jpgBtn.style, 5);
    assert.equal(jpgBtn.label, "JPG");
    assert.match(jpgBtn.url, /\.jpg\?size=4096/);
    assert.equal(jpgBtn.disabled, undefined);

    // Check WEBP button
    assert.equal(webpBtn.type, 2);
    assert.equal(webpBtn.style, 5);
    assert.equal(webpBtn.label, "WEBP");
    assert.match(webpBtn.url, /\.webp\?size=4096/);
    assert.equal(webpBtn.disabled, undefined);

    // Check GIF button for animated avatar (enabled)
    assert.equal(gifBtn.type, 2);
    assert.equal(gifBtn.style, 5);
    assert.equal(gifBtn.label, "GIF");
    assert.match(gifBtn.url, /\.gif\?size=4096/);
    assert.equal(gifBtn.disabled, false);
});

test("buildAvatarActionRow disables GIF button with safe static URL fallback when avatar is static", () => {
    const staticUser = createMockUser({ avatar: "static_hash_999" });
    const rows = information._test.buildAvatarActionRow(staticUser);
    const rowJson = rows[0].toJSON();

    const gifBtn = rowJson.components.find(btn => btn.label === "GIF");
    assert.ok(gifBtn);
    assert.equal(gifBtn.disabled, true);
    // Must NOT contain a broken fake .gif URL
    assert.doesNotMatch(gifBtn.url, /\.gif/);
    assert.match(gifBtn.url, /\.png\?size=4096/);
});

test("buildAvatarActionRow disables GIF button for default avatar users", () => {
    const defaultUser = createMockUser({ avatar: null });
    const rows = information._test.buildAvatarActionRow(defaultUser);
    const rowJson = rows[0].toJSON();

    const gifBtn = rowJson.components.find(btn => btn.label === "GIF");
    assert.ok(gifBtn);
    assert.equal(gifBtn.disabled, true);
    assert.doesNotMatch(gifBtn.url, /\.gif/);
});

test("resolveAvatarTarget uses interaction.user when no member option provided", async () => {
    const caller = createMockUser({ id: "111111111111111111", username: "caller" });
    const interaction = {
        user: caller,
        options: {
            getUser: () => null
        },
        client: {
            users: {
                fetch: (id) => Promise.resolve(id === caller.id ? caller : null)
            }
        }
    };

    const target = await information._test.resolveAvatarTarget(interaction);
    assert.equal(target.id, caller.id);
});

test("resolveAvatarTarget uses selected member user when provided", async () => {
    const caller = createMockUser({ id: "111111111111111111", username: "caller" });
    const selected = createMockUser({ id: "222222222222222222", username: "target" });
    const interaction = {
        user: caller,
        options: {
            getUser: (name) => name === "member" ? selected : null
        },
        client: {
            users: {
                fetch: (id) => Promise.resolve(id === selected.id ? selected : null)
            }
        }
    };

    const target = await information._test.resolveAvatarTarget(interaction);
    assert.equal(target.id, selected.id);
});

test("resolveAvatarTarget falls back gracefully if client fetch fails", async () => {
    const caller = createMockUser({ id: "111111111111111111", username: "caller" });
    const interaction = {
        user: caller,
        options: {
            getUser: () => null
        },
        client: {
            users: {
                fetch: () => Promise.reject(new Error("Network timeout"))
            }
        }
    };

    const target = await information._test.resolveAvatarTarget(interaction);
    assert.equal(target.id, caller.id);
});

test("handle routes /user avatar correctly and replies directly", async () => {
    const caller = createMockUser({ id: "111111111111111111", username: "caller", avatar: "a_anim_123" });
    let repliedPayload = null;
    let accepted = false;

    const interaction = {
        commandName: "user",
        isCommand: () => true,
        user: caller,
        options: {
            getSubcommand: () => "avatar",
            getUser: () => null
        },
        client: {
            users: {
                fetch: () => Promise.resolve(caller)
            }
        },
        reply(payload) {
            repliedPayload = payload;
            return Promise.resolve(payload);
        },
        __onCommandAccepted: () => {
            accepted = true;
        }
    };

    await information.handle(interaction);
    assert.equal(accepted, true);
    assert.ok(repliedPayload);
    assert.equal(repliedPayload.embeds.length, 1);
    assert.equal(repliedPayload.components.length, 1);
    assert.deepEqual(repliedPayload.allowedMentions, { parse: [] });

    const embedJson = repliedPayload.embeds[0].toJSON();
    assert.match(embedJson.image.url, /a_anim_123\.gif/);
});

test("commands router delegates /user to information handler", () => {
    const handler = commands._test.delegatedCommandHandler("user");
    assert.equal(handler, information.handle);
});

test("handleUser returns null for unknown subcommand", async () => {
    const interaction = {
        options: {
            getSubcommand: () => "unknown"
        }
    };
    const result = await information._test.handleUser(interaction);
    assert.equal(result, null);
});
