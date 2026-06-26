const assert = require("node:assert/strict");
const test = require("node:test");

const protectionAudit = require("../logging/protectionAudit");

test("buildProtectionEvent normalizes evidence and action result", () => {
    const event = protectionAudit.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        channelId: "c1",
        trigger: "Anti-Spam Triggered",
        reason: "sent too many messages",
        messageCount: 7,
        channelCount: 3,
        action: "timeout",
        success: true,
        timeoutMs: 300000,
        dmSent: true
    });

    assert.equal(event.trigger, "Anti-Spam Triggered");
    assert.equal(event.actionResult.action, "timeout");
    assert.equal(event.actionResult.success, true);
    assert.ok(event.evidence.some(item => item.includes("Messages")));
});

test("buildProtectionEmbed includes evidence and action result fields", () => {
    const event = protectionAudit.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        trigger: "Anti-Raid",
        reason: "mention spam",
        everyoneMentions: 5,
        action: "timeout",
        success: false,
        error: "missing permission"
    });

    const embed = protectionAudit.buildProtectionEmbed(event);
    const fields = embed.toJSON().fields || [];
    assert.ok(fields.some(field => field.name.includes("Evidence")));
    assert.ok(fields.some(field => field.name.includes("Action")));
});

test("createActionResult records failed action details", () => {
    const result = protectionAudit.createActionResult({
        action: "ban",
        attempted: true,
        success: false,
        error: "role hierarchy"
    });
    const formatted = protectionAudit.formatActionResult(result);
    assert.match(formatted, /BAN/);
    assert.match(formatted, /role hierarchy/);
});

test("createProtectionCase skips failed or skipped punitive actions", async () => {
    const sessionManager = {
        async getSetting(_key, fallback) { return fallback; },
        async setSetting() { throw new Error("case should not be saved"); }
    };
    const failedEvent = protectionAudit.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        action: "ban",
        attempted: true,
        success: false
    });
    const skippedEvent = protectionAudit.buildProtectionEvent({
        guildId: "g1",
        userId: "u1",
        action: "ban",
        attempted: false,
        success: true
    });

    assert.equal(await protectionAudit.createProtectionCase(sessionManager, failedEvent), null);
    assert.equal(await protectionAudit.createProtectionCase(sessionManager, skippedEvent), null);
});
