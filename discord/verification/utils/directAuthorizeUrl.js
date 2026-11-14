"use strict";

const { trimTrailingSlashes } = require("../../core/publicUrl");
const { createDirectPanelState } = require("./state");

const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";
const MAX_DISCORD_BUTTON_URL_LENGTH = 512;

function buildDirectDiscordAuthorizeUrl({
    clientId,
    baseUrl,
    guildId,
    roleId,
    expectedUserId = null,
    panelRevision = null,
    scope = VERIFY_SCOPE
} = {}) {
    const resolvedClientId = String(clientId || "").trim();
    if (!resolvedClientId) {
        throw new Error("Missing DISCORD_CLIENT_ID");
    }

    const resolvedBaseUrl = trimTrailingSlashes(baseUrl);
    if (!resolvedBaseUrl) {
        throw new Error("Missing PUBLIC_DASHBOARD_URL/DASHBOARD_URL/PUBLIC_BASE_URL");
    }

    const redirectUri = `${resolvedBaseUrl}/auth/callback`;

    const state = createDirectPanelState({
        guildId,
        roleId,
        expectedUserId,
        panelRevision
    });

    const params = new URLSearchParams({
        client_id: resolvedClientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope,
        state,
        prompt: "consent"
    });

    const url = `https://discord.com/oauth2/authorize?${params.toString()}`;

    if (url.length > MAX_DISCORD_BUTTON_URL_LENGTH) {
        throw new Error(`Direct OAuth URL too long (${url.length}/${MAX_DISCORD_BUTTON_URL_LENGTH}). Use a shorter domain or panel revision.`);
    }

    return url;
}

module.exports = {
    VERIFY_SCOPE,
    MAX_DISCORD_BUTTON_URL_LENGTH,
    buildDirectDiscordAuthorizeUrl
};
