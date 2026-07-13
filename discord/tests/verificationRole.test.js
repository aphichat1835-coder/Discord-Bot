const assert = require("node:assert/strict");
const test = require("node:test");

process.env.ENCRYPTION_KEY ||= "test-key-for-unit-tests-only";
process.env.API_SECRET ||= "test-api-secret";

const { _test } = require("../commands/verification");

function botMember({ canManageRoles = true, highestPosition = 10 } = {}) {
    return {
        permissions: {
            has(permission) {
                return permission === "MANAGE_ROLES" && canManageRoles;
            }
        },
        roles: {
            highest: {
                position: highestPosition
            }
        }
    };
}

test("direct-role assignment helper accepts manageable roles", () => {
    const result = _test.validateDirectRoleAssignment(
        botMember({ canManageRoles: true, highestPosition: 10 }),
        { id: "role1", managed: false, position: 5 }
    );

    assert.equal(result.ok, true);
});

test("direct-role assignment helper rejects missing Manage Roles", () => {
    const result = _test.validateDirectRoleAssignment(
        botMember({ canManageRoles: false, highestPosition: 10 }),
        { id: "role1", managed: false, position: 5 }
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /Manage Roles/);
});

test("direct-role assignment helper rejects managed and higher roles", () => {
    const managed = _test.validateDirectRoleAssignment(
        botMember({ highestPosition: 10 }),
        { id: "role1", managed: true, position: 5 }
    );
    const tooHigh = _test.validateDirectRoleAssignment(
        botMember({ highestPosition: 10 }),
        { id: "role2", managed: false, position: 10 }
    );

    assert.equal(managed.ok, false);
    assert.match(managed.reason, /managed/);
    assert.equal(tooHigh.ok, false);
    assert.match(tooHigh.reason, /role hierarchy|ยศบอท/);
});

test("verification panel accepts HTTPS URLs only and enforces text limits", () => {
    assert.equal(_test.cleanHttpsUrl("https://example.com/image.png", "image"), "https://example.com/image.png");
    assert.throws(() => _test.cleanHttpsUrl("http://example.com", "image"), /PANEL_URL_INVALID/);
    assert.doesNotThrow(() => _test.validatePanelText("x".repeat(256), "title", 256));
    assert.throws(() => _test.validatePanelText("x".repeat(257), "title", 256), /PANEL_INPUT_TOO_LONG/);
});

test("direct role config is bound to the latest guild message and role", () => {
    const interaction = { message: { id: "222222222222222222" } };
    const guildConfig = { verification: {
        enabled: true,
        roleId: "333333333333333333",
        messageId: "222222222222222222",
        verifyType: "direct",
        panelRevision: "panel-test"
    } };
    assert.equal(_test.isCurrentDirectConfig(guildConfig, interaction, "333333333333333333"), true);
    assert.equal(_test.isCurrentDirectConfig(guildConfig, { message: { id: "444444444444444444" } }, "333333333333333333"), false);
});

test("verification persistence retries bounded transient failures", async () => {
    let attempts = 0;
    const result = await _test.retryPersistence(async () => {
        attempts++;
        if (attempts < 3) return false;
        return { ok: true };
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
});
