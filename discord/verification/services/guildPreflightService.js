"use strict";

const discordAPI = require("../utils/discordAPI");

function envCheck(env = process.env) {
    return {
        oauthClientId: !!env.DISCORD_CLIENT_ID,
        oauthClientSecret: !!env.DISCORD_CLIENT_SECRET,
        publicBaseUrl: !!(env.PUBLIC_BASE_URL || env.DASHBOARD_URL || env.PUBLIC_DASHBOARD_URL || env.DASHBOARD_PUBLIC_URL),
        verifyStateSecret: !!env.VERIFY_STATE_SECRET,
        encryptionKey: !!env.ENCRYPTION_KEY
    };
}

async function runGuildPreflight({ guildId, config = {}, guild = null, discord = discordAPI, env = process.env } = {}) {
    const verification = config.verification || {};
    const checks = [];
    const add = (key, ok, message, detail = null) => checks.push({ key, ok: !!ok, message, detail });
    const envState = envCheck(env);

    add("bot_in_guild", !!guildId && !!guild, "บอทอยู่ใน guild นี้และมีข้อมูลใน cache");
    for (const [key, value] of Object.entries(envState)) {
        add(`env_${key}`, value, value ? `${key} configured` : `${key} missing`);
    }

    let roles = [];
    let channels = [];
    if (guildId) {
        const roleResult = await discord.getGuildRoles(guildId).catch(err => ({ ok: false, error: err?.message || "roles_fetch_failed" }));
        roles = Array.isArray(roleResult) ? roleResult : Array.isArray(roleResult?.roles) ? roleResult.roles : [];
        add("roles_fetch", Array.isArray(roleResult) || Array.isArray(roleResult?.roles), "โหลด roles จาก Discord", roleResult?.error || null);

        const channelResult = await discord.getGuildChannels(guildId).catch(err => ({ ok: false, error: err?.message || "channels_fetch_failed" }));
        channels = Array.isArray(channelResult) ? channelResult : Array.isArray(channelResult?.channels) ? channelResult.channels : [];
        add("channels_fetch", Array.isArray(channelResult) || Array.isArray(channelResult?.channels), "โหลด channels จาก Discord", channelResult?.error || null);
    }

    const roleId = verification.roleId || null;
    const channelId = verification.channelId || null;
    add("verification_enabled", verification.enabled !== false, "ระบบ verification เปิดใช้งาน");
    add("role_configured", !!roleId, "ตั้งค่า role เป้าหมายแล้ว");
    add("channel_configured", !!channelId, "ตั้งค่า channel แผงยืนยันแล้ว");
    if (roleId && roles.length) add("role_exists", roles.some(role => String(role.id) === String(roleId)), "พบ role เป้าหมายใน guild");
    if (channelId && channels.length) add("channel_exists", channels.some(channel => String(channel.id) === String(channelId)), "พบ channel เป้าหมายใน guild");

    const ok = checks.every(check => check.ok);
    return {
        ok,
        guildId,
        guildName: guild?.name || config.guildName || null,
        checks,
        errors: checks.filter(check => !check.ok),
        warnings: []
    };
}

module.exports = {
    runGuildPreflight,
    envCheck
};
