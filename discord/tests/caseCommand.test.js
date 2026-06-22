const assert = require("node:assert/strict");
const test = require("node:test");

const caseCommand = require("../commands/caseCommand");

test("case command formats case lines", () => {
    const line = caseCommand._test.formatCaseLine({
        caseNumber: 12,
        action: "timeout",
        userId: "123456789012345678",
        reason: "spam messages",
        createdAt: Date.now()
    });

    assert.match(line, /#12/);
    assert.match(line, /TIMEOUT/);
    assert.match(line, /spam messages/);
});

test("case command list embed handles empty list", () => {
    const embed = caseCommand._test.buildCaseListEmbed("Cases", []);
    const json = embed.toJSON();
    assert.equal(json.title, "Cases");
    assert.match(json.description, /ไม่พบ Case/);
});
