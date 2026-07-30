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
    assert.equal(DmNotification.schema.path("priorityRank").options.default, 2);
});

test("volatile outbox retains a transient failure when MongoDB is unavailable", async () => {
    dmService._test.resetTestState();
    dmService._test.setDatabaseReadyForTest(false);
    const recipient = {
        send: async () => {
            const error = new Error("temporary timeout");
            error.code = "ETIMEDOUT";
            throw error;
        }
    };
    dmService.configure({
        client: {
            users: { cache: new Map([["volatile-dm", recipient]]), fetch: async () => recipient },
            isReady: () => true
        }
    });

    const result = await dmService.send({
        eventKey: "test:volatile-dm",
        recipientId: "volatile-dm",
        category: "test",
        priority: "critical",
        payload: { content: "test" }
    });

    assert.equal(result.status, "retrying");
    assert.equal(dmService._test.volatileOutbox.has("test:volatile-dm"), true);
    assert.equal(dmService._test.volatileOutbox.get("test:volatile-dm").priorityRank, 0);
    dmService._test.resetTestState();
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

test("volatile DM delivery is persisted as sent when MongoDB recovers", async () => {
    dmService._test.resetTestState();
    dmService._test.setDatabaseReadyForTest(false);
    const recipient = { send: async () => ({ id: "message-1" }) };
    dmService.configure({
        client: {
            users: { cache: new Map([["volatile-user", recipient]]), fetch: async () => recipient },
            isReady: () => true
        }
    });

    const result = await dmService.send({
        eventKey: "test:volatile-recovery",
        recipientId: "volatile-user",
        category: "test",
        priority: "critical",
        payload: { content: "critical" }
    });
    assert.equal(result.status, "sent");
    assert.equal(dmService._test.volatileOutbox.size, 1);

    const originalUpdateOne = DmNotification.updateOne;
    let persisted = null;
    DmNotification.updateOne = async (filter, update, options) => {
        persisted = { filter, update, options };
        return { acknowledged: true, upsertedCount: 1 };
    };
    dmService._test.setDatabaseReadyForTest(true);
    try {
        const migration = await dmService.persistVolatileOutbox();
        assert.equal(migration.persisted, 1);
        assert.equal(persisted.filter.eventKey, "test:volatile-recovery");
        assert.equal(persisted.update.$set.status, "sent");
        assert.equal(persisted.update.$set.priorityRank, 0);
        assert.equal(dmService._test.volatileOutbox.size, 0);
    } finally {
        DmNotification.updateOne = originalUpdateOne;
        dmService._test.resetTestState();
    }
});

test("pending DM query sorts by priority before applying the limit", async () => {
    dmService._test.resetTestState();
    dmService._test.setDatabaseReadyForTest(true);
    dmService.configure({ client: { users: { cache: new Map() }, isReady: () => true } });

    const originalFind = DmNotification.find;
    const originalUpdateMany = DmNotification.updateMany;
    let sortSpec = null;
    let limitValue = null;
    DmNotification.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    DmNotification.find = () => ({
        sort(spec) { sortSpec = spec; return this; },
        limit(value) { limitValue = value; return this; },
        lean: async () => []
    });
    try {
        const result = await dmService.processPending(25);
        assert.equal(result.processed, 0);
        assert.deepEqual(sortSpec, { priorityRank: 1, createdAt: 1 });
        assert.equal(limitValue, 25);
    } finally {
        DmNotification.find = originalFind;
        DmNotification.updateMany = originalUpdateMany;
        dmService._test.resetTestState();
    }
});
