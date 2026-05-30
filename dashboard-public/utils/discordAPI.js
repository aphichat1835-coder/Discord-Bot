const { encryptToken, decryptToken } = require('./crypto');

const BASE      = 'https://discord.com/api/v10';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.TOKEN_MANAGER;

async function exchangeCode(code, redirectUri) {
    const res = await fetch(`${BASE}/oauth2/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri })
    });
    if (!res.ok) throw new Error(`exchangeCode failed: ${await res.text()}`);
    return res.json();
}

async function getUserProfile(accessToken) {
    const res = await fetch(`${BASE}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error('getUserProfile failed');
    return res.json();
}

async function getUserConnections(accessToken) {
    const res = await fetch(`${BASE}/users/@me/connections`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return [];
    return res.json();
}

async function getUserGuilds(accessToken) {
    const res = await fetch(`${BASE}/users/@me/guilds`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return [];
    return res.json();
}

async function getGuildMember(accessToken, guildId) {
    const res = await fetch(`${BASE}/users/@me/guilds/${guildId}/member`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    return res.json();
}

// ใช้ BOT token เพื่อให้ยศ (ไม่ต้องการ user token)
async function addRoleToMember(guildId, userId, roleId) {
    const res = await fetch(`${BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
        method:  'PUT',
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'X-Audit-Log-Reason': 'OAuth2 Verification' }
    });
    return res.status === 204;
}

function prepareTokenStorage(tokenData) {
    return {
        encryptedAccessToken:  encryptToken(tokenData.access_token),
        encryptedRefreshToken: encryptToken(tokenData.refresh_token || ''),
        expiresAt: Date.now() + (tokenData.expires_in * 1000),
        scope:     tokenData.scope || ''
    };
}

async function refreshToken(encryptedRefreshToken, redirectUri) {
    const refreshToken = decryptToken(encryptedRefreshToken);
    if (!refreshToken) throw new Error('Cannot decrypt refresh token');
    const res = await fetch(`${BASE}/oauth2/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken })
    });
    if (!res.ok) throw new Error('Token refresh failed');
    return res.json();
}

module.exports = {
    exchangeCode, getUserProfile, getUserConnections,
    getUserGuilds, getGuildMember, addRoleToMember,
    prepareTokenStorage, refreshToken
};
