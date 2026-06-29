"use strict";

const DISCORD_ID_REGEX = /^\d{17,22}$/;
const PANEL_FIELD_ID_REGEX = /^\d{17,19}$/;

function normalizeDiscordId(value) {
    const id = String(value || "").trim();
    return DISCORD_ID_REGEX.test(id) ? id : null;
}

module.exports = { DISCORD_ID_REGEX, PANEL_FIELD_ID_REGEX, normalizeDiscordId };
