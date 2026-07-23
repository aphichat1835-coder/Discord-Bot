"use strict";

const { PermissionFlagsBits } = require("discord.js");

function getGuildBotMember(guild) {
    return guild?.members?.me || guild?.me || guild?.members?.cache?.get(guild?.client?.user?.id);
}

function canDeleteMessage(message) {
    const botMember = getGuildBotMember(message?.guild);
    const permissions = message?.channel?.permissionsFor?.(botMember);
    return message?.deletable === true && permissions?.has?.(PermissionFlagsBits.ManageMessages) === true;
}

function canBanMember(member) {
    const botMember = getGuildBotMember(member?.guild);
    return botMember?.permissions?.has?.(PermissionFlagsBits.BanMembers) === true && member?.bannable === true;
}

function isAdministrator(member) {
    return member?.permissions?.has?.(PermissionFlagsBits.Administrator) === true;
}

function canCreateInvite(channel, guildMember) {
    if (channel?.isTextBased?.() !== true) return false;
    return channel.permissionsFor?.(guildMember)?.has?.(PermissionFlagsBits.CreateInstantInvite) === true;
}

module.exports = {
    canBanMember,
    canCreateInvite,
    canDeleteMessage,
    getGuildBotMember,
    isAdministrator
};
