"use strict";

const { Options } = require("discord.js");
const { Intents } = require("./discordCompat");
const { readFiniteInteger } = require("./numbers");

function boundedNumber(rawValue, fallback, minimum, maximum = 10_000) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed === 0) return fallback;
    return readFiniteInteger(parsed, { fallback, min: minimum, max: maximum });
}

function buildMainClientOptions(env = process.env) {
    const messageCacheMax = boundedNumber(env.DISCORD_MESSAGE_CACHE_MAX, 75, 20);
    const messageSweepInterval = boundedNumber(env.DISCORD_MESSAGE_SWEEP_INTERVAL_SEC, 300, 60);
    const messageSweepLifetime = boundedNumber(env.DISCORD_MESSAGE_SWEEP_LIFETIME_SEC, 900, 60);

    return {
        intents: [
            Intents.FLAGS.GUILDS,
            Intents.FLAGS.GUILD_MESSAGES,
            Intents.FLAGS.GUILD_VOICE_STATES,
            Intents.FLAGS.GUILD_MEMBERS,
            Intents.FLAGS.GUILD_MODERATION,
            Intents.FLAGS.MESSAGE_CONTENT
        ],
        makeCache: Options.cacheWithLimits({
            MessageManager: {
                maxSize: messageCacheMax
            },
            GuildMemberManager: 200,
            UserManager: 200,
            ReactionManager: 0
        }),
        sweepers: {
            ...Options.DefaultSweeperSettings,
            messages: {
                interval: messageSweepInterval,
                lifetime: messageSweepLifetime
            }
        }
    };
}

module.exports = {
    buildMainClientOptions,
    _test: { boundedNumber }
};
