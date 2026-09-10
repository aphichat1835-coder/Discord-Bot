const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const utility = require("../commands/utility");
const {
    handleSteal,
    parseCustomEmojis,
    calculateEmojiQuotas,
    checkSmartEmojiQuota,
    renderEmojiProgressBar,
    buildEmojiNoticeEmbed,
    buildEmojiProgressEmbed,
    buildEmojiResultEmbed,
    formatEmojiShowcase,
    formatFailedEmojiList,
    formatSkippedEmojiList,
    activeEmojiCopies
} = utility._test;

function createInteractionFixture({
    administrator = true,
    botManageGuildExpressions = true,
    emojisText = "<:doge:123456789012345678> <a:dance:234567890123456789>",
    tier = 0,
    staticEmojis = [],
    animatedEmojis = [],
    createEmojiImpl = async payload => ({ id: "999999999", name: payload.name, animated: false })
}) {
    const replies = [];
    const edits = [];
    const staticMap = new Map(staticEmojis.map((e, idx) => [String(idx), { ...e, animated: false }]));
    const animatedMap = new Map(animatedEmojis.map((e, idx) => [String(idx + 1000), { ...e, animated: true }]));
    const allEmojis = new Map([...staticMap, ...animatedMap]);

    const guild = {
        id: "123456789012345678",
        name: "Test Guild",
        premiumTier: tier,
        iconURL: () => "https://cdn.discordapp.com/icons/123/icon.png",
        members: {
            me: {
                permissions: {
                    has: perm => (perm === PermissionFlagsBits.ManageGuildExpressions && botManageGuildExpressions)
                }
            }
        },
        emojis: {
            cache: {
                filter: fn => {
                    const filtered = new Map();
                    for (const [k, v] of allEmojis) {
                        if (fn(v)) filtered.set(k, v);
                    }
                    return filtered;
                }
            },
            fetch: async () => allEmojis,
            create: createEmojiImpl
        }
    };

    const interaction = {
        commandName: "copy-emojis",
        deferred: false,
        replied: false,
        user: {
            id: "345678901234567890",
            tag: "Owner#0001",
            displayAvatarURL: () => "https://cdn.discordapp.com/avatars/345/avatar.png"
        },
        member: {
            permissions: {
                has: perm => (perm === PermissionFlagsBits.Administrator && administrator)
            }
        },
        guild,
        options: {
            getString: () => emojisText
        },
        reply: async payload => {
            replies.push(payload);
            interaction.replied = true;
        },
        deferReply: async () => {
            interaction.deferred = true;
        },
        editReply: async payload => {
            edits.push(payload);
        }
    };

    return { interaction, replies, edits, guild };
}

test("parseCustomEmojis parses custom emojis, deduplicates, and sanitizes names", () => {
    const input = "<:doge:1001> <a:cat_dance:1002> <:doge:1001> <:x:1003> <a:very_long_name_that_exceeds_thirty_two_characters_limit:1004>";
    const parsed = parseCustomEmojis(input);

    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].name, "doge");
    assert.equal(parsed[0].id, "1001");
    assert.equal(parsed[0].isAnimated, false);
    assert.equal(parsed[0].url, "https://cdn.discordapp.com/emojis/1001.png");

    assert.equal(parsed[1].name, "cat_dance");
    assert.equal(parsed[1].id, "1002");
    assert.equal(parsed[1].isAnimated, true);
    assert.equal(parsed[1].url, "https://cdn.discordapp.com/emojis/1002.gif");

    // name padded because length < 2
    assert.equal(parsed[2].name, "x_");
    assert.equal(parsed[2].id, "1003");

    // name truncated to 32 characters
    assert.equal(parsed[3].name.length, 32);
    assert.equal(parsed[3].id, "1004");
});

test("parseCustomEmojis returns empty array for non-string or text without custom emojis", () => {
    assert.deepEqual(parseCustomEmojis(null), []);
    assert.deepEqual(parseCustomEmojis(""), []);
    assert.deepEqual(parseCustomEmojis("Hello world 😀 🎉 🔥"), []);
});

test("calculateEmojiQuotas correctly computes tier thresholds and available slots", () => {
    const mockGuild = {
        premiumTier: 2,
        emojis: {
            cache: {
                filter: fn => {
                    const sample = [
                        { animated: false },
                        { animated: false },
                        { animated: true }
                    ];
                    return { size: sample.filter(fn).length };
                }
            }
        }
    };

    const quotas = calculateEmojiQuotas(mockGuild);
    assert.equal(quotas.tier, 2);
    assert.equal(quotas.maxPerType, 150);
    assert.equal(quotas.staticCount, 2);
    assert.equal(quotas.animatedCount, 1);
    assert.equal(quotas.staticFree, 148);
    assert.equal(quotas.animatedFree, 149);
});

