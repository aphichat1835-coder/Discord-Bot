"use strict";

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

function hasElevatedPerm(isPrivileged, explicitFlag, permissions, permFlag) {
    return isPrivileged || explicitFlag === true || hasPerm(permissions, permFlag);
}

function normalizeGuildPermissions(guild = {}) {
    const owner = Boolean(guild.owner || guild.isOwner);
    const permissions = String(guild.permissions || "0");
    const administrator = hasPerm(permissions, PERMISSIONS.Administrator);
    const isPrivileged = owner || administrator;
    const canManageGuild = hasElevatedPerm(isPrivileged, guild.canManageGuild, permissions, PERMISSIONS.ManageGuild);
    const canManageRoles = hasElevatedPerm(isPrivileged, guild.canManageRoles, permissions, PERMISSIONS.ManageRoles);
    const canBanMembers = hasElevatedPerm(isPrivileged, guild.canBanMembers, permissions, PERMISSIONS.BanMembers);
    const isAdmin = isPrivileged || guild.isAdmin === true;

    return {
        owner,
        isOwner: owner,
        isAdmin,
        canManage: isPrivileged || canManageGuild,
        canManageGuild,
        canManageRoles,
        canBanMembers,
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
