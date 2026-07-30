const {
    PERMISSIONS,
    permissionBigInt,
    hasPerm,
    permissionFlags,
    normalizeGuildPermissions,
    canAccessGuildDashboard,
    canEditVerificationPanel
} = require("../discord/verification/utils/guildPermissions");

describe("PERMISSIONS constants", () => {
    it("are BigInt flags", () => {
        expect(typeof PERMISSIONS.Administrator).toBe("bigint");
        expect(typeof PERMISSIONS.ManageGuild).toBe("bigint");
        expect(PERMISSIONS.Administrator).toBe(0x8n);
        expect(PERMISSIONS.ManageGuild).toBe(0x20n);
    });
});

describe("permissionBigInt", () => {
    it("converts numeric string to BigInt", () => {
        expect(permissionBigInt("8")).toBe(8n);
        expect(permissionBigInt("0")).toBe(0n);
        expect(permissionBigInt(32)).toBe(32n);
    });

    it("returns 0n for invalid or empty values", () => {
        expect(permissionBigInt("")).toBe(0n);
        expect(permissionBigInt(null)).toBe(0n);
        expect(permissionBigInt(undefined)).toBe(0n);
        expect(permissionBigInt("not-a-number")).toBe(0n);
    });
});

describe("hasPerm", () => {
    it("returns true when flag is set", () => {
        expect(hasPerm("8", PERMISSIONS.Administrator)).toBe(true);
        expect(hasPerm("32", PERMISSIONS.ManageGuild)).toBe(true);
        expect(hasPerm("4", PERMISSIONS.BanMembers)).toBe(true);
    });

    it("returns false when flag is not set", () => {
        expect(hasPerm("0", PERMISSIONS.Administrator)).toBe(false);
        expect(hasPerm("4", PERMISSIONS.ManageGuild)).toBe(false);
    });

    it("works with combined permission bitfield", () => {
        const combined = String(PERMISSIONS.Administrator | PERMISSIONS.BanMembers);
        expect(hasPerm(combined, PERMISSIONS.Administrator)).toBe(true);
        expect(hasPerm(combined, PERMISSIONS.BanMembers)).toBe(true);
        expect(hasPerm(combined, PERMISSIONS.ManageGuild)).toBe(false);
    });
});

describe("permissionFlags", () => {
    it("returns array of flag names for combined bits", () => {
        const bits = String(PERMISSIONS.Administrator | PERMISSIONS.ManageGuild);
        const flags = permissionFlags(bits);
        expect(flags).toContain("Administrator");
        expect(flags).toContain("ManageGuild");
    });

    it("returns empty array for 0", () => {
        expect(permissionFlags("0")).toEqual([]);
    });
});

describe("normalizeGuildPermissions", () => {
    it("owner flag grants everything", () => {
        const result = normalizeGuildPermissions({ owner: true, permissions: "0" });
        expect(result.owner).toBe(true);
        expect(result.isOwner).toBe(true);
        expect(result.isAdmin).toBe(true);
        expect(result.canManage).toBe(true);
        expect(result.canManageGuild).toBe(true);
        expect(result.canManageRoles).toBe(true);
        expect(result.canBanMembers).toBe(true);
    });

    it("isOwner field is equivalent to owner", () => {
        const result = normalizeGuildPermissions({ isOwner: true, permissions: "0" });
        expect(result.owner).toBe(true);
        expect(result.isAdmin).toBe(true);
        expect(result.canManage).toBe(true);
    });

    it("ADMINISTRATOR bit grants all management", () => {
        const result = normalizeGuildPermissions({ permissions: String(PERMISSIONS.Administrator) });
        expect(result.isAdmin).toBe(true);
        expect(result.canManage).toBe(true);
        expect(result.canManageGuild).toBe(true);
        expect(result.canManageRoles).toBe(true);
        expect(result.canBanMembers).toBe(true);
        expect(result.owner).toBe(false);
    });

    it("MANAGE_GUILD bit grants canManageGuild but not isAdmin", () => {
        const result = normalizeGuildPermissions({ permissions: String(PERMISSIONS.ManageGuild) });
        expect(result.canManageGuild).toBe(true);
        expect(result.canManage).toBe(true);
        expect(result.isAdmin).toBe(false);
        expect(result.owner).toBe(false);
    });

    it("no permissions returns all false", () => {
        const result = normalizeGuildPermissions({ permissions: "0" });
        expect(result.owner).toBe(false);
        expect(result.isAdmin).toBe(false);
        expect(result.canManage).toBe(false);
        expect(result.canManageGuild).toBe(false);
        expect(result.canManageRoles).toBe(false);
        expect(result.canBanMembers).toBe(false);
    });

    it("empty guild defaults gracefully", () => {
        const result = normalizeGuildPermissions({});
        expect(typeof result.canManage).toBe("boolean");
        expect(result.permissionFlags).toEqual([]);
    });

    it("BAN_MEMBERS bit grants canBanMembers but not canManageGuild", () => {
        const result = normalizeGuildPermissions({ permissions: String(PERMISSIONS.BanMembers) });
        expect(result.canBanMembers).toBe(true);
        expect(result.canManageGuild).toBe(false);
    });
});

describe("canAccessGuildDashboard", () => {
    it("true for owner", () => {
        expect(canAccessGuildDashboard({ owner: true, permissions: "0" })).toBe(true);
    });

    it("true for ADMINISTRATOR", () => {
        expect(canAccessGuildDashboard({ permissions: String(PERMISSIONS.Administrator) })).toBe(true);
    });

    it("true for MANAGE_GUILD", () => {
        expect(canAccessGuildDashboard({ permissions: String(PERMISSIONS.ManageGuild) })).toBe(true);
    });

    it("false for no permissions", () => {
        expect(canAccessGuildDashboard({ permissions: "0" })).toBe(false);
    });

    it("false for empty guild", () => {
        expect(canAccessGuildDashboard({})).toBe(false);
    });
});

describe("canEditVerificationPanel", () => {
    it("true for owner", () => {
        expect(canEditVerificationPanel({ owner: true, permissions: "0" })).toBe(true);
    });

    it("true for MANAGE_GUILD", () => {
        expect(canEditVerificationPanel({ permissions: String(PERMISSIONS.ManageGuild) })).toBe(true);
    });

    it("false for BAN_MEMBERS only", () => {
        expect(canEditVerificationPanel({ permissions: String(PERMISSIONS.BanMembers) })).toBe(false);
    });

    it("false for no permissions", () => {
        expect(canEditVerificationPanel({})).toBe(false);
    });
});
