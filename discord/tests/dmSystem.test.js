"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const dmService = require("../dm");
const DmNotification = require("../dm/model");
const { buildVoiceEventEmbed, createVoiceSnapshot } = require("../voiceWorker/dm");
const { EVENTS, policyAllows, eventPriority } = require("../voiceWorker/notifications");
const { buildModerationDmEmbed } = require("../commands/moderationHelpers");
const utility = require("../commands/utility");
const lifecycle = require("../voiceWorker/lifecycle");

function fakeUser(id = "111111111111111111") {
    return {
        id,
        username: "member",
        globalName: "สมาชิกตัวอย่าง",
        discriminator: "0",
        tag: "member",
        displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png"
    };
}

function fakeInteraction() {
    return {
        id: "444444444444444444",
        guild: { id: "222222222222222222", name: "เซิร์ฟเวอร์ตัวอย่าง" },
        user: fakeUser("333333333333333333")
    };
}

test("shared DM design always includes the relevant profile and disables mentions", () => {
    const profile = dmService.design.profileFromUser(fakeUser());
    const embed = dmService.design.buildDmEmbed({
        tone: "success",
        title: "สำเร็จ",
        summary: "ทดสอบ",
        profile,
        referenceId: "REF-1"
    }).toJSON();
    const payload = dmService.normalizePayload({ embeds: [embed], content: "สวัสดี @everyone" });

    assert.equal(embed.thumbnail.url, "https://cdn.discordapp.com/embed/avatars/0.png");
    assert.ok(embed.fields.some(field => field.name === "👤 บัญชีที่เกี่ยวข้อง"));
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
    assert.doesNotMatch(payload.content, /@everyone/);
    assert.equal(dmService.design.markdownText("**name** @everyone"), "＊＊name＊＊ ＠everyone");
});

test("shared DM design stays inside Discord embed limits", () => {
    const embed = dmService.design.buildDmEmbed({
        title: "T".repeat(400),
        summary: "S".repeat(3000),
        footer: "F".repeat(3000),
        profile: dmService.design.profileFromUser(fakeUser()),
        fields: Array.from({ length: 30 }, (_, index) => ({
            name: `Field ${index}`,
            value: "V".repeat(1500)
        })),
        details: "D".repeat(2000),
        nextAction: "N".repeat(2000)
    }).toJSON();
    const textLength = embed.title.length + embed.description.length + embed.footer.text.length +
        embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);

    assert.ok(embed.fields.length <= 25);
    assert.ok(textLength <= 5800);
});

test("DM outbox schema keeps unique event keys, finite states and automatic expiry", () => {
    const eventKey = DmNotification.schema.path("eventKey");
    const status = DmNotification.schema.path("status");
    const expiresAt = DmNotification.schema.path("expiresAt");

    assert.equal(eventKey.options.unique, true);
    assert.deepEqual(status.options.enum, ["pending", "sending", "retrying", "sent", "failed_permanent"]);
    assert.deepEqual(expiresAt.options.index, { expireAfterSeconds: 0 });
});

test("voice important-only policy is materially different from all", () => {
    assert.equal(policyAllows(EVENTS.SESSION_READY, {}, "important_only"), false);
    assert.equal(policyAllows(EVENTS.SESSION_RECOVERED, {}, "important_only"), false);
    assert.equal(policyAllows(EVENTS.SESSION_RECOVERED, { recoveryNoticeSent: true }, "important_only"), true);
    assert.equal(policyAllows(EVENTS.TOKEN_INVALID, {}, "important_only"), true);
    assert.equal(policyAllows(EVENTS.SESSION_READY, {}, "all"), true);
    assert.equal(policyAllows(EVENTS.TOKEN_INVALID, {}, "off"), false);
    assert.equal(eventPriority(EVENTS.TOKEN_INVALID), "critical");
});

test("voice snapshot never invents an actually observed channel", () => {
    const snapshot = createVoiceSnapshot({
        sessionId: "vc-one",
        ownerId: "owner",
        accountId: "111111111111111111",
        accountName: "voice-account",
        serverId: "222222222222222222",
        serverName: "Guild",
        voiceId: "333333333333333333",
        voiceName: "Voice",
        recoveryState: { attempts: 0 }
    }, EVENTS.SESSION_READY, {});
    const embed = buildVoiceEventEmbed(snapshot).toJSON();

    assert.equal(snapshot.actualChannelId, null);
    assert.equal(embed.fields.some(field => field.name.includes("ช่องที่อ่านจากสถานะเสียง")), false);
});

