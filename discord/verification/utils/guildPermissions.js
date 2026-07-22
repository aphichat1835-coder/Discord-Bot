const PERMISSIONS = Object.freeze({
    ADMINISTRATOR: 0x8n,
    MANAGE_GUILD: 0x20n,
    BAN_MEMBERS: 0x4n,
    KICK_MEMBERS: 0x2n,
    MANAGE_CHANNELS: 0x10n,
    MANAGE_ROLES: 0x10000000n,
    MANAGE_MESSAGES: 0x2000n,
    VIEW_AUDIT_LOG: 0x80n
});

function permissionBigInt(value) {
    try {
        return BigInt(String(value || "0"));
    } catch {
        return 0n;
    }
}

function hasPerm(permissions, flag) {
    const p = permissionBigInt(permissions);
    return (p & flag) === flag;
}

function permissionFlags(permissions) {
    const p = permissionBigInt(permissions);
    const flags = [];

    for (const [name, flag] of Object.entries(PERMISSIONS)) {
        if ((p & flag) === flag) flags.push(name);
    }

    return flags;
}

function normalizeGuildPermissions(guild = {}) {
    const owner = !!guild.owner || !!guild.isOwner;
    const permissions = String(guild.permissions || "0");
    const administrator = hasPerm(permissions, PERMISSIONS.ADMINISTRATOR);
    const canManageGuild = owner || administrator || guild.canManageGuild === true || hasPerm(permissions, PERMISSIONS.MANAGE_GUILD);
    const canManageRoles = owner || administrator || guild.canManageRoles === true || hasPerm(permissions, PERMISSIONS.MANAGE_ROLES);
    const isAdmin = owner || administrator || guild.isAdmin === true;

    return {
        owner,
        isOwner: owner,
        isAdmin,
        canManage: owner || administrator || canManageGuild,
        canManageGuild,
        canManageRoles,
        canBanMembers: owner || administrator || guild.canBanMembers === true || hasPerm(permissions, PERMISSIONS.BAN_MEMBERS),
        permissionFlags: permissionFlags(permissions)
    };
}

function canAccessGuildDashboard(guild = {}) {
    const policy = normalizeGuildPermissions(guild);
    return policy.isOwner || policy.isAdmin || policy.canManageGuild;
}

function canEditVerificationPanel(guild = {}) {
    const policy = normalizeGuildPermissions(guild);
    return policy.canManageGuild;
}

module.exports = {
    PERMISSIONS,
    permissionBigInt,
    hasPerm,
    permissionFlags,
    normalizeGuildPermissions,
    canAccessGuildDashboard,
    canEditVerificationPanel
};
