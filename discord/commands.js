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

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: STATE
// ════════════════════════════════════════════════════════════════════════════
const panelMessages = new Map();

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
        moderation: moderation.getRuntimeDiagnostics?.() || {},
        utility: utility.getRuntimeDiagnostics?.() || {}
    };
}

async function cleanupGuild(guildId) {
    panelMessages.delete(guildId);

    await sessionManager.PanelStateModel.deleteOne({ guildId }).catch(e =>
        console.error(`[PANEL] ❌ cleanupGuild DB delete failed for ${guildId}: ${e.message}`)
    );
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
    if (message.author.bot) return;
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  REGION 4: INTERACTION ROUTER
// ════════════════════════════════════════════════════════════════════════════
async function handleInteraction(interaction, client, shadowMasterId) {
    try {
        sessionManager.systemMetrics.increment("requests");

        if (interaction.isCommand()) {
            const cmd = interaction.commandName;

            if (["userinfo", "serverinfo", "help", "ping"].includes(cmd)) {
                return await information.handle(interaction, client, sessionManager);
            }

            if (["ban", "kick", "timeout", "clear", "voicekickall"].includes(cmd)) {
                return await moderation.handle(interaction, client, sessionManager);
            }

            if (["say", "announce", "copy-emojis", "backup", "restore"].includes(cmd)) {
                return await utility.handle(interaction, client, sessionManager);
            }

            if (cmd === "setup-verify") {
                return await verification.handle(interaction, client);
            }

            if (cmd === "voice-online") {
                if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`)) return;
                markCommandAccepted(interaction);

                const previousPanel = panelMessages.get(interaction.guild.id) || null;
                const msg = await interaction.reply({
                    embeds: [buildControlPanelEmbed()],
                    components: [buildControlPanelRow()],
                    fetchReply: true
                });

                panelMessages.set(interaction.guild.id, msg);
                const persisted = await updatePanel(interaction.guild.id);
                if (!persisted) {
                    if (previousPanel) panelMessages.set(interaction.guild.id, previousPanel);
                    else panelMessages.delete(interaction.guild.id);
                    await msg.edit({ components: [] }).catch(() => null);
                    await msg.delete().catch(() => null);
                    return interaction.followUp({
                        content: `> ${config.emojis.error} สร้างแผงไม่สำเร็จ เพราะบันทึก Panel State ไม่ครบ`,
                        ephemeral: true
                    }).catch(() => null);
                }
                if (previousPanel && previousPanel.id !== msg.id) {
                    const oldDisabled = await previousPanel.edit({ components: [] })
                        .then(() => true)
                        .catch(err => Number(err?.code) === 10008);
                    if (!oldDisabled) {
                        panelMessages.set(interaction.guild.id, previousPanel);
                        const stateRestored = await sessionManager.savePanelState(
                            interaction.guild.id,
                            previousPanel.channel.id,
                            previousPanel.id
                        ).catch(() => false);
                        await msg.edit({ components: [] }).catch(() => null);
                        await msg.delete().catch(() => null);
                        return interaction.followUp({
                            content: stateRestored
                                ? `> ${config.emojis.error} ปิดแผงเดิมไม่ได้ จึงยกเลิกแผงใหม่และคืนค่าเดิมแล้ว`
                                : `> ${config.emojis.error} ปิดแผงเดิมและคืน Panel State ไม่สำเร็จ ต้องตรวจสอบจาก Owner Dashboard`,
                            ephemeral: true
                        }).catch(() => null);
                    }
                }
                return;
            }
        }

        if (interaction.isButton()) {
            return await handleButton(interaction, client, shadowMasterId, {
                getGlobalVoiceSessions,
                updatePanel
            });
        }

        if (interaction.isModalSubmit()) {
            return await handleModal(interaction, client, {
                updatePanel,
                shadowMasterId
            });
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
    getCommandRuntimeDiagnostics
};
