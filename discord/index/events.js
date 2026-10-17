'use strict';

/**
 * Discord Event Router & Lifecycle Coordinator
 * Orchestrates event modular sub-handlers:
 * - messages: Anti-Raid, Anti-Spam, Link Filter, secret commands
 * - interactions: Commands, cooldowns, role buttons, telemetry
 * - guild: guildCreate, guildDelete lifecycle
 * - voice: voice admin audit & member tracking
 */

const { readFiniteInteger } = require('../core/numbers');
const voiceAdmin = require('../features/voiceAdmin');
const {
    handleMessageCreateEvent,
    setupSpamCleanupTimer,
    mergeProtectionFindings,
    executeProtectionAction,
    collectMessageProtectionFindings
} = require('./events/messages');
const {
    handleInteractionCreateEvent,
    checkProtectedCommandAccess,
    checkDisabledCommand
} = require('./events/interactions');
const {
    handleGuildCreateEvent,
    handleGuildDeleteEvent
} = require('./events/guild');
const {
    attachVoiceAdminListeners
} = require('./events/voice');

function register({
    client, config, sessionManager, voiceWorker,
    commands,
    spamTracking,
    disabledCommands, commandCooldowns, COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS, SHADOW_MASTER_ID,
    checkApproval, MAX_SPAM_USERS
}) {
    const commandInFlight = new Set();
    const spamCleanupMs = readFiniteInteger(process.env.SPAM_TRACKING_CLEANUP_MS, { fallback: 60000, min: 30000, max: 60 * 60 * 1000 });
    const spamEntryTtlMs = readFiniteInteger(process.env.SPAM_TRACKING_ENTRY_TTL_MS, { fallback: 5 * 60 * 1000, min: 60000, max: 24 * 60 * 60 * 1000 });
    const commandCooldownMaxUsers = readFiniteInteger(process.env.COMMAND_COOLDOWN_MAX_USERS, { fallback: 5000, min: 100, max: 100000 });

    const spamCleanupTimer = setupSpamCleanupTimer(spamTracking, MAX_SPAM_USERS, spamEntryTtlMs, spamCleanupMs);
    const detachVoiceAdmin = attachVoiceAdminListeners(client);

    const antiRaidState = { cache: null, expiry: 0 };

    const onMessageCreate = message => {
        handleMessageCreateEvent({
            message, commands, sessionManager, spamTracking, config, antiRaidState, MAX_SPAM_USERS
        }).catch(err => {
            console.error(`[EVENTS] messageCreate safe error: ${err?.message || err}`);
        });
    };

    const onInteractionCreate = interaction => {
        handleInteractionCreateEvent({
            interaction, config, SHADOW_MASTER_ID, disabledCommands, commandCooldowns,
            COMMAND_COOLDOWNS_MS, DEFAULT_COOLDOWN_MS, commandCooldownMaxUsers,
            commandInFlight, commands, client
        }).catch(err => {
            console.error(`[EVENTS] interactionCreate safe error: ${err?.message || err}`);
        });
    };

    const onGuildCreate = guild => {
        Promise.resolve(handleGuildCreateEvent(guild)).catch(err => {
            console.error(`[EVENTS] guildCreate safe error: ${err?.message || err}`);
        });
    };

    const onGuildDelete = guild => {
        Promise.resolve(handleGuildDeleteEvent(guild, commands)).catch(err => {
            console.error(`[EVENTS] guildDelete safe error: ${err?.message || err}`);
        });
    };

    client.on("messageCreate", onMessageCreate);
    client.on("interactionCreate", onInteractionCreate);
    client.on("guildCreate", onGuildCreate);
    client.on("guildDelete", onGuildDelete);

    const stop = async () => {
        clearInterval(spamCleanupTimer);
        detachVoiceAdmin();
        client.off("messageCreate", onMessageCreate);
        client.off("interactionCreate", onInteractionCreate);
        client.off("guildCreate", onGuildCreate);
        client.off("guildDelete", onGuildDelete);
        await voiceAdmin.stop();
    };

    return { stop };
}

module.exports = {
    register,
    _test: {
        mergeProtectionFindings,
        executeProtectionAction,
        collectMessageProtectionFindings,
        checkProtectedCommandAccess,
        checkDisabledCommand
    }
};
