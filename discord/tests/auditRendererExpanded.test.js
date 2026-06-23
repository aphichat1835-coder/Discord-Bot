const assert = require("node:assert/strict");
const test = require("node:test");

const renderers = require("../logging/auditSpecificRenderers");

function entry(action, changes = []) {
    return {
        id: `entry-${action}`,
        action,
        user_id: "actor1",
        target_id: "target1",
        options: { channel_id: "channel1", role_id: "role1", count: 2 },
        changes,
        createdTimestamp: Date.now()
    };
}

test("expanded audit renderers cover guild channel role", () => {
    for (const action of ["GUILD_UPDATE", "CHANNEL_UPDATE", "ROLE_UPDATE"]) {
        const embed = renderers.renderAuditEntry(entry(action, [{ key: "name", old: "old", new: "new" }]));
        const json = embed.toJSON();
        assert.ok(json.title);
        assert.ok(json.fields.some(field => field.name === "Changes"));
    }
});

test("expanded audit renderers cover soundboard onboarding home voice status", () => {
    for (const action of ["SOUNDBOARD_SOUND_UPDATE", "ONBOARDING_UPDATE", "HOME_SETTINGS_UPDATE", "VOICE_CHANNEL_STATUS_CREATE"]) {
        const embed = renderers.renderAuditEntry(entry(action, [{ key: "enabled", old: false, new: true }]));
        const json = embed.toJSON();
        assert.ok(json.title);
        assert.ok(json.fields.length > 0);
    }
});

test("changeValue reads old and new change variants", () => {
    const sample = { changes: [{ key: "name", old_value: "old", new_value: "new" }] };
    assert.equal(renderers.changeValue(sample, "name", "old"), "old");
    assert.equal(renderers.changeValue(sample, "name", "new"), "new");
});
