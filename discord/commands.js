/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
This file is the ROUTER and compatibility layer.
Command logic lives in: commands/moderation.js, information.js, utility.js, verification.js
Panel rendering and panel interactions live in commands/panelViews.js and commands/panelInteractions.js.
DO NOT REMOVE: panelMessages, restorePanels, cleanupGuild exports.
DO NOT REMOVE: handleMessage — used by index.js messageCreate event.
================================================================================
*/

const config = require("./config.json");
const sessionManager = require("./sessionManager");

const moderation   = require("./commands/moderation");
const information  = require("./commands/information");
const utility      = require("./commands/utility");
const verification = require("./commands/verification");
const voiceAdmin = require("./features/voiceAdmin");
const roleSweep = require("./commands/roleSweep");
const questCommand = require("./commands/quest");
const tokenCheckCommand = require("./commands/tokenCheck");

const { slashCommandsData, validateSlashCommandsData } = require("./commands/registry");
const {
    buildControlPanelEmbed,
    buildControlPanelRow
} = require("./commands/panelViews");
const {
    handleButton,
    handleModal
} = require("./commands/panelInteractions");
const {
    requireMemberPermission,
    safeReply,
    markCommandAccepted
} = require("./guards/commandGuards");
const {
    isQuestButton,
    isQuestModal,
    isQuestSelect,
    isTokenCheckButton,
    isTokenCheckModal
} = require("./commands/customIds");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: STATE
// ════════════════════════════════════════════════════════════════════════════
const panelMessages = new Map();
const activePanelCreates = new Set();
const INFORMATION_COMMANDS = new Set(["userinfo", "serverinfo", "ping"]);
const MODERATION_COMMANDS = new Set(["ban", "kick", "timeout", "clear"]);
const UTILITY_COMMANDS = new Set(["say", "announce", "copy-emojis", "backup", "restore"]);

function getPanelMessages() {
    return panelMessages;
}

function cleanupStalePanelMessages(client) {
    for (const [guildId] of panelMessages.entries()) {
        if (!client?.guilds?.cache?.has?.(guildId)) {
            panelMessages.delete(guildId);
        }
    }
}

function getCommandRuntimeDiagnostics(client = null) {
    if (client) cleanupStalePanelMessages(client);

    return {
        panelMessages: panelMessages.size,
        activePanelCreates: activePanelCreates.size,
        moderation: moderation.getRuntimeDiagnostics?.() || {},
        utility: utility.getRuntimeDiagnostics?.() || {},
        roleSweep: roleSweep.getRuntimeDiagnostics?.() || {}
    };
}

async function cleanupGuild(guildId) {
    panelMessages.delete(guildId);
    roleSweep.cleanupGuild(guildId);

    await Promise.all([
        sessionManager.PanelStateModel.deleteOne({ guildId }).catch(e =>
        console.error(`[PANEL] ❌ cleanupGuild DB delete failed for ${guildId}: ${e.message}`)
        ),
        voiceAdmin.clearGuildData(guildId).catch(e =>
            console.error(`[VOICE_ADMIN] ❌ cleanupGuild DB delete failed for ${guildId}: ${e.message}`)
        )
    ]);
}

function getGlobalVoiceSessions() {
    return Array.from(sessionManager.getAllSessions().values());
}

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  REGION 2: PANEL UPDATE / RESTORE
// ════════════════════════════════════════════════════════════════════════════
async function updatePanel(guildId) {
    if (!guildId) return false;

    const panelMsg = panelMessages.get(guildId);
    if (!panelMsg) return false;

    try {
        const guild = panelMsg.guild;
        const total = getGlobalVoiceSessions().length;

        await panelMsg.edit({
            embeds: [buildControlPanelEmbed(total)],
            components: [buildControlPanelRow()]
        });
        return await sessionManager.savePanelState(guild.id, panelMsg.channel.id, panelMsg.id) === true;

    } catch (err) {
        console.error("[PANEL] ❌ updatePanel error:", err.message);
        return false;
    }
}

