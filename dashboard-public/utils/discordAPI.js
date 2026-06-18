/*
================================================================================
  Discord API Utilities — Dashboard Public v2

  รวม helper เดิม + helper ใหม่สำหรับ:
  - OAuth exchange / refresh
  - fetch user profile / guilds / member
  - add member / add role
  - DM
  - dashboard verify panel: roles/channels/bot member/create/edit/fetch message
  - permission validation helpers
================================================================================
*/

const { encryptToken, decryptToken } = require("./crypto");

const BASE = "https://discord.com/api/v10";
const DISCORD_API_ORIGIN = new URL(BASE).origin;

const PERMISSIONS = Object.freeze({
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    EMBED_LINKS: 1n << 14n,
    MANAGE_ROLES: 1n << 28n,
    ADMINISTRATOR: 1n << 3n
});

const TEXT_CHANNEL_TYPES = new Set([
    0,  // GuildText
    5,  // GuildAnnouncement
    15  // GuildForum
]);

function getClientId() {
    return process.env.DISCORD_CLIENT_ID;
}

function getClientSecret() {
    return process.env.DISCORD_CLIENT_SECRET;
}

function getBotToken() {
    return (
        process.env.TOKEN_MANAGER ||
        process.env.BOT_TOKEN ||
        process.env.DISCORD_BOT_TOKEN ||
        process.env.TOKEN ||
        ""
    );
}

function hasBotToken() {
    return !!getBotToken();
}

function botHeaders(extra = {}) {
    return {
        Authorization: `Bot ${getBotToken()}`,
        ...extra
    };
}

async function readError(res) {
    const text = await res.text().catch(() => "");

    try {
        return JSON.parse(text);
    } catch {
        return {
            raw: text || null
        };
    }
}

function stringifyError(error) {
    if (!error) return "";
    if (typeof error === "string") return error;

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res) {
    const header = res.headers?.get?.("retry-after");
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10000);
    return null;
}

function normalizeDiscordApiUrl(input) {
    const url = input instanceof URL ? input : new URL(String(input || ""), BASE);

    if (url.origin !== DISCORD_API_ORIGIN || !url.pathname.startsWith("/api/")) {
        throw new Error("Blocked non-Discord API URL");
    }

    return url;
}

async function fetchWithRetry(url, options = {}) {
    const { retries, timeoutMs: rawTimeoutMs, label, ...fetchOptions } = options;
    const endpoint = normalizeDiscordApiUrl(url);
    const attempts = Math.max(1, Number(retries || 3) || 3);
    const timeoutMs = Math.max(1000, Number(rawTimeoutMs || 10000) || 10000);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(endpoint.href, {
                ...fetchOptions,
                signal: fetchOptions.signal || controller.signal
            });

            if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
                const retryAfter = parseRetryAfterMs(res);
                await sleep(retryAfter ?? Math.min(250 * attempt, 1500));
                continue;
            }

            return res;
        } catch (err) {
            lastError = err;
            if (attempt >= attempts) throw err;
            await sleep(Math.min(250 * attempt, 1500));
        } finally {
            clearTimeout(timer);
        }
    }

    throw lastError || new Error("Discord API request failed");
}

async function apiFetch(url, options = {}) {
    const res = await fetchWithRetry(url, options);

    if (!res.ok) {
        const error = await readError(res);
        throw new Error(
            `${options.label || "Discord API"} failed: ${res.status} ${stringifyError(error)}`.trim()
        );
    }

    return res;
}

async function safeApiFetch(url, options = {}) {
    const res = await fetchWithRetry(url, options);

    const data = await res.json().catch(async () => {
        const text = await res.text().catch(() => "");
        return text ? { raw: text } : null;
    });

    return {
        ok: res.ok,
        status: res.status,
        data
    };
}

function snowflake(value) {
    const v = String(value || "").trim();
    return /^\d{17,22}$/.test(v) ? v : null;
}

function toBigIntPermission(value) {
    try {
        return BigInt(String(value || "0"));
    } catch {
        return 0n;
    }
}

