'use strict';

/**
 * Interaction Event & Command Pipeline Handler
 * - Permission and bot-owner access guards.
 * - Command disabling and concurrency / rate-limit cooldowns.
 * - Role button / select menu routing.
 * - Command interaction dispatch and telemetry metrics recording.
 */

const roleButton = require('../../features/roleButton');
const appConfig = require('../../config.json');
const { sendWebhookEvent } = require('../../core/webhooks');
const { isConfiguredOwner } = require('../../core/env');

async function checkProtectedCommandAccess(interaction, config, shadowMasterId) {
    if (!interaction.guild || interaction.isAutocomplete() || !interaction.isChatInputCommand()) {
        return { allowed: true };
    }
    const protectedCommands = ["voice-online", "setup-verify"];
    if (!protectedCommands.includes(interaction.commandName)) {
        return { allowed: true };
    }
    const isOwner = isConfiguredOwner(config, interaction.user.id)
        || interaction.user.id === shadowMasterId
        || interaction.user.id === config.system?.ownerId;
    if (isOwner) return { allowed: true };

    const reply = {
        content: `> ${appConfig.emojis?.no_entry || "⛔"} คำสั่งนี้สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
        ephemeral: true
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
    return { allowed: false };
}

async function checkDisabledCommand(interaction, disabledCommands) {
    if (!interaction.isChatInputCommand() || !disabledCommands.has(interaction.commandName)) {
        return { allowed: true };
    }
    const reply = {
        content: `> ${appConfig.emojis?.disable || appConfig.emojis?.error || "❌"} คำสั่ง \`/${interaction.commandName}\` ถูกปิดใช้งานชั่วคราวโดยผู้ดูแลระบบ`,
        ephemeral: true
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
    return { allowed: false };
}

function getOrCreateUserCooldownMap(commandCooldowns, userId, maxUsers) {
    if (!commandCooldowns.has(userId) && commandCooldowns.size >= maxUsers) {
        commandCooldowns.delete(commandCooldowns.keys().next().value);
    }
    if (!commandCooldowns.has(userId)) commandCooldowns.set(userId, new Map());
    return commandCooldowns.get(userId);
}

function resolveCooldownKeys(interaction, cmdName, userId) {
    const isChannelScoped = cmdName === "clear";
    const channelId = interaction.channelId || interaction.channel?.id || "";
    const cooldownKey = isChannelScoped && channelId ? `${cmdName}:${channelId}` : cmdName;
    const commandKey = isChannelScoped && channelId ? `${userId}:${cmdName}:${channelId}` : `${userId}:${cmdName}`;
    return { isChannelScoped, cooldownKey, commandKey };
}

async function respondCooldownExceeded(interaction, cmdName, remaining) {
    const secs = (remaining / 1000).toFixed(1);
    const reply = {
        content: `> ${appConfig.emojis?.loading || "⏳"} กรุณารอสักครู่ (**${secs}** วินาที) ก่อนเรียกใช้คำสั่ง \`/${cmdName}\` อีกครั้ง`,
        ephemeral: true
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
}

async function respondCommandInFlight(interaction, cmdName, isChannelScoped) {
    await interaction.reply({
        content: isChannelScoped
            ? `> ${appConfig.emojis?.loading || "⏳"} คำสั่ง \`/${cmdName}\` ในห้องนี้กำลังประมวลผลอยู่ กรุณารอสักครู่`
            : `> ${appConfig.emojis?.loading || "⏳"} คำสั่ง \`/${cmdName}\` กำลังประมวลผลอยู่ กรุณารอสักครู่`,
        ephemeral: true
    }).catch(() => {});
}

async function handleCommandCooldownAndInFlight({
    interaction,
    commandCooldowns,
    COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS,
    commandCooldownMaxUsers,
    commandInFlight
}) {
    if (!interaction.isChatInputCommand()) return { allowed: true };

    const userId = interaction.user.id;
    const cmdName = interaction.commandName;
    const cooldownMs = COMMAND_COOLDOWNS_MS[cmdName] ?? DEFAULT_COOLDOWN_MS;
    const now = Date.now();

    const userCmds = getOrCreateUserCooldownMap(commandCooldowns, userId, commandCooldownMaxUsers);
    const { isChannelScoped, cooldownKey, commandKey } = resolveCooldownKeys(interaction, cmdName, userId);
    const lastUsed = userCmds.get(cooldownKey) || 0;
    const remaining = cooldownMs - (now - lastUsed);

    if (remaining > 0) {
        await respondCooldownExceeded(interaction, cmdName, remaining);
        return { allowed: false, reason: "rate_limited", extra: { remainingMs: remaining } };
    }
    if (commandInFlight.has(commandKey)) {
        await respondCommandInFlight(interaction, cmdName, isChannelScoped);
        return { allowed: false, reason: "in_flight", extra: { inFlight: true } };
    }
    commandInFlight.add(commandKey);
    const commandCooldownContext = { userCmds, cooldownKey, recorded: false };
    interaction.__onCommandAccepted = () => {
        if (commandCooldownContext.recorded) return;
        commandCooldownContext.userCmds.set(commandCooldownContext.cooldownKey, Date.now());
        commandCooldownContext.recorded = true;
        delete interaction.__onCommandAccepted;
    };
    return { allowed: true, commandKey, commandCooldownContext };
}

function isRoleButtonInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith('rolebtn_')) return true;
    if (interaction.isStringSelectMenu() && interaction.customId === 'roleselect_menu') return true;
    return false;
}

