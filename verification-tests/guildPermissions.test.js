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
        expect(typeof PERMISSIONS.ADMINISTRATOR).toBe("bigint");
        expect(typeof PERMISSIONS.MANAGE_GUILD).toBe("bigint");
        expect(PERMISSIONS.ADMINISTRATOR).toBe(0x8n);
        expect(PERMISSIONS.MANAGE_GUILD).toBe(0x20n);
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
        expect(hasPerm("8", PERMISSIONS.ADMINISTRATOR)).toBe(true);
        expect(hasPerm("32", PERMISSIONS.MANAGE_GUILD)).toBe(true);
        expect(hasPerm("4", PERMISSIONS.BAN_MEMBERS)).toBe(true);
    });

    it("returns false when flag is not set", () => {
        expect(hasPerm("0", PERMISSIONS.ADMINISTRATOR)).toBe(false);
        expect(hasPerm("4", PERMISSIONS.MANAGE_GUILD)).toBe(false);
    });

    it("works with combined permission bitfield", () => {
        const combined = String(PERMISSIONS.ADMINISTRATOR | PERMISSIONS.BAN_MEMBERS);
        expect(hasPerm(combined, PERMISSIONS.ADMINISTRATOR)).toBe(true);
        expect(hasPerm(combined, PERMISSIONS.BAN_MEMBERS)).toBe(true);
        expect(hasPerm(combined, PERMISSIONS.MANAGE_GUILD)).toBe(false);
    });
});

describe("permissionFlags", () => {
    it("returns array of flag names for combined bits", () => {
        const bits = String(PERMISSIONS.ADMINISTRATOR | PERMISSIONS.MANAGE_GUILD);
        const flags = permissionFlags(bits);
        expect(flags).toContain("ADMINISTRATOR");
        expect(flags).toContain("MANAGE_GUILD");
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
        const result = normalizeGuildPermissions({ permissions: String(PERMISSIONS.ADMINISTRATOR) });
        expect(result.isAdmin).toBe(true);
        expect(result.canManage).toBe(true);
        expect(result.canManageGuild).toBe(true);
        expect(result.canManageRoles).toBe(true);
        expect(result.canBanMembers).toBe(true);
        expect(result.owner).toBe(false);
    });

    it("MANAGE_GUILD bit grants canManageGuild but not isAdmin", () => {
        const result = normalizeGuildPermissions({ permissions: String(PERMISSIONS.MANAGE_GUILD) });
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
        const result = normalizeGuildPermissions({ permissions: String(PERMISSIONS.BAN_MEMBERS) });
        expect(result.canBanMembers).toBe(true);
        expect(result.canManageGuild).toBe(false);
    });
});

describe("canAccessGuildDashboard", () => {
    it("true for owner", () => {
        expect(canAccessGuildDashboard({ owner: true, permissions: "0" })).toBe(true);
    });

    it("true for ADMINISTRATOR", () => {
        expect(canAccessGuildDashboard({ permissions: String(PERMISSIONS.ADMINISTRATOR) })).toBe(true);
    });

    it("true for MANAGE_GUILD", () => {
        expect(canAccessGuildDashboard({ permissions: String(PERMISSIONS.MANAGE_GUILD) })).toBe(true);
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
        expect(canEditVerificationPanel({ permissions: String(PERMISSIONS.MANAGE_GUILD) })).toBe(true);
    });

    it("false for BAN_MEMBERS only", () => {
        expect(canEditVerificationPanel({ permissions: String(PERMISSIONS.BAN_MEMBERS) })).toBe(false);
    });

    it("false for no permissions", () => {
        expect(canEditVerificationPanel({})).toBe(false);
    });
});
