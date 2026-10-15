'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const events = require('../index/events');

test('events lifecycle: registers all listeners and unhooks completely on stop', async () => {
    const client = new EventEmitter();
    const spamTracking = new Map();
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWNS_MS = {};
    const disabledCommands = new Set();

    const runtime = events.register({
        client,
        config: { system: { ownerId: '123' }, roles: {} },
        sessionManager: { getSetting: async () => true },
        voiceWorker: {},
        commands: { cleanupGuild: async () => {} },
        spamTracking,
        disabledCommands,
        commandCooldowns,
        COMMAND_COOLDOWNS_MS,
        DEFAULT_COOLDOWN_MS: 3000,
        SHADOW_MASTER_ID: '456',
        MAX_SPAM_USERS: 100
    });

    // Check that listeners are registered
    assert.equal(client.listenerCount('messageCreate'), 1);
    assert.equal(client.listenerCount('interactionCreate'), 1);
    assert.equal(client.listenerCount('guildCreate'), 1);
    assert.equal(client.listenerCount('guildDelete'), 1);
    assert.equal(client.listenerCount('voiceStateUpdate'), 1);
    assert.equal(client.listenerCount('guildAuditLogEntryCreate'), 1);
    assert.equal(client.listenerCount('guildMemberUpdate'), 1);
    assert.equal(client.listenerCount('guildMemberRemove'), 1);

    // Call stop and ensure all listeners are removed (no leaks)
    await runtime.stop();

    assert.equal(client.listenerCount('messageCreate'), 0);
    assert.equal(client.listenerCount('interactionCreate'), 0);
    assert.equal(client.listenerCount('guildCreate'), 0);
    assert.equal(client.listenerCount('guildDelete'), 0);
    assert.equal(client.listenerCount('voiceStateUpdate'), 0);
    assert.equal(client.listenerCount('guildAuditLogEntryCreate'), 0);
    assert.equal(client.listenerCount('guildMemberUpdate'), 0);
    assert.equal(client.listenerCount('guildMemberRemove'), 0);
});
