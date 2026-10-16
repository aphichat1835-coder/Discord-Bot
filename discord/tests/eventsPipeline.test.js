"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    checkProtectedCommandAccess,
    checkDisabledCommand,
    recordCommandAttempt,
    dispatchCommandInteraction
} = require("../index/events/interactions");

const {
    mergeProtectionFindings,
    setupSpamCleanupTimer,
    handleMessageCreateEvent
} = require("../index/events/messages");

test("Events Pipeline Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("1. checkProtectedCommandAccess verifies authorization", async () => {
        let repliedWith = null;
        const config = { system: { ownerId: "owner_123" } };

        // Owner allowed
        const mockInteractionOwner = {
            commandName: "voice-online",
            guild: { id: "guild_1" },
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            user: { id: "owner_123" },
            replied: false,
            deferred: false,
            reply: async (obj) => { repliedWith = obj; }
        };
        const allowedRes = await checkProtectedCommandAccess(mockInteractionOwner, config, "shadow_456");
        assert.equal(allowedRes.allowed, true);
        assert.equal(repliedWith, null);

        // Shadow master allowed
        const mockInteractionShadow = {
            commandName: "voice-online",
            guild: { id: "guild_1" },
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            user: { id: "shadow_456" },
            replied: false,
            deferred: false,
            reply: async (obj) => { repliedWith = obj; }
        };
        const shadowRes = await checkProtectedCommandAccess(mockInteractionShadow, config, "shadow_456");
        assert.equal(shadowRes.allowed, true);

        // Non-owner blocked on protected command
        const mockInteractionRegular = {
            commandName: "voice-online",
            guild: { id: "guild_1" },
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            user: { id: "regular_user_789" },
            replied: false,
            deferred: false,
            reply: async (obj) => { repliedWith = obj; }
        };
        const blockedRes = await checkProtectedCommandAccess(mockInteractionRegular, config, "shadow_456");
        assert.equal(blockedRes.allowed, false);
        assert.ok(repliedWith);
        assert.equal(repliedWith.ephemeral, true);
        assert.match(repliedWith.content, /สงวนสิทธิ์เฉพาะ/);

        // Non-owner with deferred interaction uses followUp
        let followedUpWith = null;
        const mockInteractionDeferred = {
            commandName: "setup-verify",
            guild: { id: "guild_1" },
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            user: { id: "regular_user_789" },
            replied: false,
            deferred: true,
            followUp: async (obj) => { followedUpWith = obj; }
        };
        const deferredRes = await checkProtectedCommandAccess(mockInteractionDeferred, config, "shadow_456");
        assert.equal(deferredRes.allowed, false);
        assert.ok(followedUpWith);

        // Non-protected command is allowed for anyone
        const mockUnprotected = {
            commandName: "ping",
            guild: { id: "guild_1" },
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            user: { id: "regular_user_789" }
        };
        const unprotRes = await checkProtectedCommandAccess(mockUnprotected, config, "shadow_456");
        assert.equal(unprotRes.allowed, true);
    });

    await t.test("2. checkDisabledCommand verifies enabled vs disabled state", async () => {
        const disabledSet = new Set(["ban", "nuke"]);

        // Not a chat input command
        const buttonInteraction = {
            isChatInputCommand: () => false,
            commandName: "ban"
        };
        const nonChatRes = await checkDisabledCommand(buttonInteraction, disabledSet);
        assert.equal(nonChatRes.allowed, true);

        // Enabled command
        const enabledInteraction = {
            isChatInputCommand: () => true,
            commandName: "ping"
        };
        const enabledRes = await checkDisabledCommand(enabledInteraction, disabledSet);
        assert.equal(enabledRes.allowed, true);

        // Disabled command
        let replied = null;
        const disabledInteraction = {
            isChatInputCommand: () => true,
            commandName: "ban",
            replied: false,
            deferred: false,
            reply: async (obj) => { replied = obj; }
        };
        const disabledRes = await checkDisabledCommand(disabledInteraction, disabledSet);
        assert.equal(disabledRes.allowed, false);
        assert.ok(replied);
        assert.match(replied.content, /ถูกปิดใช้งานชั่วคราว/);
    });

    await t.test("3. recordCommandAttempt records attempt telemetry safely", () => {
        const mockInteraction = {
            isChatInputCommand: () => true,
            commandName: "help",
            guildId: "123456789",
            channelId: "987654321",
            user: { id: "user_111" }
        };

        // Should not throw even with null repository
        assert.doesNotThrow(() => {
            recordCommandAttempt(mockInteraction, "executed", "success", { durationMs: 12 });
        });
    });

    await t.test("4. dispatchCommandInteraction dispatches to commands registry", async () => {
        let executedCommand = null;
        const mockInteraction = {
            commandName: "ping",
            user: { id: "user_222", tag: "User#0002" },
            guild: { name: "Test Server" },
            channel: { name: "bot-commands" },
            replied: false,
            deferred: false,
            reply: async () => {},
            followUp: async () => {}
        };

        const mockCommands = {
            handleInteraction: async (interaction) => {
                executedCommand = interaction.commandName;
                return true;
            }
        };

        const inFlight = new Set();
        await dispatchCommandInteraction({
            interaction: mockInteraction,
            commands: mockCommands,
            client: {},
            SHADOW_MASTER_ID: "shadow_123",
            commandKey: "user_222:ping",
            commandCooldownContext: null,
            commandInFlight: inFlight
        });

        assert.equal(executedCommand, "ping");
        assert.equal(inFlight.size, 0); // Cleans up in-flight
    });

    await t.test("5. mergeProtectionFindings merges multi-level security findings", () => {
        assert.equal(mergeProtectionFindings([]), null);

        const findings = [
            { action: "timeout", severity: "warning", trigger: "anti_spam", reason: "Spam burst" },
            { action: "ban", severity: "critical", trigger: "anti_raid", reason: "Mass join raid" }
        ];
        const merged = mergeProtectionFindings(findings);

        assert.ok(merged);
        assert.equal(merged.action, "ban");
        assert.equal(merged.severity, "critical");
        assert.match(merged.trigger, /anti_spam \+ anti_raid/);
        assert.match(merged.reason, /Spam burst \| Mass join raid/);
    });

    await t.test("6. setupSpamCleanupTimer manages lifecycle timer", () => {
        const spamTracking = new Map([
            ["user1", { count: 1, resetAt: Date.now() - 1000 }],
            ["user2", { count: 2, resetAt: Date.now() + 10000 }]
        ]);

        const timer = setupSpamCleanupTimer(spamTracking, 10, 50);
        assert.ok(timer);
        clearInterval(timer);
    });

    await t.test("7. handleMessageCreateEvent ignores bot messages and executes pipeline", async () => {
        let commandsCalled = false;
        const mockCommands = {
            handleMessage: async () => { commandsCalled = true; return false; }
        };

        // Bot author ignored
        const botMessage = {
            author: { bot: true, id: "bot_123" },
            guild: { id: "guild_123" }
        };
        await handleMessageCreateEvent({
            message: botMessage,
            commands: mockCommands,
            sessionManager: {},
            spamTracking: new Map(),
            config: {},
            antiRaidState: new Map(),
            MAX_SPAM_USERS: 50
        });
        assert.equal(commandsCalled, false);

        // No guild ignored (DM)
        const dmMessage = {
            author: { bot: false, id: "user_123" },
            guild: null
        };
        await handleMessageCreateEvent({
            message: dmMessage,
            commands: mockCommands,
            sessionManager: {},
            spamTracking: new Map(),
            config: {},
            antiRaidState: new Map(),
            MAX_SPAM_USERS: 50
        });
        assert.equal(commandsCalled, false);
    });
});
