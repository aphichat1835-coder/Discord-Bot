"use strict";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,22}$/;

function normalizeDiscordSnowflake(value) {
    const text = String(value ?? "").trim();
    return DISCORD_SNOWFLAKE_PATTERN.test(text) ? text : null;
}

function isDiscordSnowflake(value) {
    return normalizeDiscordSnowflake(value) !== null;
}

module.exports = {
    DISCORD_SNOWFLAKE_PATTERN,
    isDiscordSnowflake,
    normalizeDiscordSnowflake
};
