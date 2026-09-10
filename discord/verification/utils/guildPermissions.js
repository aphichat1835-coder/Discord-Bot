const { PermissionFlagsBits } = require("discord.js");

const PERMISSIONS = Object.freeze({
    Administrator: PermissionFlagsBits.Administrator,
    ManageGuild: PermissionFlagsBits.ManageGuild,
    BanMembers: PermissionFlagsBits.BanMembers,
    KickMembers: PermissionFlagsBits.KickMembers,
    ManageChannels: PermissionFlagsBits.ManageChannels,
    ManageRoles: PermissionFlagsBits.ManageRoles,
    ManageMessages: PermissionFlagsBits.ManageMessages,
    ViewAuditLog: PermissionFlagsBits.ViewAuditLog
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
    const administrator = hasPerm(permissions, PERMISSIONS.Administrator);
    const canManageGuild = owner || administrator || guild.canManageGuild === true || hasPerm(permissions, PERMISSIONS.ManageGuild);
    const canManageRoles = owner || administrator || guild.canManageRoles === true || hasPerm(permissions, PERMISSIONS.ManageRoles);
    const isAdmin = owner || administrator || guild.isAdmin === true;

    return {
        owner,
        isOwner: owner,
        isAdmin,
        canManage: owner || administrator || canManageGuild,
        canManageGuild,
        canManageRoles,
        canBanMembers: owner || administrator || guild.canBanMembers === true || hasPerm(permissions, PERMISSIONS.BanMembers),
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