test("gateway 4014 is not diagnosed as an invalid token", () => {
    assert.equal(lifecycle.isInvalidTokenError({ code: 4014, message: "Disallowed intent" }), false);
    assert.equal(lifecycle.isInvalidTokenError({ code: 4004, message: "Authentication failed" }), true);
});

test("moderation DM states never claim success before Discord confirms it", () => {
    const interaction = fakeInteraction();
    const target = { id: "111111111111111111", user: fakeUser() };
    const pending = buildModerationDmEmbed(interaction, target, "ban", "เหตุผล", null, {
        state: "pending",
        caseNumber: 7
    }).toJSON();
    const failed = buildModerationDmEmbed(interaction, target, "ban", "เหตุผล", null, {
        state: "failed",
        caseNumber: 7
    }).toJSON();
    const succeeded = buildModerationDmEmbed(interaction, target, "timeout", "เหตุผล", 10, {
        state: "succeeded",
        caseNumber: 7,
        endsAt: Date.now() + 600_000
    }).toJSON();

    assert.match(pending.description, /ยังไม่ยืนยันผล/);
    assert.doesNotMatch(pending.description, /ยืนยันแล้ว.*สำเร็จ/);
    assert.match(pending.fields.find(field => field.name === "💡 สิ่งที่ควรทำ").value, /ยังไม่ใช่การยืนยัน/);
    assert.match(failed.description, /ไม่ได้ดำเนินการ/);
    assert.match(succeeded.description, /ยืนยันแล้ว.*สำเร็จ/);
    assert.ok(succeeded.fields.some(field => field.name === "⏰ สิ้นสุดการหมดเวลา"));
});

test("restore result DM is private-profiled Thai output", () => {
    const interaction = fakeInteraction();
    const embed = utility._test.buildRestoreResultDmEmbed({
        interaction,
        resultState: "partial",
        restoredRoles: 3,
        restoredChannels: 4,
        skippedRoles: 1,
        skippedChannels: 2,
        ambiguousRoles: 0,
        ambiguousChannels: 1,
        overwriteStats: { restored: 5, skippedRoleMissing: 1, skippedMemberMissing: 0 },
        restoreErrors: 1,
        timeoutHit: false
    }).toJSON();

    assert.match(embed.description, /สำเร็จบางส่วน/);
    assert.ok(embed.fields.some(field => field.name === "👤 บัญชีที่เกี่ยวข้อง"));
    assert.doesNotMatch(JSON.stringify(embed), /\bpartial\b/);
});

test("DM delivery classifies closed DMs as permanent without retrying forever", async () => {
    const recipient = {
        send: async () => {
            const error = new Error("Cannot send messages to this user");
            error.code = 50007;
            throw error;
        }
    };
    dmService.configure({
        client: {
            users: { cache: new Map([["closed-dm", recipient]]), fetch: async () => recipient },
            isReady: () => true
        }
    });
    const result = await dmService.send({
        eventKey: "test:closed-dm",
        recipientId: "closed-dm",
        category: "test",
        payload: { content: "test" }
    });

    assert.deepEqual(result, { status: "failed_permanent", reason: "50007" });
});

test("DM delivery queues transient failures and suppresses the same event twice", async () => {
    const recipient = {
        send: async () => {
            const error = new Error("temporary timeout");
            error.code = "ETIMEDOUT";
            throw error;
        }
    };
    dmService.configure({
        client: {
            users: { cache: new Map([["retry-dm", recipient]]), fetch: async () => recipient },
            isReady: () => true
        }
    });
    const input = {
        eventKey: "test:retry-dm",
        recipientId: "retry-dm",
        category: "test",
        payload: { content: "test" }
    };
    const first = await dmService.send(input);
    const duplicate = await dmService.send(input);

    assert.equal(first.status, "retrying");
    assert.deepEqual(duplicate, { status: "skipped", reason: "duplicate" });
});
