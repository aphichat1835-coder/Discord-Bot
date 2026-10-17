"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    handleInteractionCreateEvent,
    checkProtectedCommandAccess,
    checkDisabledCommand,
    recordCommandAttempt,
    dispatchCommandInteraction
} = require("../index/events/interactions");

const {
    mergeProtectionFindings,
    setupSpamCleanupTimer,
    handleMessageCreateEvent,
    executeProtectionAction,
    collectMessageProtectionFindings,
    runMessageProtectionPipeline
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

    await t.test("8. handleInteractionCreateEvent full lifecycle", async () => {
        let commandHandled = null;
        let replySent = null;

        const chatInteraction = {
            commandName: "ping",
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isButton: () => false,
            isStringSelectMenu: () => false,
            user: { id: "user_live_1", tag: "User1#0001" },
            guild: { id: "guild_live", name: "Guild Live" },
            guildId: "guild_live",
            channelId: "channel_live",
            options: { data: [] },
            replied: false,
            deferred: false,
            reply: async (obj) => { replySent = obj; },
            followUp: async (obj) => { replySent = obj; }
        };

        const mockCommands = {
            handleInteraction: async (interaction) => {
                commandHandled = interaction.commandName;
                return true;
            }
        };

        const inFlight = new Set();
        const cooldowns = new Map();

        await handleInteractionCreateEvent({
            interaction: chatInteraction,
            config: { system: { ownerId: "owner_123" } },
            SHADOW_MASTER_ID: null,
            disabledCommands: new Set(),
            commandCooldowns: cooldowns,
            COMMAND_COOLDOWNS_MS: {},
            DEFAULT_COOLDOWN_MS: 1000,
            commandCooldownMaxUsers: 10,
            commandInFlight: inFlight,
            commands: mockCommands,
            client: {}
        });

        assert.equal(commandHandled, "ping");

        // Duplicate command while in-flight
        let duplicateReplied = null;
        inFlight.add("user_live_1:ping");
        const dupInteraction = {
            ...chatInteraction,
            reply: async (obj) => { duplicateReplied = obj; }
        };

        await handleInteractionCreateEvent({
            interaction: dupInteraction,
            config: { system: { ownerId: "owner_123" } },
            SHADOW_MASTER_ID: null,
            disabledCommands: new Set(),
            commandCooldowns: cooldowns,
            COMMAND_COOLDOWNS_MS: {},
            DEFAULT_COOLDOWN_MS: 1000,
            commandCooldownMaxUsers: 10,
            commandInFlight: inFlight,
            commands: mockCommands,
            client: {}
        });

        assert.ok(duplicateReplied);
        assert.match(duplicateReplied.content, /กำลังประมวลผลอยู่/);
    });

    await t.test("9. executeProtectionAction for timeout, ban, kick, and delete modes", async () => {
        let timedOut = null;
        let kicked = null;
        let banned = null;

        const mockMember = {
            id: "target_user",
            manageable: true,
            kickable: true,
            bannable: true,
            permissions: { has: () => false },
            guild: { members: { me: { permissions: { has: () => true } } } },
            roles: { highest: { comparePositionTo: () => 1 } },
            timeout: async (ms, reason) => { timedOut = { ms, reason }; },
            kick: async (reason) => { kicked = reason; },
            ban: async (obj) => { banned = obj; }
        };

        // Timeout action
        const resTimeout = await executeProtectionAction({
            member: mockMember,
            result: { action: "timeout", minutes: 5, reason: "Excessive spam" },
            message: null
        });
        assert.equal(resTimeout.success, true);
        assert.equal(resTimeout.action, "timeout");
        assert.ok(timedOut);

        // Kick action
        const resKick = await executeProtectionAction({
            member: mockMember,
            result: { action: "kick", reason: "Join raid" },
            message: null
        });
        assert.equal(resKick.success, true);
        assert.equal(resKick.action, "kick");
        assert.equal(kicked, "Join raid");

        // Ban action
        const resBan = await executeProtectionAction({
            member: mockMember,
            result: { action: "ban", reason: "Malicious raid bot" },
            message: null
        });
        assert.equal(resBan.success, true);
        assert.equal(resBan.action, "ban");
        assert.ok(banned);

        // Log only action
        const resLog = await executeProtectionAction({
            member: mockMember,
            result: { action: "log", reason: "Audit check" },
            message: null
        });
        assert.equal(resLog.attempted, false);
    });

    await t.test("10. collectMessageProtectionFindings and runMessageProtectionPipeline", async () => {
        const spamMap = new Map();
        const mockMsg = {
            author: { id: "spammer_1", bot: false },
            content: "https://discord.gg/invite123",
            member: {
                id: "spammer_1",
                permissions: { has: () => false },
                roles: { cache: new Map() }
            },
            guild: { id: "guild_prot_1", name: "Guild Prot", ownerId: "guild_owner_999" },
            channel: { id: "channel_prot_1", name: "general" }
        };

        const pConf = {
            antiSpam: { enabled: true, maxMessages: 5, timeWindowSeconds: 5 },
            antiRaid: { enabled: true },
            linkFilter: { enabled: true, allowlist: [] }
        };

        const testConfig = { roles: { fallbackAdminId: "role_fallback_admin" } };

        const findingsRes = collectMessageProtectionFindings({
            message: mockMsg,
            member: mockMsg.member,
            pConf,
            spamTracking: spamMap,
            now: Date.now(),
            antiRaidEnabled: true,
            config: testConfig
        });

        assert.ok(findingsRes);
        assert.ok(Array.isArray(findingsRes.findings));
        assert.ok(Array.isArray(findingsRes.touchedKeys));

        // runMessageProtectionPipeline
        const sessionManager = {
            getSetting: async () => true
        };
        const antiRaidState = new Map();

        await assert.doesNotReject(async () => {
            await runMessageProtectionPipeline({
                message: mockMsg,
                sessionManager,
                spamTracking: spamMap,
                config: testConfig,
                antiRaidState,
                MAX_SPAM_USERS: 50
            });
        });
    });

    await t.test("11. dispatchCommandInteraction handles errors and failed command status", async () => {
        let replyFollowUp = null;
        let replySent = null;

        const failingInteraction = {
            commandName: "broken_cmd",
            isChatInputCommand: () => true,
            user: { id: "user_fail_1", tag: "FailUser#0001" },
            guild: { id: "guild_fail", name: "Guild Fail" },
            options: { data: [{ name: "sub", options: [{ name: "val", value: "hello" }] }] },
            replied: true,
            deferred: false,
            followUp: async (obj) => { replyFollowUp = obj; },
            reply: async (obj) => { replySent = obj; }
        };

        const mockFailingCommands = {
            handleInteraction: async () => {
                throw new Error("Simulated interaction execution crash");
            }
        };

        const inFlight = new Set(["user_fail_1:broken_cmd"]);

        await dispatchCommandInteraction({
            interaction: failingInteraction,
            commands: mockFailingCommands,
            client: {},
            SHADOW_MASTER_ID: null,
            commandKey: "user_fail_1:broken_cmd",
            commandCooldownContext: null,
            commandInFlight: inFlight
        });

        assert.ok(replyFollowUp);
        assert.match(replyFollowUp.content, /เกิดข้อผิดพลาดในการประมวลผล/);
        assert.equal(inFlight.has("user_fail_1:broken_cmd"), false);

        // Interaction with __commandFailed: true
        const softFailInteraction = {
            commandName: "soft_fail_cmd",
            isChatInputCommand: () => true,
            user: { id: "user_soft_1", tag: "SoftUser#0001" },
            guild: null,
            options: { data: [] },
            replied: false,
            __commandFailed: true,
            __commandErrorMessage: "Soft failed reason"
        };

        const mockSoftCommands = {
            handleInteraction: async () => {}
        };

        await assert.doesNotReject(async () => {
            await dispatchCommandInteraction({
                interaction: softFailInteraction,
                commands: mockSoftCommands,
                client: {},
                SHADOW_MASTER_ID: null,
                commandKey: "user_soft_1:soft_fail_cmd",
                commandCooldownContext: null,
                commandInFlight: inFlight
            });
        });
    });

    await t.test("12. handleInteractionCreateEvent cooldown limit, LRU eviction, and disabled command", async () => {
        let cooldownReplied = null;
        const cooldowns = new Map();
        // Pre-fill user with recent timestamp
        const userCmds = new Map();
        userCmds.set("ping", Date.now());
        cooldowns.set("user_cd_1", userCmds);

        const cdInteraction = {
            commandName: "ping",
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isButton: () => false,
            isStringSelectMenu: () => false,
            user: { id: "user_cd_1", tag: "CDUser#0001" },
            guild: { id: "guild_cd", name: "Guild CD" },
            options: { data: [] },
            replied: false,
            deferred: false,
            reply: async (obj) => { cooldownReplied = obj; }
        };

        await handleInteractionCreateEvent({
            interaction: cdInteraction,
            config: { system: { ownerId: "owner_123" } },
            SHADOW_MASTER_ID: null,
            disabledCommands: new Set(),
            commandCooldowns: cooldowns,
            COMMAND_COOLDOWNS_MS: { ping: 5000 },
            DEFAULT_COOLDOWN_MS: 1000,
            commandCooldownMaxUsers: 2,
            commandInFlight: new Set(),
            commands: { handleInteraction: async () => {} },
            client: {}
        });

        assert.ok(cooldownReplied);
        assert.match(cooldownReplied.content, /กรุณารอสักครู่/);

        // Disabled command branch
        let disabledRecorded = false;
        const disabledInteraction = {
            ...cdInteraction,
            commandName: "banned_cmd"
        };

        await handleInteractionCreateEvent({
            interaction: disabledInteraction,
            config: { system: { ownerId: "owner_123" } },
            SHADOW_MASTER_ID: null,
            disabledCommands: new Set(["banned_cmd"]),
            commandCooldowns: cooldowns,
            COMMAND_COOLDOWNS_MS: {},
            DEFAULT_COOLDOWN_MS: 1000,
            commandCooldownMaxUsers: 2,
            commandInFlight: new Set(),
            commands: { handleInteraction: async () => {} },
            client: {}
        });

        // LRU eviction branch: add another user when size >= maxUsers (maxUsers = 1)
        const lruCooldowns = new Map();
        lruCooldowns.set("user_old", new Map());
        const newUserInteraction = {
            ...cdInteraction,
            user: { id: "user_new", tag: "NewUser#0001" }
        };

        await handleInteractionCreateEvent({
            interaction: newUserInteraction,
            config: { system: { ownerId: "owner_123" } },
            SHADOW_MASTER_ID: null,
            disabledCommands: new Set(),
            commandCooldowns: lruCooldowns,
            COMMAND_COOLDOWNS_MS: {},
            DEFAULT_COOLDOWN_MS: 1000,
            commandCooldownMaxUsers: 1,
            commandInFlight: new Set(),
            commands: { handleInteraction: async () => {} },
            client: {}
        });
        assert.equal(lruCooldowns.has("user_old"), false);
        assert.equal(lruCooldowns.has("user_new"), true);
    });

    await t.test("13. handleInteractionCreateEvent routes role button and select menu safely", async () => {
        let roleReplied = null;

        const roleBtnInteraction = {
            isAutocomplete: () => false,
            isChatInputCommand: () => false,
            isButton: () => true,
            isStringSelectMenu: () => false,
            customId: "rolebtn_guest",
            user: { id: "user_role_1", tag: "RoleUser#0001" },
            guild: { id: "guild_role", name: "Guild Role" },
            replied: false,
            deferred: false,
            reply: async (obj) => { roleReplied = obj; },
            editReply: async (obj) => { roleReplied = obj; }
        };

        await handleInteractionCreateEvent({
            interaction: roleBtnInteraction,
            config: { system: { ownerId: "owner_123" } },
            SHADOW_MASTER_ID: null,
            disabledCommands: new Set(),
            commandCooldowns: new Map(),
            COMMAND_COOLDOWNS_MS: {},
            DEFAULT_COOLDOWN_MS: 1000,
            commandCooldownMaxUsers: 10,
            commandInFlight: new Set(),
            commands: {},
            client: {}
        });
    });
});