test("checkSmartEmojiQuota detects ALL_FULL, STATIC_FULL, and ANIMATED_FULL accurately", () => {
    const allFullQuotas = { maxPerType: 50, staticCount: 50, animatedCount: 50, staticFree: 0, animatedFree: 0 };
    const staticOnly = [{ isAnimated: false, name: "static1", id: "1" }];
    const animatedOnly = [{ isAnimated: true, name: "anim1", id: "2" }];
    const mixed = [...staticOnly, ...animatedOnly];

    // All full
    const check1 = checkSmartEmojiQuota(allFullQuotas, mixed);
    assert.equal(check1.allowed, false);
    assert.equal(check1.reason, "ALL_FULL");

    // Static full but animated has space, user requested only static
    const staticFullQuotas = { maxPerType: 50, staticCount: 50, animatedCount: 20, staticFree: 0, animatedFree: 30 };
    const check2 = checkSmartEmojiQuota(staticFullQuotas, staticOnly);
    assert.equal(check2.allowed, false);
    assert.equal(check2.reason, "STATIC_FULL");

    // Animated full but static has space, user requested only animated
    const animFullQuotas = { maxPerType: 50, staticCount: 10, animatedCount: 50, staticFree: 40, animatedFree: 0 };
    const check3 = checkSmartEmojiQuota(animFullQuotas, animatedOnly);
    assert.equal(check3.allowed, false);
    assert.equal(check3.reason, "ANIMATED_FULL");

    // Static full, but user requested mixed: allowed is true, with willSkipStatic calculated
    const check4 = checkSmartEmojiQuota(staticFullQuotas, mixed);
    assert.equal(check4.allowed, true);
    assert.equal(check4.willSkipStatic, 1);
    assert.equal(check4.willSkipAnimated, 0);
});

test("renderEmojiProgressBar renders clamped graphical progress bar", () => {
    const bar0 = renderEmojiProgressBar(0, 10);
    assert.ok(bar0.includes("▱▱▱▱▱▱▱▱▱▱"));
    assert.ok(bar0.includes("`0%`"));

    const bar50 = renderEmojiProgressBar(5, 10);
    assert.ok(bar50.includes("▰▰▰▰▰▱▱▱▱▱"));
    assert.ok(bar50.includes("`50%`"));

    const bar100 = renderEmojiProgressBar(10, 10);
    assert.ok(bar100.includes("▰▰▰▰▰▰▰▰▰▰"));
    assert.ok(bar100.includes("`100%`"));
});

test("formatEmojiShowcase, formatFailedEmojiList, formatSkippedEmojiList format correctly", () => {
    const sampleStatic = [{ name: "s1", id: "101" }, { name: "s2", id: "102" }];
    const sampleAnim = [{ name: "a1", id: "201" }];
    const staticText = formatEmojiShowcase(sampleStatic, false);
    const animText = formatEmojiShowcase(sampleAnim, true);

    assert.equal(staticText, "<:s1:101> <:s2:102>");
    assert.equal(animText, "<a:a1:201>");

    const skipped = formatSkippedEmojiList([{ name: "skip1", isAnimated: false }]);
    assert.ok(skipped.includes("• `:skip1:` (ทั่วไป 🖼️)"));

    const failed = formatFailedEmojiList([{ name: "fail1", reason: "ไฟล์ใหญ่เกิน 256KB" }]);
    assert.ok(failed.includes("• `:fail1:` — ไฟล์ใหญ่เกิน 256KB"));
});

test("buildEmojiResultEmbed builds complete, partial, and failed states", () => {
    const user = { tag: "Admin#0001", displayAvatarURL: () => null };
    const guild = { iconURL: () => null };

    // Complete state
    const completeEmbed = buildEmojiResultEmbed({
        total: 2,
        added: 2,
        skipped: 0,
        failed: 0,
        createdStatic: [{ name: "s1", id: "1" }],
        createdAnimated: [{ name: "a1", id: "2" }],
        skippedEmojis: [],
        failedEmojis: [],
        guild,
        user
    });
    assert.ok(completeEmbed.data.title.includes("เสร็จสมบูรณ์"));

    // Partial state
    const partialEmbed = buildEmojiResultEmbed({
        total: 2,
        added: 1,
        skipped: 1,
        failed: 0,
        createdStatic: [{ name: "s1", id: "1" }],
        createdAnimated: [],
        skippedEmojis: [{ name: "a1", isAnimated: true }],
        failedEmojis: [],
        guild,
        user
    });
    assert.ok(partialEmbed.data.title.includes("สำเร็จบางส่วน"));

    // Failed state
    const failedEmbed = buildEmojiResultEmbed({
        total: 2,
        added: 0,
        skipped: 0,
        failed: 2,
        createdStatic: [],
        createdAnimated: [],
        skippedEmojis: [],
        failedEmojis: [{ name: "a1", reason: "error" }],
        guild,
        user
    });
    assert.ok(failedEmbed.data.title.includes("ไม่สำเร็จ"));
});

