const assert = require("node:assert/strict");
const test = require("node:test");

const logCore = require("../logging/logCore");
const deadLetter = require("../logging/auditDeadLetter");
const { buildLogEmbed, buildIdBlock } = require("../logging/logFormat");
const { diffPermissionArrays, MessageSnapshotCache } = require("../logging/auditHelpers");
const securityRules = require("../logging/securityRules");
const eventFactory = require("../logging/eventFactory");

test("logCore maps moderation and protection event categories", () => {
    assert.equal(logCore.resolveLogCategory(logCore.LOG_TYPES.MEMBER_BAN), "moderation");
    assert.equal(logCore.resolveLogCategory(logCore.LOG_TYPES.PROTECTION_TRIGGER), "security");
    assert.equal(logCore.normalizeCategory("moderation"), "moderation");
});

test("safeAuditText redacts sensitive values and truncates", () => {
    const text = logCore.safeAuditText("password=abc123 token:abcdefghijklmnopqrstuvwx.abcdef.abcdefghijklmnopqrst secret=hidden", 80);
    assert.match(text, /REDACTED/);
    assert.ok(text.length <= 80);
});

test("buildLogEmbed includes IDs and clamps fields", () => {
    const embed = buildLogEmbed({
        title: "Message Deleted",
        category: "message",
        ids: { userId: "1", channelId: "2", messageId: "3" },
        fields: Array.from({ length: 40 }, (_, index) => ({ name: `field-${index}`, value: "value" }))
    });
    const json = embed.toJSON();
    assert.ok((json.fields || []).length <= 25);
    assert.ok((json.fields || []).some(f => f.name.includes("IDs")));
});

test("buildIdBlock returns compact ID block", () => {
    const block = buildIdBlock({ userId: "123", caseNumber: 7 });
    assert.match(block, /User ID/);
    assert.match(block, /Case/);
});

test("permission diff detects added and removed permissions", () => {
    const diff = diffPermissionArrays(["VIEW_CHANNEL", "SEND_MESSAGES"], ["VIEW_CHANNEL", "ADMINISTRATOR"]);
    assert.deepEqual(diff.added, ["ADMINISTRATOR"]);
    assert.deepEqual(diff.removed, ["SEND_MESSAGES"]);
});

test("message snapshot cache stores attachments safely", () => {
    const cache = new MessageSnapshotCache({ maxSize: 10, ttlMs: 60000 });
    const snapshot = cache.snapshot({
        id: "m1",
        guild: { id: "g1" },
        channel: { id: "c1" },
        author: { id: "u1", tag: "User#0001" },
        content: "hello",
        attachments: new Map([["a1", { id: "a1", name: "x.png", url: "https://example.com/x.png", size: 12 }]]),
        embeds: [],
        createdTimestamp: 1000
    });
    assert.equal(snapshot.attachments.length, 1);
    assert.equal(cache.get("g1", "m1").content, "hello");
});

test("security rules score dangerous permission changes", () => {
    const scored = securityRules.scorePermissionChange({ added: ["ADMINISTRATOR", "MANAGE_ROLES"], removed: [] });
    assert.equal(scored.severity, "critical");
    assert.ok(scored.score >= 8);
});

test("event factory creates message event summaries", () => {
    const event = eventFactory.messageToEvent({
        id: "m1",
        guild: { id: "g1" },
        channel: { id: "c1" },
        author: { id: "u1", tag: "User#0001" },
        content: "deleted",
        attachments: new Map(),
        createdTimestamp: 1000
    });
    assert.equal(event.type, logCore.LOG_TYPES.MESSAGE_DELETE);
    assert.equal(event.category, "message");
    assert.match(eventFactory.eventSummary(event), /MESSAGE_DELETE/);
});

test("dead-letter queue normalizes and keys failed logs", () => {
    const record = deadLetter.normalizeDeadLetter({ guildId: "g1", category: "message", reason: "missing_log_channel" });
    assert.equal(record.guildId, "g1");
    assert.equal(record.category, "message");
    assert.equal(record.reason, "missing_log_channel");
    assert.equal(deadLetter.deadLetterIndexKey("g1"), "audit_dead_letter_index_g1");
});