async function restorePanels(client) {
    try {
        const states = await sessionManager.getPanelStates();

        for (const state of states) {
            try {
                const guild = client.guilds.cache.get(state.guildId);

                if (!guild) {
                    await sessionManager.PanelStateModel.deleteOne({ guildId: state.guildId }).catch(() => {});
                    continue;
                }

                const channel = guild.channels.cache.get(state.channelId);

                if (!channel) {
                    await sessionManager.PanelStateModel.deleteOne({ guildId: state.guildId }).catch(() => {});
                    continue;
                }

                const msg = await channel.messages.fetch(state.messageId).catch(() => null);

                if (!msg) {
                    await sessionManager.PanelStateModel.deleteOne({ guildId: state.guildId }).catch(() => {});
                    console.log(`[PANEL] 🗑️ Stale panel state removed for guild: ${state.guildId}`);
                    continue;
                }

                panelMessages.set(state.guildId, msg);
                await updatePanel(state.guildId);
                console.log(`[PANEL] ♻️ Restored panel for guild: ${state.guildId}`);

            } catch (e) {
                console.error(`[PANEL] ❌ Failed to restore panel for ${state.guildId}: ${e.message}`);
            }
        }

    } catch (e) {
        console.error("[PANEL] ❌ restorePanels error:", e.message);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💬  REGION 3: MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleMessage(message) {
    if (await roleSweep.handleMessage(message)) return true;
    return voiceAdmin.handleSecretMessage(message);
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  REGION 4: INTERACTION ROUTER
// ════════════════════════════════════════════════════════════════════════════
function delegatedCommandHandler(commandName) {
    if (INFORMATION_COMMANDS.has(commandName)) return information.handle;
    if (MODERATION_COMMANDS.has(commandName)) return moderation.handle;
    if (UTILITY_COMMANDS.has(commandName)) return utility.handle;
    return null;
}

async function discardNewPanel(guildId, message, previousPanel = null) {
    const disabled = await message.edit({ components: [] })
        .then(() => true)
        .catch(err => Number(err?.code) === 10008);
    const removed = await message.delete()
        .then(() => true)
        .catch(err => Number(err?.code) === 10008);
    if (!disabled && !removed) return false;
    if (previousPanel) panelMessages.set(guildId, previousPanel);
    else panelMessages.delete(guildId);
    return true;
}

async function reportPanelPersistenceFailure(interaction, message, previousPanel) {
    const cleanupComplete = await discardNewPanel(interaction.guild.id, message, previousPanel);
    return interaction.followUp({
        content: cleanupComplete
            ? `> ${config.emojis.error} สร้างแผงไม่สำเร็จ เพราะบันทึก Panel State ไม่ครบ และยกเลิกแผงใหม่แล้ว`
            : `> ${config.emojis.warning} บันทึก Panel State ไม่สำเร็จ และปิดแผงใหม่ไม่ได้ ต้องตรวจสอบแผงด้วยตนเอง`,
        ephemeral: true
    }).catch(() => null);
}

async function retirePreviousPanel(interaction, previousPanel, newMessage) {
    if (!previousPanel || previousPanel.id === newMessage.id) return true;
    const oldDisabled = await previousPanel.edit({ components: [] })
        .then(() => true)
        .catch(err => Number(err?.code) === 10008);
    if (oldDisabled) return true;

    const stateRestored = await sessionManager.savePanelState(
        interaction.guild.id,
        previousPanel.channel.id,
        previousPanel.id
    ).catch(() => false);
    const cleanupComplete = await discardNewPanel(interaction.guild.id, newMessage, previousPanel);
    let failureMessage = `> ${config.emojis.error} ปิดแผงเดิมและคืน Panel State ไม่สำเร็จ ต้องตรวจสอบจาก Owner Dashboard`;
    if (!cleanupComplete) {
        failureMessage = `> ${config.emojis.warning} ปิดแผงเดิมและยกเลิกแผงใหม่ไม่ได้ ต้องตรวจสอบ Panel State และข้อความด้วยตนเอง`;
    } else if (stateRestored) {
        failureMessage = `> ${config.emojis.error} ปิดแผงเดิมไม่ได้ จึงยกเลิกแผงใหม่และคืนค่าเดิมแล้ว`;
    }
    await interaction.followUp({
        content: failureMessage,
        ephemeral: true
    }).catch(() => null);
    return false;
}

async function handleVoiceOnlineCommand(interaction) {
    const allowed = await requireMemberPermission(
        interaction,
        "ADMINISTRATOR",
        `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`
    );
    if (!allowed) return null;
    const guildId = String(interaction.guild.id);
    if (activePanelCreates.has(guildId)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} ระบบกำลังสร้างแผงควบคุมของเซิร์ฟเวอร์นี้อยู่ กรุณารอสักครู่`,
            ephemeral: true
        }).catch(() => null);
    }
    activePanelCreates.add(guildId);
    try {
        markCommandAccepted(interaction);
        const previousPanel = panelMessages.get(guildId) || null;
        const message = await interaction.reply({
            embeds: [buildControlPanelEmbed()],
            components: [buildControlPanelRow()],
            fetchReply: true
        });
        panelMessages.set(guildId, message);
        if (!await updatePanel(guildId)) {
            return reportPanelPersistenceFailure(interaction, message, previousPanel);
        }
        await retirePreviousPanel(interaction, previousPanel, message);
        return null;
    } finally {
        activePanelCreates.delete(guildId);
    }
}

async function handleSlashCommand(interaction, client) {
    const commandName = interaction.commandName;
    if (commandName === "rerole") return roleSweep.handleSlashCommand(interaction);
    const handler = delegatedCommandHandler(commandName);
    if (handler) return handler(interaction, client, sessionManager);
    if (commandName === "voiceadmin") return voiceAdmin.handleVoiceAdminCommand(interaction);
    if (commandName === "setup-verify") return verification.handle(interaction, client);
    if (commandName === "voice-online") return handleVoiceOnlineCommand(interaction);
    if (commandName === "quest") return questCommand.handleQuestCommand(interaction);
    if (commandName === "token-check") return tokenCheckCommand.handleTokenCheckCommand(interaction);
    return null;
}

async function handleInteraction(interaction, client, shadowMasterId) {
    try {
        sessionManager.systemMetrics.increment("requests");

        if (interaction.isChatInputCommand()) {
            return await handleSlashCommand(interaction, client);
        }

        if (voiceAdmin.isVoiceAdminInteraction(interaction)) {
            return await voiceAdmin.handleVoiceAdminInteraction(interaction);
        }

        if (interaction.isButton()) {
            if (isTokenCheckButton(interaction.customId)) {
                return await tokenCheckCommand.handleTokenCheckButton(interaction);
            }
            if (isQuestButton(interaction.customId)) {
                return await questCommand.handleQuestButton(interaction);
            }
            return await handleButton(interaction, client, shadowMasterId, {
                getGlobalVoiceSessions,
                updatePanel
            });
        }

        if (interaction.isModalSubmit()) {
            if (isTokenCheckModal(interaction.customId)) {
                return await tokenCheckCommand.handleTokenCheckModal(interaction);
            }
            if (isQuestModal(interaction.customId)) {
                return await questCommand.handleQuestModalSubmit(interaction);
            }
            return await handleModal(interaction, client, {
                updatePanel,
                shadowMasterId
            });
        }

        if (interaction.isStringSelectMenu()) {
            if (isQuestSelect(interaction.customId)) {
                return await questCommand.handleQuestSelect(interaction);
            }
        }

    } catch (err) {
        console.error(`[SLASH] ❌ Error in /${interaction.commandName || "interaction"}:`, err.message);
        sessionManager.systemMetrics.increment("errors");

        const reply = {
            content: `> ${config.emojis.warning} เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง`,
            ephemeral: true
        };

        return safeReply(interaction, reply);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 5: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    slashCommandsData,
    validateSlashCommandsData,
    handleMessage,
    handleInteraction,
    updatePanel,
    restorePanels,
    cleanupGuild,
    getPanelMessages,
    cleanupStalePanelMessages,
    getCommandRuntimeDiagnostics,
    _test: {
        delegatedCommandHandler,
        discardNewPanel,
        retirePreviousPanel,
        handleVoiceOnlineCommand,
        activePanelCreates,
        handleSlashCommand
    }
};
