const { encryptToken, decryptToken } = require('./crypto');

const BASE = 'https://discord.com/api/v10';

function getClientId() {
    return process.env.DISCORD_CLIENT_ID;
}

function getClientSecret() {
    return process.env.DISCORD_CLIENT_SECRET;
}

function getBotToken() {
    return process.env.TOKEN_MANAGER;
}

async function readError(res) {
    const text = await res.text().catch(() => '');

    try {
        return JSON.parse(text);
    } catch {
        return {
            raw: text || null
        };
    }
}

function stringifyError(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);

    if (!res.ok) {
        const error = await readError(res);
        throw new Error(
            `${options.label || 'Discord API'} failed: ${res.status} ${stringifyError(error)}`.trim()
        );
    }

    return res;
}

async function exchangeCode(code, redirectUri) {
    const res = await apiFetch(`${BASE}/oauth2/token`, {
        label: 'exchangeCode',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: getClientId(),
            client_secret: getClientSecret(),
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        })
    });

    return res.json();
}

async function getUserProfile(accessToken) {
    const res = await apiFetch(`${BASE}/users/@me`, {
        label: 'getUserProfile',
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    return res.json();
}

async function getUserConnections(accessToken) {
    const res = await fetch(`${BASE}/users/@me/connections`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!res.ok) return [];

    return res.json();
}

async function getUserGuilds(accessToken) {
    const res = await fetch(`${BASE}/users/@me/guilds`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!res.ok) return [];

    return res.json();
}

async function getGuildMember(accessToken, guildId) {
    const res = await fetch(`${BASE}/users/@me/guilds/${guildId}/member`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!res.ok) return null;

    return res.json();
}

async function getGuildMemberWithBot(guildId, userId) {
    if (!guildId || !userId) return null;

    const res = await fetch(`${BASE}/guilds/${guildId}/members/${userId}`, {
        headers: {
            Authorization: `Bot ${getBotToken()}`
        }
    });

    if (!res.ok) return null;

    return res.json();
}

async function addMemberToGuild(guildId, userId, accessToken) {
    if (!guildId || !userId || !accessToken) {
        return {
            ok: false,
            status: 400,
            error: 'Missing guildId/userId/accessToken'
        };
    }

    const res = await fetch(`${BASE}/guilds/${guildId}/members/${userId}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bot ${getBotToken()}`,
            'Content-Type': 'application/json',
            'X-Audit-Log-Reason': encodeURIComponent('OAuth2 Verification guilds.join')
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
            error: 'Missing guildId/userId/roleId'
        };
    }

    const res = await fetch(`${BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bot ${getBotToken()}`,
            'X-Audit-Log-Reason': encodeURIComponent('OAuth2 Verification role grant')
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

async function createDMChannel(userId) {
    const res = await fetch(`${BASE}/users/@me/channels`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${getBotToken()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            recipient_id: userId
        })
    });

    if (!res.ok) return null;

    return res.json();
}

async function sendDM(userId, payload) {
    const channel = await createDMChannel(userId);

    if (!channel?.id) return false;

    const res = await fetch(`${BASE}/channels/${channel.id}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${getBotToken()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    return res.ok;
}

async function sendVerificationDM(userId, data = {}) {
    if (!userId) return false;

    const ok = !!data.ok;
    const guildName = data.guildName || 'Discord Server';
    const roleName = data.roleName || null;
    const reason = data.reason || (ok ? 'ยืนยันสำเร็จ' : 'ยืนยันไม่สำเร็จ');

    return sendDM(userId, {
        embeds: [
            {
                title: ok ? '✅ ยืนยันตัวตนสำเร็จ' : '❌ ยืนยันตัวตนไม่สำเร็จ',
                description: ok
                    ? `คุณยืนยันตัวตนใน **${guildName}** สำเร็จแล้ว${roleName ? ` และได้รับยศ **${roleName}**` : ''}`
                    : `การยืนยันตัวตนใน **${guildName}** ไม่สำเร็จ\nเหตุผล: ${reason}`,
                color: ok ? 0x45e67a : 0xef4444,
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'Verification System'
                }
            }
        ]
    });
}

function prepareTokenStorage(tokenData) {
    return {
        encryptedAccessToken: encryptToken(tokenData.access_token),
        encryptedRefreshToken: encryptToken(tokenData.refresh_token || ''),
        expiresAt: Date.now() + ((tokenData.expires_in || 0) * 1000),
        scope: tokenData.scope || '',
        tokenType: tokenData.token_type || 'Bearer',
        lastRefreshAt: null,
        refreshFailCount: 0,
        revokedAt: null,
        rawTokenMeta: {
            expiresIn: tokenData.expires_in || null,
            receivedAt: Date.now()
        }
    };
}

async function refreshToken(encryptedRefreshToken, redirectUri) {
    const refreshTokenValue = decryptToken(encryptedRefreshToken);

    if (!refreshTokenValue) {
        throw new Error('Cannot decrypt refresh token');
    }

    const res = await apiFetch(`${BASE}/oauth2/token`, {
        label: 'refreshToken',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: getClientId(),
            client_secret: getClientSecret(),
            grant_type: 'refresh_token',
            refresh_token: refreshTokenValue,
            redirect_uri: redirectUri
        })
    });

    return res.json();
}

module.exports = {
    exchangeCode,
    getUserProfile,
    getUserConnections,
    getUserGuilds,
    getGuildMember,
    getGuildMemberWithBot,
    addMemberToGuild,
    addRoleToMember,
    createDMChannel,
    sendDM,
    sendVerificationDM,
    prepareTokenStorage,
    refreshToken,
    stringifyError
};
