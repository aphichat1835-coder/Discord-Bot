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