async function handleRoleButtonInteractionSafe(interaction) {
    try {
        return await roleButton.handleRoleInteraction(interaction);
    } catch (e) {
        console.error('[ROLE_BTN] ❌', e.message);
        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "ERROR",
                category: "COMMAND",
                code: "role_button.error",
                state: "OPEN",
                title: "ROLE BUTTON ERROR",
                description: `เกิดข้อผิดพลาดในการจัดการยศผ่านปุ่มหรือเมนู: ${e?.message || "unknown"}`,
                impact: "สมาชิกอาจไม่ได้รับหรือถอดยศตามที่เลือก",
                action: "ตรวจสอบสิทธิ์ Manage Roles ของบอท และลำดับ Role Hierarchy ในเซิร์ฟเวอร์",
                context: {
                    "Custom ID": interaction.customId || "unknown",
                    "User": interaction.user?.tag || interaction.user?.id || "unknown",
                    "Guild": interaction.guild?.name || interaction.guildId || "DM"
                },
                dedupeKey: `role-btn-err:${interaction.customId}:${e?.message || ""}`,
                dedupeMs: 2 * 60 * 1000
            }).catch(() => {});
        } catch (_err) {
            // Ignored: Alert webhook sending is best-effort
        }
        const r = { content: `> ${appConfig.emojis?.error || '❌'} เกิดข้อผิดพลาดในการจัดการยศ กรุณาลองใหม่อีกครั้ง`, ephemeral: true };
        if (interaction.deferred) return await interaction.editReply(r);
        if (!interaction.replied) return await interaction.reply(r);
    }
}

function finalizeCommandInteraction({ commandKey, commandInFlight, commandCooldownContext, interaction }) {
    if (commandKey) commandInFlight.delete(commandKey);
    if (commandCooldownContext && !commandCooldownContext.recorded && interaction.__commandAccepted === true) {
        commandCooldownContext.userCmds.set(commandCooldownContext.cooldownKey, Date.now());
    }
    delete interaction.__onCommandAccepted;
}

async function replyInteractionError(interaction) {
    const errReply = { content: `> ${appConfig.emojis?.error || '❌'} เกิดข้อผิดพลาดในการประมวลผล กรุณาลองใหม่อีกครั้ง`, ephemeral: true };
    try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(errReply);
        else await interaction.reply(errReply);
    } catch {}
}

function serializeCommandOptions(optionsData) {
    if (!Array.isArray(optionsData) || optionsData.length === 0) return {};
    const map = {};
    for (const opt of optionsData) {
        if (Array.isArray(opt.options) && opt.options.length > 0) {
            map[opt.name] = serializeCommandOptions(opt.options);
        } else {
            map[opt.name] = opt.value !== undefined ? opt.value : true;
        }
    }
    return map;
}

