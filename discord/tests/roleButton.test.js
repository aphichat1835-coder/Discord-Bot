const assert = require("node:assert/strict");
const test = require("node:test");

const { validateRoleChange } = require("../features/roleButton");

function guildWithBot({ canManageRoles = true, highestPosition = 10 } = {}) {
    return {
        members: {
            me: {
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
            }
        }
    };
}

const member = {
    roles: {
        cache: new Map()
    }
};

test("role button validation accepts manageable roles", () => {
    const result = validateRoleChange(
        guildWithBot({ canManageRoles: true, highestPosition: 20 }),
        member,
        { id: "role1", name: "Member", managed: false, position: 5 }
    );

    assert.equal(result.ok, true);
});

test("role button validation rejects missing bot permission", () => {
    const result = validateRoleChange(
        guildWithBot({ canManageRoles: false, highestPosition: 20 }),
        member,
        { id: "role1", name: "Member", managed: false, position: 5 }
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /Manage Roles/);
});

test("role button validation rejects managed and too-high roles", () => {
    const managed = validateRoleChange(
        guildWithBot({ highestPosition: 20 }),
        member,
        { id: "role1", name: "Managed", managed: true, position: 5 }
    );
    const tooHigh = validateRoleChange(
        guildWithBot({ highestPosition: 20 }),
        member,
        { id: "role2", name: "Admin", managed: false, position: 20 }
    );

    assert.equal(managed.ok, false);
    assert.match(managed.reason, /managed/);
    assert.equal(tooHigh.ok, false);
    assert.match(tooHigh.reason, /สูงกว่า|ยศสูง/);
});
