"use strict";

const { PermissionFlagsBits } = require("discord.js");

function getGuildBotMember(guild) {
    return guild?.members?.me || guild?.me || guild?.members?.cache?.get(guild?.client?.user?.id);
}

function legacyPermissionNameToPascal(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .split("_")
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}

function resolvePermission(permission) {
    if (typeof permission === "bigint") return permission;
    if (typeof permission === "number" && Number.isSafeInteger(permission) && permission >= 0) {
        return BigInt(permission);
    }
    if (typeof permission !== "string") return null;

    const trimmed = permission.trim();
    if (!trimmed) return null;
    if (Object.hasOwn(PermissionFlagsBits, trimmed)) return PermissionFlagsBits[trimmed];

    const legacyName = legacyPermissionNameToPascal(trimmed);
    if (legacyName && Object.hasOwn(PermissionFlagsBits, legacyName)) {
        return PermissionFlagsBits[legacyName];
    }
    return null;
}

function hasResolvedPermission(permissionTarget, permission) {
    const resolved = resolvePermission(permission);
    if (resolved === null || typeof permissionTarget?.has !== "function") return false;
    try {
        return permissionTarget.has(resolved) === true;
    } catch {
        return false;
    }
}

function canDeleteMessage(message) {
    const botMember = getGuildBotMember(message?.guild);
    const permissions = message?.channel?.permissionsFor?.(botMember);
    return message?.deletable === true && hasResolvedPermission(permissions, PermissionFlagsBits.ManageMessages);
}

function canBanMember(member) {
    const botMember = getGuildBotMember(member?.guild);
    return hasResolvedPermission(botMember?.permissions, PermissionFlagsBits.BanMembers) && member?.bannable === true;
}

function isAdministrator(member) {
    return hasResolvedPermission(member?.permissions, PermissionFlagsBits.Administrator);
}

function canCreateInvite(channel, guildMember) {
    if (channel?.isTextBased?.() !== true) return false;
    if (channel?.isThread?.() === true) return false;
    if (typeof channel?.createInvite !== "function") return false;
    return hasResolvedPermission(channel.permissionsFor?.(guildMember), PermissionFlagsBits.CreateInstantInvite);
}

module.exports = {
    canBanMember,
    canCreateInvite,
    canDeleteMessage,
    getGuildBotMember,
    hasResolvedPermission,
    isAdministrator,
    legacyPermissionNameToPascal,
    resolvePermission
};
