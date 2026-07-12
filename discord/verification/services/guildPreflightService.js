"use strict";

const discordAPI = require("../utils/discordAPI");
const { configuredPublicUrls } = require("../../core/publicUrl");

function envCheck(env = process.env) {
    return {
        oauthClientId: !!env.DISCORD_CLIENT_ID,
        oauthClientSecret: !!env.DISCORD_CLIENT_SECRET,
        publicBaseUrl: configuredPublicUrls(env).length > 0,
        verifyStateSecret: !!env.VERIFY_STATE_SECRET,
        encryptionKey: !!env.ENCRYPTION_KEY
    };
}

async function fetchList(fetcher, guildId, fallbackError) {
    const result = await fetcher(guildId).catch(err => ({
        ok: false,
        error: err?.message || fallbackError
    }));
    if (Array.isArray(result)) {
        return {
            ok: true,
            items: result,
            error: null
        };
    }
    if (Array.isArray(result?.roles)) {
        return {
            ok: true,
            items: result.roles,
            error: null
        };
    }
    if (Array.isArray(result?.channels)) {
        return {
            ok: true,
            items: result.channels,
            error: null
        };
    }
    return {
        ok: false,
        items: [],
        error: result?.error || fallbackError
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
        const [roleResult, channelResult] = await Promise.all([
            fetchList(discord.getGuildRoles.bind(discord), guildId, "roles_fetch_failed"),
            fetchList(discord.getGuildChannels.bind(discord), guildId, "channels_fetch_failed")
        ]);
        roles = roleResult.items;
        add("roles_fetch", roleResult.ok, "โหลด roles จาก Discord", roleResult.error);
        channels = channelResult.items;
        add("channels_fetch", channelResult.ok, "โหลด channels จาก Discord", channelResult.error);
    }

    const roleId = verification.roleId || null;
    const channelId = verification.channelId || null;
    add("verification_enabled", verification.enabled !== false, "ระบบ verification เปิดใช้งาน");
    add("role_configured", !!roleId, "ตั้งค่า role เป้าหมายแล้ว");
    add("channel_configured", !!channelId, "ตั้งค่า channel แผงยืนยันแล้ว");
    if (roleId) add("role_exists", roles.some(role => String(role.id) === String(roleId)), "พบ role เป้าหมายใน guild");
    if (channelId) add("channel_exists", channels.some(channel => String(channel.id) === String(channelId)), "พบ channel เป้าหมายใน guild");

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
    envCheck,
    _test: {
        fetchList
    }
};
