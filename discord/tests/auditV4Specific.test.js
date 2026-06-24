const assert = require("node:assert/strict");
const test = require("node:test");

const specific = require("../logging/auditSpecificRenderers");
const auditExport = require("../logging/auditExport");

test("specific audit renderer handles channel overwrite events", () => {
    const embed = specific.renderAuditEntry({
        id: "entry-overwrite",
        action: "CHANNEL_OVERWRITE_UPDATE",
        user_id: "actor1",
        target_id: "role1",
        options: { channel_id: "channel1", id: "role1", type: "role" },
        changes: [{ key: "allow", old: "0", new: "1024" }]
    });
    const json = embed.toJSON();
    assert.match(json.title, /Channel Permission/);
    assert.ok(json.fields.some(item => item.name === "Overwrite Target"));
});

test("specific audit renderer handles member voice moderation events", () => {
    const embed = specific.renderAuditEntry({
        id: "entry-move",
        action: "MEMBER_MOVE",
        user_id: "actor1",
        options: { channel_id: "voice1", count: 3 }
    });
    const json = embed.toJSON();
    assert.match(json.title, /Voice Moderation/);
    assert.ok(json.fields.some(item => item.name === "Count"));
});

test("audit export renders csv json and markdown", () => {
    const records = [{
        createdAt: 123,
        eventId: "event1",
        guildId: "guild1",
        category: "server",
        severity: "warning",
        actionType: "ROLE_UPDATE",
        actorId: "actor1",
        targetId: "target1",
        summary: "Role updated"
    }];
    assert.match(auditExport.recordsToCsv(records), /ROLE_UPDATE/);
    assert.match(auditExport.recordsToJson(records), /event1/);
    assert.match(auditExport.recordsToMarkdown(records), /Role updated/);
});

test("audit csv export neutralizes spreadsheet formulas", () => {
    const csv = auditExport.recordsToCsv([{
        eventId: "event2",
        reason: "=IMPORTXML(\"https://example.test\")",
        summary: "+cmd"
    }]);
    assert.match(csv, /"'=IMPORTXML/);
    assert.match(csv, /"'\+cmd"/);
});

test("specific audit renderer forwards caller options", () => {
    const embed = specific.renderAuditEntry({
        id: "entry-role",
        action: "ROLE_UPDATE",
        user_id: "actor1",
        target_id: "role1",
        changes: [{ key: "name", old: "old", new: "new" }]
    }, {
        footer: "Audit reconciler",
        fields: [{ name: "Source", value: "scheduler", inline: true }]
    });
    const json = embed.toJSON();
    assert.equal(json.footer.text, "Audit reconciler");
    assert.ok(json.fields.some(item => item.name === "Source" && item.value === "scheduler"));
});
