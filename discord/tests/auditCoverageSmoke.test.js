const assert = require("node:assert/strict");
const test = require("node:test");

const { renderAuditEntry } = require("../logging/auditSpecificRenderers");
const { categoryForAuditEvent } = require("../logging/auditEventMap");

const EVENTS = [
    "GUILD_UPDATE",
    "CHANNEL_OVERWRITE_CREATE",
    "CHANNEL_OVERWRITE_UPDATE",
    "CHANNEL_OVERWRITE_DELETE",
    "WEBHOOK_CREATE",
    "WEBHOOK_UPDATE",
    "WEBHOOK_DELETE",
    "INVITE_UPDATE",
    "STAGE_INSTANCE_CREATE",
    "GUILD_SCHEDULED_EVENT_UPDATE",
    "SOUNDBOARD_SOUND_UPDATE",
    "ONBOARDING_UPDATE",
    "HOME_SETTINGS_UPDATE",
    "VOICE_CHANNEL_STATUS_CREATE"
];

function fixture(eventName) {
    return {
        id: `entry-${eventName}`,
        action: eventName,
        user_id: "actor1",
        target_id: "target1",
        options: { channel_id: "channel1", role_id: "role1", message_id: "message1", count: 2 },
        changes: [{ key: "name", old: "old", new: "new" }],
        createdTimestamp: Date.now()
    };
}

test("audit coverage smoke fixtures render", () => {
    for (const eventName of EVENTS) {
        const embed = renderAuditEntry(fixture(eventName));
        const json = embed.toJSON();
        assert.ok(json.title, `${eventName} should have title`);
        assert.ok(json.fields.length > 0, `${eventName} should have fields`);
        assert.equal(typeof categoryForAuditEvent(eventName), "string");
    }
});
