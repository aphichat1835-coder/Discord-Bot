const assert = require("node:assert/strict");
const test = require("node:test");

const { renderAuditEntry } = require("../logging/auditSpecificRenderers");
const channelOverwrite = require("./fixtures/audit/channel-overwrite-update.json");
const memberMove = require("./fixtures/audit/member-move.json");
const inviteUpdate = require("./fixtures/audit/invite-update.json");

const fixtures = [channelOverwrite, memberMove, inviteUpdate];

test("audit fixture files render", () => {
    for (const fixture of fixtures) {
        const embed = renderAuditEntry(fixture);
        const json = embed.toJSON();
        assert.ok(json.title);
        assert.ok(json.fields.length > 0);
    }
});
