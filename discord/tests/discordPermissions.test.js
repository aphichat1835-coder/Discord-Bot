"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");
const {
    canBanMember,
    canCreateInvite,
    canDeleteMessage,
    isAdministrator
} = require("../core/discordPermissions");

function permissionSet(expected, result = true) {
    return {
        has(permission) {
            assert.equal(permission, expected);
            return result;
        }
    };
}

test("event permission helpers use Discord.js v14 permission flags", () => {
    const botMember = { permissions: permissionSet(PermissionFlagsBits.BanMembers) };
    const guild = { members: { me: botMember } };
    const message = {
        guild,
        deletable: true,
        channel: { permissionsFor: member => {
            assert.equal(member, botMember);
            return permissionSet(PermissionFlagsBits.ManageMessages);
        } }
    };
    const member = { guild, bannable: true, permissions: permissionSet(PermissionFlagsBits.Administrator) };
    const channel = {
        isTextBased: () => true,
        permissionsFor: value => {
            assert.equal(value, botMember);
            return permissionSet(PermissionFlagsBits.CreateInstantInvite);
        }
    };

    assert.equal(canDeleteMessage(message), true);
    assert.equal(canBanMember(member), true);
    assert.equal(isAdministrator(member), true);
    assert.equal(canCreateInvite(channel, botMember), true);
});

test("event permission helpers fail closed when Discord state is unavailable", () => {
    assert.equal(canDeleteMessage({ deletable: true }), false);
    assert.equal(canBanMember({ bannable: true }), false);
    assert.equal(isAdministrator(null), false);
    assert.equal(canCreateInvite({ isTextBased: () => false }, null), false);
});