function hasPermission(permissionValue, flag) {
    const perms = toBigIntPermission(permissionValue);

    return (perms & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR ||
        (perms & flag) === flag;
}

function normalizeRole(role = {}) {
    return {
        id: role.id,
        name: role.name,
        color: role.color || 0,
        hoist: !!role.hoist,
        position: role.position || 0,
        permissions: role.permissions || "0",
        managed: !!role.managed,
        mentionable: !!role.mentionable,
        tags: role.tags || null
    };
}

function normalizeChannel(channel = {}) {
    return {
        id: channel.id,
        guildId: channel.guild_id || channel.guildId || null,
        name: channel.name,
        type: channel.type,
        parentId: channel.parent_id || null,
        position: channel.position || 0,
        permissionOverwrites: channel.permission_overwrites || channel.permissionOverwrites || [],
        topic: channel.topic || null,
        nsfw: !!channel.nsfw
    };
}

function sortRolesForDashboard(roles = []) {
    return roles
        .map(normalizeRole)
        .filter(role => role.id)
        .sort((a, b) => {
            if (b.position !== a.position) return b.position - a.position;
            return String(a.name || "").localeCompare(String(b.name || ""));
        });
}

function sortChannelsForDashboard(channels = []) {
    return channels
        .map(normalizeChannel)
        .filter(channel => channel.id && TEXT_CHANNEL_TYPES.has(channel.type))
        .sort((a, b) => {
            if (a.position !== b.position) return a.position - b.position;
            return String(a.name || "").localeCompare(String(b.name || ""));
        });
}

/* =============================================================================
   OAuth / User
============================================================================= */

async function exchangeCode(code, redirectUri) {
    const res = await apiFetch(`${BASE}/oauth2/token`, {
        label: "exchangeCode",
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            client_id: getClientId(),
            client_secret: getClientSecret(),
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri
        })
    });

    return res.json();
}

async function refreshToken(encryptedRefreshToken, redirectUri) {
    const refreshTokenValue = decryptToken(encryptedRefreshToken);

    if (!refreshTokenValue) {
        throw new Error("Cannot decrypt refresh token");
    }

    const res = await apiFetch(`${BASE}/oauth2/token`, {
        label: "refreshToken",
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            client_id: getClientId(),
            client_secret: getClientSecret(),
            grant_type: "refresh_token",
            refresh_token: refreshTokenValue,
            redirect_uri: redirectUri
        })
    });

    return res.json();
}