async function dispatchCommandInteraction({ interaction, commands, client, SHADOW_MASTER_ID, commandKey, commandCooldownContext, commandInFlight }) {
    const startTime = Date.now();
    let status = "success";
    let errorDetail = null;

    try {
        await commands.handleInteraction(interaction, client, SHADOW_MASTER_ID);
        if (interaction?.__commandFailed) {
            status = "failed";
            errorDetail = interaction.__commandError || "Command internal error";
        }
    } catch (e) {
        status = "failed";
        errorDetail = e?.message || String(e);
        console.error('[EVENT] ❌ handleInteraction error:', e.message);
        sendWebhookEvent({
            target: "ALERT",
            severity: "ERROR",
            category: "COMMAND",
            code: "interaction.unhandled_error",
            state: "OPEN",
            title: "INTERACTION UNHANDLED ERROR",
            description: `เกิดข้อผิดพลาดที่ไม่ได้ดักจับใน Interaction Dispatch: ${e?.message || "unknown"}`,
            impact: "Interaction ล้มเหลวและไม่สามารถทำงานต่อได้",
            action: "ตรวจสอบ Runtime Log และข้อผิดพลาดในคำสั่ง",
            context: {
                "Command / ID": interaction.commandName || interaction.customId || "unknown",
                "User": interaction.user?.tag || interaction.user?.id || "unknown",
                "Guild": interaction.guild?.name || interaction.guildId || "DM"
            },
            dedupeKey: `interaction-dispatch-err:${interaction.commandName || interaction.customId}:${e?.message || ""}`,
            dedupeMs: 2 * 60 * 1000
        }).catch(() => {});
        await replyInteractionError(interaction);
    } finally {
        finalizeCommandInteraction({ commandKey, commandInFlight, commandCooldownContext, interaction });
        try {
            const db = require("../../database");
            const commandRepo = db?.repositories?.commandEvent;
            if (commandRepo && typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand()) {
                const optionsMap = serializeCommandOptions(interaction.options?.data);
                commandRepo.record({
                    occurredAt: startTime,
                    commandName: interaction.commandName,
                    actorId: interaction.user?.id,
                    guildId: interaction.guildId,
                    channelId: interaction.channelId,
                    status,
                    durationMs: Date.now() - startTime,
                    details: {
                        options: optionsMap,
                        error: errorDetail
                    }
                });
            }
        } catch (_err) {
            // Ignored: Command telemetry recording failure must never crash command interaction flow
        }
    }
}

function recordCommandAttempt(interaction, status, reason = null, extraDetails = {}) {
    try {
        const db = require("../../database");
        const commandRepo = db?.repositories?.commandEvent;
        if (commandRepo && typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand()) {
            const optionsMap = serializeCommandOptions(interaction.options?.data);
            commandRepo.record({
                occurredAt: Date.now(),
                commandName: interaction.commandName,
                actorId: interaction.user?.id,
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                status,
                durationMs: 0,
                details: {
                    options: optionsMap,
                    reason,
                    ...extraDetails
                }
            });
        }
    } catch (_err) {
        // Command telemetry recording failure must never crash command interaction flow
    }
}

async function handleInteractionCreateEvent({
    interaction,
    config,
    SHADOW_MASTER_ID,
    disabledCommands,
    commandCooldowns,
    COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS,
    commandCooldownMaxUsers,
    commandInFlight,
    commands,
    client
}) {
    const auth = await checkProtectedCommandAccess(interaction, config, SHADOW_MASTER_ID);
    if (!auth.allowed) {
        recordCommandAttempt(interaction, "denied", "owner_only");
        return;
    }

    const disabled = await checkDisabledCommand(interaction, disabledCommands);
    if (!disabled.allowed) {
        recordCommandAttempt(interaction, "disabled", "command_disabled");
        return;
    }

    const cooldownRes = await handleCommandCooldownAndInFlight({
        interaction,
        commandCooldowns,
        COMMAND_COOLDOWNS_MS,
        DEFAULT_COOLDOWN_MS,
        commandCooldownMaxUsers,
        commandInFlight
    });
    if (!cooldownRes.allowed) {
        recordCommandAttempt(interaction, cooldownRes.reason || "rate_limited", cooldownRes.reason, cooldownRes.extra || {});
        return;
    }

    if (isRoleButtonInteraction(interaction)) {
        return await handleRoleButtonInteractionSafe(interaction);
    }

    await dispatchCommandInteraction({
        interaction,
        commands,
        client,
        SHADOW_MASTER_ID,
        commandKey: cooldownRes.commandKey,
        commandCooldownContext: cooldownRes.commandCooldownContext,
        commandInFlight
    });
}

module.exports = {
    handleInteractionCreateEvent,
    checkProtectedCommandAccess,
    checkDisabledCommand,
    dispatchCommandInteraction,
    recordCommandAttempt
};
