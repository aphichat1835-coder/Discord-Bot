#!/usr/bin/env python3
"""Apply the scoped Discord v14 and retry lifecycle regression fixes.

This is a one-time branch repair helper. It fails closed if the expected source
neighborhood has changed, so it cannot silently patch an unrelated revision.
"""

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}, found {count}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "discord/index.js",
    '''const { Client, Options, LimitedCollection } = require("discord.js");
const { Intents, resolveActivityType } = require("./core/discordCompat");''',
    '''const { Client } = require("discord.js");
const { resolveActivityType } = require("./core/discordCompat");
const { buildMainClientOptions } = require("./core/mainClientOptions");'''
)

replace_once(
    "discord/index.js",
    '''const MAIN_MESSAGE_CACHE_MAX = Math.max(20, Number(process.env.DISCORD_MESSAGE_CACHE_MAX || 75) || 75);
const MAIN_MESSAGE_SWEEP_INTERVAL = Math.max(60, Number(process.env.DISCORD_MESSAGE_SWEEP_INTERVAL_SEC || 300) || 300);
const MAIN_MESSAGE_SWEEP_LIFETIME = Math.max(60, Number(process.env.DISCORD_MESSAGE_SWEEP_LIFETIME_SEC || 900) || 900);
const ROTATE_MESSAGES_MAX = Math.max(1, Number(process.env.ROTATE_MESSAGES_MAX || 20) || 20);

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.MESSAGE_CONTENT
    ],
    makeCache: Options.cacheWithLimits({
        MessageManager: {
            maxSize: MAIN_MESSAGE_CACHE_MAX,
            sweepInterval: MAIN_MESSAGE_SWEEP_INTERVAL,
            sweepFilter: LimitedCollection.filterByLifetime({
                lifetime: MAIN_MESSAGE_SWEEP_LIFETIME,
                getComparisonTimestamp: message => message.editedTimestamp ?? message.createdTimestamp
            })
        },
        GuildMemberManager: 200,
        UserManager: 200,
        ReactionManager: 0
    }),
    sweepers: {
        ...Options.defaultSweeperSettings,
        messages: {
            interval: MAIN_MESSAGE_SWEEP_INTERVAL,
            lifetime: MAIN_MESSAGE_SWEEP_LIFETIME
        }
    }
});''',
    '''const ROTATE_MESSAGES_MAX = Math.max(1, Number(process.env.ROTATE_MESSAGES_MAX || 20) || 20);

const client = new Client(buildMainClientOptions(process.env));'''
)

replace_once(
    "discord/verification/services/oauthSnapshotStore.js",
    '''function delay(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}''',
    '''function delay(ms) {
    if (!ms) return Promise.resolve();
    // This timer is awaited control flow. Keep it ref'd so the promise can settle
    // in isolated workers and native node:test runs.
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}'''
)

replace_once(
    "discord/verification/utils/discordAPI.js",
    '''function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}''',
    '''function sleep(ms) {
    // Retry backoff is awaited control flow; an unref'd timer can let Node exit
    // while the returned promise is still pending.
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}'''
)

replace_once(
    "discord/verification/utils/discordAPI.js",
    '''    if (bytes > DISCORD_API_BODY_MAX_BYTES) {
        requestDiagnostics.requestBodyTooLarge += 1;
        throw new Error(`Discord API request body too large: ${bytes} bytes`);
    }''',
    '''    if (bytes > DISCORD_API_BODY_MAX_BYTES) {
        requestDiagnostics.requestBodyTooLarge += 1;
        const error = new Error(`Discord API request body too large: ${bytes} bytes`);
        error.code = "discord_request_body_too_large";
        error.retryable = false;
        throw error;
    }'''
)

replace_once(
    "discord/verification/utils/discordAPI.js",
    '''        } catch (err) {
            lastError = err;
            if (attempt >= attempts) throw err;
            await sleep(Math.min(250 * attempt, 1500));
        } finally {''',
    '''        } catch (err) {
            lastError = err;
            if (err?.retryable === false || attempt >= attempts) throw err;
            await sleep(Math.min(250 * attempt, 1500));
        } finally {'''
)

Path("discord/core/mainClientOptions.js").write_text('''"use strict";

const { Options } = require("discord.js");
const { Intents } = require("./discordCompat");

function boundedNumber(rawValue, fallback, minimum) {
    const resolved = Number(rawValue ?? fallback) || fallback;
    return Math.max(minimum, resolved);
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
    buildMainClientOptions
};
''', encoding="utf-8")

Path("discord/tests/mainClientOptions.test.js").write_text('''"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, Options } = require("discord.js");
const { buildMainClientOptions } = require("../core/mainClientOptions");

test("builds discord.js v14 client options with cache and default sweepers", async () => {
    const options = buildMainClientOptions({
        DISCORD_MESSAGE_CACHE_MAX: "42",
        DISCORD_MESSAGE_SWEEP_INTERVAL_SEC: "60",
        DISCORD_MESSAGE_SWEEP_LIFETIME_SEC: "120"
    });

    assert.equal(typeof options.makeCache, "function");
    assert.equal(options.sweepers.messages.interval, 60);
    assert.equal(options.sweepers.messages.lifetime, 120);
    assert.equal(
        options.sweepers.threads.interval,
        Options.DefaultSweeperSettings.threads.interval
    );
    assert.equal(
        options.sweepers.threads.lifetime,
        Options.DefaultSweeperSettings.threads.lifetime
    );

    const client = new Client(options);
    assert.equal(client.options.sweepers.messages.interval, 60);
    assert.equal(client.options.sweepers.messages.lifetime, 120);
    await client.destroy();
});
''', encoding="utf-8")