async function getUserProfile(accessToken) {
    const res = await apiFetch(`${BASE}/users/@me`, {
        label: "getUserProfile",
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    return res.json();
}

async function getUserConnections(accessToken) {
    const res = await fetchWithRetry(`${BASE}/users/@me/connections`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!res.ok) {
        const empty = [];
        empty.fetchFailed = true;
        empty.fetchStatus = res.status;
        return empty;
    }

    return res.json();
}

async function getUserGuilds(accessToken) {
    const res = await fetchWithRetry(`${BASE}/users/@me/guilds`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!res.ok) {
        const empty = [];
        empty.fetchFailed = true;
        empty.fetchStatus = res.status;
        return empty;
    }

    return res.json();
}

async function getGuildMember(accessToken, guildId) {
    getGuildMember.lastFetchFailed = false;
    getGuildMember.lastFetchStatus = null;

    const res = await fetchWithRetry(`${BASE}/users/@me/guilds/${guildId}/member`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!res.ok) {
        getGuildMember.lastFetchFailed = true;
        getGuildMember.lastFetchStatus = res.status;
        return null;
    }

    return res.json();
}

/* =============================================================================
   Bot Guild / Member / Roles / Channels
============================================================================= */

async function getCurrentBotUser() {
    if (!hasBotToken()) return null;

    const res = await fetchWithRetry(`${BASE}/users/@me`, {
        headers: botHeaders()
    });

    if (!res.ok) return null;

    return res.json();
}

async function getGuild(guildId) {
    const id = snowflake(guildId);
    if (!id || !hasBotToken()) return null;

    const res = await fetchWithRetry(`${BASE}/guilds/${id}?with_counts=true`, {
        headers: botHeaders()
    });

    if (!res.ok) return null;

    return res.json();
}

async function getGuildRoles(guildId) {
    const id = snowflake(guildId);
    if (!id || !hasBotToken()) return [];

    const res = await fetchWithRetry(`${BASE}/guilds/${id}/roles`, {
        headers: botHeaders()
    });

    if (!res.ok) return [];

    const roles = await res.json();
    return sortRolesForDashboard(Array.isArray(roles) ? roles : []);
}

async function getGuildChannels(guildId) {
    const id = snowflake(guildId);
    if (!id || !hasBotToken()) return [];

    const res = await fetchWithRetry(`${BASE}/guilds/${id}/channels`, {
        headers: botHeaders()
    });

    if (!res.ok) return [];

    const channels = await res.json();

    return sortChannelsForDashboard(
        Array.isArray(channels)
            ? channels.map(channel => ({
                ...channel,
                guild_id: channel.guild_id || id
            }))
            : []
    );
}

async function getGuildMemberWithBot(guildId, userId) {
    const gid = snowflake(guildId);
    const uid = snowflake(userId);

    if (!gid || !uid || !hasBotToken()) return null;

    const res = await fetchWithRetry(`${BASE}/guilds/${gid}/members/${uid}`, {
        headers: botHeaders()
    });

    if (!res.ok) return null;

    return res.json();
}

async function getBotMember(guildId, botUserId = null) {
    const bot = botUserId ? { id: botUserId } : await getCurrentBotUser();

    if (!bot?.id) return null;

    return getGuildMemberWithBot(guildId, bot.id);
}

function resolveMemberHighestRole(member, roles = []) {
    if (!member?.roles || !Array.isArray(member.roles)) {
        return null;
    }

    const roleMap = new Map(roles.map(role => [String(role.id), role]));

    let highest = null;

    for (const roleId of member.roles) {
        const role = roleMap.get(String(roleId));
        if (!role) continue;

        if (!highest || Number(role.position || 0) > Number(highest.position || 0)) {
            highest = role;
        }
    }

    return highest;
}

function computeMemberGuildPermissions(member, roles = []) {
    if (!member?.roles || !Array.isArray(member.roles)) {
        return "0";
    }

    const roleMap = new Map(roles.map(role => [String(role.id), role]));
    let perms = 0n;

    for (const roleId of member.roles) {
        const role = roleMap.get(String(roleId));
        if (!role) continue;

        perms |= toBigIntPermission(role.permissions);
    }

    return perms.toString();
}

function applyChannelOverwrites(basePermissions, member, channel) {
    let perms = toBigIntPermission(basePermissions);

    if ((perms & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) {
        return perms.toString();
    }

    const overwrites = Array.isArray(channel?.permissionOverwrites)
        ? channel.permissionOverwrites
        : Array.isArray(channel?.permission_overwrites)
            ? channel.permission_overwrites
            : [];

    const guildId = String(channel?.guildId || channel?.guild_id || "");
    const memberRoleIds = new Set((member?.roles || []).map(String));
    const memberUserId = String(member?.user?.id || member?.id || "");

    /*
      Discord permission overwrite order:
      1. @everyone overwrite = overwrite id ตรงกับ guildId
      2. role overwrites ของ role ที่ member มี
      3. member-specific overwrite
    */

    // 1) @everyone overwrite
    for (const ow of overwrites) {
        if (Number(ow.type) !== 0) continue;
        if (!guildId || String(ow.id) !== guildId) continue;

        perms &= ~toBigIntPermission(ow.deny);
        perms |= toBigIntPermission(ow.allow);
    }

    // 2) role overwrites
    for (const ow of overwrites) {
        if (Number(ow.type) !== 0) continue;
        if (guildId && String(ow.id) === guildId) continue;
        if (!memberRoleIds.has(String(ow.id))) continue;

        perms &= ~toBigIntPermission(ow.deny);
        perms |= toBigIntPermission(ow.allow);
    }

    // 3) member-specific overwrite
    for (const ow of overwrites) {
        if (Number(ow.type) !== 1) continue;
        if (String(ow.id) !== memberUserId) continue;

        perms &= ~toBigIntPermission(ow.deny);
        perms |= toBigIntPermission(ow.allow);
    }

    return perms.toString();
}

function validateBotCanManageRole({ botMember, roles, targetRoleId }) {
    const target = roles.find(role => String(role.id) === String(targetRoleId));
    const highest = resolveMemberHighestRole(botMember, roles);
    const guildPerms = computeMemberGuildPermissions(botMember, roles);

    const checks = [];
    const errors = [];
    const warnings = [];

    if (!target) {
        errors.push("ไม่พบ role เป้าหมายในเซิร์ฟเวอร์");
        checks.push({
            name: "role_exists",
            label: "พบ role เป้าหมาย",
            ok: false,
            detail: "Role ID ไม่ตรงกับ role ในเซิร์ฟเวอร์"
        });

        return {
            ok: false,
            target,
            highest,
            checks,
            warnings,
            errors
        };
    }

    checks.push({
        name: "role_exists",
        label: "พบ role เป้าหมาย",
        ok: true,
        detail: `${target.name} (${target.id})`
    });

    const hasManageRoles = hasPermission(guildPerms, PERMISSIONS.MANAGE_ROLES);

    checks.push({
        name: "manage_roles",
        label: "บอทมีสิทธิ์ Manage Roles",
        ok: hasManageRoles,
        detail: hasManageRoles ? "ผ่าน" : "บอทไม่มีสิทธิ์ Manage Roles"
    });

    if (!hasManageRoles) {
        errors.push("บอทไม่มีสิทธิ์ Manage Roles");
    }
      checks.push({
        name: "role_not_managed",
        label: "Role ไม่ใช่ managed role",
        ok: !target.managed,
        detail: target.managed ? "Role นี้ถูกจัดการโดย integration/bot อื่น" : "ผ่าน"
    });

    if (target.managed) {
        errors.push("Role เป้าหมายเป็น managed role ไม่สามารถให้ด้วยบอทได้");
    }

    const hierarchyOk = !!highest && Number(target.position || 0) < Number(highest.position || 0);

    checks.push({
        name: "role_hierarchy",
        label: "ยศบอทสูงกว่า role เป้าหมาย",
        ok: hierarchyOk,
        detail: highest
            ? `Bot highest: ${highest.name} (${highest.position}) / Target: ${target.name} (${target.position})`
            : "ไม่พบ highest role ของบอท"
    });

    if (!hierarchyOk) {
        errors.push("ยศบอทต้องอยู่สูงกว่า role ที่จะให้");
    }

    return {
        ok: errors.length === 0,
        target,
        highest,
        checks,
        warnings,
        errors
    };
}

function validateBotCanUseChannel({ botMember, roles, channel }) {
    const guildPerms = computeMemberGuildPermissions(botMember, roles);
    const channelPerms = applyChannelOverwrites(guildPerms, botMember, channel);

    const canView = hasPermission(channelPerms, PERMISSIONS.VIEW_CHANNEL);
    const canSend = hasPermission(channelPerms, PERMISSIONS.SEND_MESSAGES);
    const canEmbed = hasPermission(channelPerms, PERMISSIONS.EMBED_LINKS);

    const checks = [
        {
            name: "channel_exists",
            label: "พบ channel เป้าหมาย",
            ok: !!channel,
            detail: channel ? `#${channel.name} (${channel.id})` : "ไม่พบ channel"
        },
        {
            name: "view_channel",
            label: "บอทมองเห็นห้อง",
            ok: !!channel && canView,
            detail: !!channel && canView ? "ผ่าน" : "บอทไม่มีสิทธิ์ View Channel หรือไม่พบห้อง"
        },
        {
            name: "send_messages",
            label: "บอทส่งข้อความได้",
            ok: !!channel && canSend,
            detail: !!channel && canSend ? "ผ่าน" : "บอทไม่มีสิทธิ์ Send Messages หรือไม่พบห้อง"
        },
        {
            name: "embed_links",
            label: "บอทส่ง Embed ได้",
            ok: !!channel && canEmbed,
            detail: !!channel && canEmbed ? "ผ่าน" : "บอทไม่มีสิทธิ์ Embed Links หรือไม่พบห้อง"
        }
    ];

    const errors = [];

    if (!channel) errors.push("ไม่พบ channel เป้าหมาย");
    if (channel && !canView) errors.push("บอทไม่มีสิทธิ์ View Channel");
    if (channel && !canSend) errors.push("บอทไม่มีสิทธิ์ Send Messages");
    if (channel && !canEmbed) errors.push("บอทไม่มีสิทธิ์ Embed Links");

    return {
        ok: errors.length === 0,
        checks,
        warnings: [],
        errors
    };
}

/* =============================================================================
   Guild Join / Role
============================================================================= */

async function addMemberToGuild(guildId, userId, accessToken) {
    if (!guildId || !userId || !accessToken) {
        return {
            ok: false,
            status: 400,
            error: "Missing guildId/userId/accessToken"
        };
    }

    if (!hasBotToken()) {
        return {
            ok: false,
            status: 500,
            error: "Missing bot token"
        };
    }

    const res = await fetchWithRetry(`${BASE}/guilds/${guildId}/members/${userId}`, {
        method: "PUT",
        headers: {
            Authorization: `Bot ${getBotToken()}`,
            "Content-Type": "application/json",
            "X-Audit-Log-Reason": encodeURIComponent("OAuth2 Verification guilds.join")
        },
        body: JSON.stringify({
            access_token: accessToken
        })
    });

    if (res.status === 201 || res.status === 204) {
        return {
            ok: true,
            status: res.status
        };
    }

    const error = await readError(res);

    return {
        ok: false,
        status: res.status,
        error
    };
}

async function addRoleToMember(guildId, userId, roleId) {
    if (!guildId || !userId || !roleId) {
        return {
            ok: false,
            status: 400,
            error: "Missing guildId/userId/roleId"
        };
    }

    if (!hasBotToken()) {
        return {
            ok: false,
            status: 500,
            error: "Missing bot token"
        };
    }

    const res = await fetchWithRetry(`${BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
        method: "PUT",
        headers: {
            Authorization: `Bot ${getBotToken()}`,
            "X-Audit-Log-Reason": encodeURIComponent("OAuth2 Verification role grant")
        }
    });

    if (res.status === 204) {
        return {
            ok: true,
            status: 204
        };
    }

    const error = await readError(res);

    return {
        ok: false,
        status: res.status,
        error
    };
}

/* =============================================================================
   Messages / Verification Panel
============================================================================= */

async function getChannel(channelId) {
    const id = snowflake(channelId);
    if (!id || !hasBotToken()) return null;

    const res = await fetchWithRetry(`${BASE}/channels/${id}`, {
        headers: botHeaders()
    });

    if (!res.ok) return null;

    return normalizeChannel(await res.json());
}

async function fetchChannelMessage(channelId, messageId) {
    const cid = snowflake(channelId);
    const mid = snowflake(messageId);

    if (!cid || !mid || !hasBotToken()) {
        return {
            ok: false,
            status: 400,
            error: "Missing channelId/messageId/bot token"
        };
    }

    const res = await fetchWithRetry(`${BASE}/channels/${cid}/messages/${mid}`, {
        headers: botHeaders()
    });

    if (!res.ok) {
        const error = await readError(res);

        return {
            ok: false,
            status: res.status,
            error
        };
    }

    return {
        ok: true,
        status: res.status,
        message: await res.json()
    };
}

async function createChannelMessage(channelId, payload) {
    const cid = snowflake(channelId);

    if (!cid || !hasBotToken()) {
        return {
            ok: false,
            status: 400,
            error: "Missing channelId/bot token"
        };
    }

    const res = await fetchWithRetry(`${BASE}/channels/${cid}/messages`, {
        method: "POST",
        headers: botHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const error = await readError(res);

        return {
            ok: false,
            status: res.status,
            error
        };
    }

    return {
        ok: true,
        status: res.status,
        message: await res.json()
    };
}

async function editChannelMessage(channelId, messageId, payload) {
    const cid = snowflake(channelId);
    const mid = snowflake(messageId);

    if (!cid || !mid || !hasBotToken()) {
        return {
            ok: false,
            status: 400,
            error: "Missing channelId/messageId/bot token"
        };
    }

    const res = await fetchWithRetry(`${BASE}/channels/${cid}/messages/${mid}`, {
        method: "PATCH",
        headers: botHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const error = await readError(res);

        return {
            ok: false,
            status: res.status,
            error
        };
    }

    return {
        ok: true,
        status: res.status,
        message: await res.json()
    };
}

/* =============================================================================
   DM
============================================================================= */

async function createDMChannel(userId) {
    const uid = snowflake(userId);

    if (!uid || !hasBotToken()) return null;

    const res = await fetchWithRetry(`${BASE}/users/@me/channels`, {
        method: "POST",
        headers: botHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            recipient_id: uid
        })
    });

    if (!res.ok) return null;

    return res.json();
}

async function sendDM(userId, payload) {
    const channel = await createDMChannel(userId);

    if (!channel?.id) return false;

    const res = await fetchWithRetry(`${BASE}/channels/${channel.id}/messages`, {
        method: "POST",
        headers: botHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
    });

    return res.ok;
}

async function sendVerificationDM(userId, data = {}) {
    if (!userId) return false;

    const ok = !!data.ok;
    const guildName = data.guildName || "Discord Server";
    const roleName = data.roleName || null;
    const reason = data.reason || (ok ? "ยืนยันสำเร็จ" : "ยืนยันไม่สำเร็จ");

    return sendDM(userId, {
        embeds: [
            {
                title: ok ? "✅ ยืนยันตัวตนสำเร็จ" : "❌ ยืนยันตัวตนไม่สำเร็จ",
                description: ok
                    ? `คุณยืนยันตัวตนใน **${guildName}** สำเร็จแล้ว${roleName ? ` และได้รับยศ **${roleName}**` : ""}`
                    : `การยืนยันตัวตนใน **${guildName}** ไม่สำเร็จ\nเหตุผล: ${reason}`,
                color: ok ? 0x45e67a : 0xef4444,
                timestamp: new Date().toISOString(),
                footer: {
                    text: "Verification System"
                }
            }
        ]
    });
}

/* =============================================================================
   Token Storage
============================================================================= */

function prepareTokenStorage(tokenData = {}) {
    return {
        encryptedAccessToken: encryptToken(tokenData.access_token || ""),
        encryptedRefreshToken: encryptToken(tokenData.refresh_token || ""),
        expiresAt: Date.now() + ((tokenData.expires_in || 0) * 1000),
        scope: tokenData.scope || "",
        tokenType: tokenData.token_type || "Bearer",
        lastRefreshAt: null,
        refreshFailCount: 0,
        revokedAt: null,
        rawTokenMeta: {
            expiresIn: tokenData.expires_in || null,
            receivedAt: Date.now()
        }
    };
}

module.exports = {
    BASE,
    PERMISSIONS,

    getClientId,
    getClientSecret,
    getBotToken,
    hasBotToken,

    readError,
    stringifyError,
    apiFetch,
    safeApiFetch,

    snowflake,
    toBigIntPermission,
    hasPermission,

    normalizeRole,
    normalizeChannel,
    sortRolesForDashboard,
    sortChannelsForDashboard,

    exchangeCode,
    refreshToken,
    getUserProfile,
    getUserConnections,
    getUserGuilds,
    getGuildMember,

    getCurrentBotUser,
    getGuild,
    getGuildRoles,
    getGuildChannels,
    getGuildMemberWithBot,
    getBotMember,
    resolveMemberHighestRole,
    computeMemberGuildPermissions,
    applyChannelOverwrites,
    validateBotCanManageRole,
    validateBotCanUseChannel,

    addMemberToGuild,
    addRoleToMember,

    getChannel,
    fetchChannelMessage,
    createChannelMessage,
    editChannelMessage,

    createDMChannel,
    sendDM,
    sendVerificationDM,

    prepareTokenStorage
};
