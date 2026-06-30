const assert = require("node:assert/strict");
const test = require("node:test");

const { renderAuditEntry } = require("../logging/auditSpecificRenderers");

const fixtures = [
    require("./fixtures/audit/guild-update.json"),
    require("./fixtures/audit/role-update.json"),
    require("./fixtures/audit/channel-update.json"),
    require("./fixtures/audit/member-prune.json"),
    require("./fixtures/audit/soundboard-sound-update.json"),
    require("./fixtures/audit/voice-channel-status-create.json"),
    require("./fixtures/audit/guild-scheduled-event-update.json")
];

test("additional audit fixtures render", () => {
    for (const fixture of fixtures) {
        const json = renderAuditEntry(fixture).toJSON();
        assert.ok(json.title);
        assert.ok(json.fields.length > 0);
    }
});