test("handleSteal enforces Administrator permission", async () => {
    const { interaction, replies } = createInteractionFixture({ administrator: false });
    await handleSteal(interaction, { delayMs: 0 });

    assert.equal(replies.length, 1);
    assert.ok(replies[0].content.includes("Administrator"));
});

test("handleSteal enforces Bot ManageGuildExpressions permission", async () => {
    const { interaction, replies } = createInteractionFixture({ botManageGuildExpressions: false });
    await handleSteal(interaction, { delayMs: 0 });

    assert.equal(replies.length, 1);
    assert.ok(replies[0].content.includes("MANAGE_GUILD_EXPRESSIONS"));
});

test("handleSteal rejects when no custom emojis found", async () => {
    const { interaction, replies } = createInteractionFixture({ emojisText: "Hello there 😀 🎉" });
    await handleSteal(interaction, { delayMs: 0 });

    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.ok(replies[0].embeds[0].data.title.includes("ไม่พบอิโมจิ Custom"));
});

test("handleSteal rejects when > 50 emojis provided", async () => {
    const manyEmojis = Array.from({ length: 51 }, (_, i) => `<:emoji${i}:10000000000000000${i}>`).join(" ");
    const { interaction, replies } = createInteractionFixture({ emojisText: manyEmojis });
    await handleSteal(interaction, { delayMs: 0 });

    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.ok(replies[0].embeds[0].data.title.includes("เกินขีดจำกัด"));
});

test("handleSteal rejects when activeEmojiCopies already has the guild id", async () => {
    const { interaction, replies } = createInteractionFixture({});
    activeEmojiCopies.add(interaction.guild.id);
    try {
        await handleSteal(interaction, { delayMs: 0 });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].ephemeral, true);
        assert.ok(replies[0].embeds[0].data.title.includes("กำลังดำเนินการคัดลอก"));
    } finally {
        activeEmojiCopies.delete(interaction.guild.id);
    }
});

test("handleSteal rejects immediately when quota Smart Pre-Check fails", async () => {
    const static50 = Array.from({ length: 50 }, (_, i) => ({ id: String(i), animated: false }));
    const { interaction, replies } = createInteractionFixture({
        staticEmojis: static50,
        emojisText: "<:e1:111111111111111111> <:e2:222222222222222222>"
    });

    await handleSteal(interaction, { delayMs: 0 });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.ok(replies[0].embeds[0].data.title.includes("ช่องเก็บอิโมจิทั่วไป"));
});

test("handleSteal successfully imports emojis and sends progress and result embeds", async () => {
    const createdList = [];
    const { interaction, edits } = createInteractionFixture({
        emojisText: "<:doge:123456789012345678> <a:dance:234567890123456789>",
        createEmojiImpl: async payload => {
            const item = { id: `created_${Date.now()}_${payload.name}`, name: payload.name, animated: payload.name === "dance" };
            createdList.push({ ...payload, result: item });
            return item;
        }
    });

    await handleSteal(interaction, { delayMs: 0 });

    assert.equal(interaction.deferred, true);
    assert.equal(activeEmojiCopies.has(interaction.guild.id), false);
    assert.equal(createdList.length, 2);

    assert.ok(createdList[0].reason.includes("คัดลอกโดย Owner#0001"));

    const finalEdit = edits[edits.length - 1];
    assert.ok(finalEdit.embeds);
    assert.equal(finalEdit.embeds.length, 1);
    assert.ok(finalEdit.embeds[0].data.title.includes("เสร็จสมบูรณ์"));
});

test("handleSteal handles individual emoji creation failures gracefully and reports them", async () => {
    const { interaction, edits } = createInteractionFixture({
        emojisText: "<:good:111111111111111111> <:bad:222222222222222222>",
        createEmojiImpl: async payload => {
            if (payload.name === "bad") {
                const err = new Error("Request entity too large");
                err.code = 40005;
                throw err;
            }
            return { id: "good_id", name: payload.name, animated: false };
        }
    });

    await handleSteal(interaction, { delayMs: 0 });

    assert.equal(activeEmojiCopies.has(interaction.guild.id), false);
    const finalEdit = edits[edits.length - 1];
    assert.ok(finalEdit.embeds);
    assert.ok(finalEdit.embeds[0].data.title.includes("สำเร็จบางส่วน"));
    const fields = finalEdit.embeds[0].data.fields;
    const failedField = fields.find(f => f.name.includes("รายการที่ล้มเหลว"));
    assert.ok(failedField);
    assert.ok(failedField.value.includes("256KB"));
});
