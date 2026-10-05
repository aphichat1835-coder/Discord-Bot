const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const { validateRoleChange } = require("../features/roleButton");

function guildWithBot({ canManageRoles = true, highestPosition = 10 } = {}) {
    return {
        members: {
            me: {
                permissions: {
                    has(permission) {
                        return permission === PermissionFlagsBits.ManageRoles && canManageRoles;
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

test("formatRoleSelectionSummary accurately summarizes additions, removals, and skips", () => {
    const { _test } = require("../features/roleButton");
    const emptySummary = _test.formatRoleSelectionSummary({
        added: [],
        removed: [],
        skipped: [],
        failed: []
    });
    assert.equal(emptySummary, "ไม่มีการเปลี่ยนแปลง");

    const fullSummary = _test.formatRoleSelectionSummary({
        added: ["RoleA", "RoleB"],
        removed: ["RoleC"],
        skipped: ["RoleD: managed"],
        failed: ["RoleE: timeout"]
    });
    assert.match(fullSummary, /✅ เพิ่ม: RoleA, RoleB/);
    assert.match(fullSummary, /❌ ลบ: RoleC/);
    assert.match(fullSummary, /⚠️ ข้าม: RoleD: managed/);
    assert.match(fullSummary, /🚫 ไม่สำเร็จ: RoleE: timeout/);
});

test("applySingleRoleChange performs add or remove based on selection state", async () => {
    const { _test } = require("../features/roleButton");
    const addedIds = [];
    const removedIds = [];
    const testMember = {
        roles: {
            cache: new Map([["role1", true]]),
            async add(id) { addedIds.push(id); },
            async remove(id) { removedIds.push(id); }
        }
    };

    const results = { added: [], removed: [], skipped: [], failed: [] };
    // Should add role2 (not in cache)
    await _test.applySingleRoleChange(testMember, { id: "role2", name: "Role Two" }, true, results);
    assert.deepEqual(addedIds, ["role2"]);
    assert.deepEqual(results.added, ["Role Two"]);

    // Should remove role1 (in cache)
    await _test.applySingleRoleChange(testMember, { id: "role1", name: "Role One" }, false, results);
    assert.deepEqual(removedIds, ["role1"]);
    assert.deepEqual(results.removed, ["Role One"]);
});

