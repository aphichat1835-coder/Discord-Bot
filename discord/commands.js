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

const { slashCommandsData } = require("./commands/registry");
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
    safeReply
} = require("./guards/commandGuards");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: STATE
// ════════════════════════════════════════════════════════════════════════════
const panelMessages = new Map();

function getPanelMessages() {
    return panelMessages;
}

async function cleanupGuild(guildId) {
    panelMessages.delete(guildId);

    await sessionManager.PanelStateModel.deleteOne({ guildId }).catch(e =>
        console.error(`[PANEL] ❌ cleanupGuild DB delete failed for ${guildId}: ${e.message}`)
    );
}

async function getLogChannel(guild, type = "member") {
    try {
        const map = await sessionManager.getLogChannelMap(guild.id);
        const channelId = map?.[`${type}ChannelId`];

        if (channelId) {
            const ch = guild.channels.cache.get(channelId);
            if (ch) return ch;
        }
    } catch (_) {}

    return guild.channels.cache.find(c => c.name === config.channels.logName && c.isText()) || null;
}

function getGlobalVoiceSessions() {
    return Array.from(sessionManager.getAllSessions().values());
}

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  REGION 2: PANEL UPDATE / RESTORE
// ════════════════════════════════════════════════════════════════════════════
async function updatePanel(guildId) {
    if (!guildId) return;

    const panelMsg = panelMessages.get(guildId);
    if (!panelMsg) return;

    try {
        const guild = panelMsg.guild;
        const total = getGlobalVoiceSessions().length;

        await panelMsg.edit({
            embeds: [buildControlPanelEmbed(total)],
            components: [buildControlPanelRow()]
        });
        await sessionManager.savePanelState(guild.id, panelMsg.channel.id, panelMsg.id);

    } catch (err) {
        console.error("[PANEL] ❌ updatePanel error:", err.message);
    }
}

async function restorePanels(client) {
    try {
        const states = await sessionManager.PanelStateModel.find({});

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

            if (["userinfo", "serverinfo", "stats", "help", "ping"].includes(cmd)) {
                return await information.handle(interaction, client, sessionManager);
            }

            if (["ban", "kick", "timeout", "clear", "voicekickall"].includes(cmd)) {
                return await moderation.handle(interaction, client, sessionManager, getLogChannel);
            }

            if (["say", "announce", "steal", "backup", "restore", "setup-log", "whitelist", "setup"].includes(cmd)) {
                return await utility.handle(interaction, client, sessionManager, getLogChannel);
            }

            if (cmd === "setup-verify") {
                return await verification.handle(interaction, client);
            }

            if (cmd === "panel") {
                if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`)) return;

                const msg = await interaction.reply({
                    embeds: [buildControlPanelEmbed()],
                    components: [buildControlPanelRow()],
                    fetchReply: true
                });

                panelMessages.set(interaction.guild.id, msg);
                await updatePanel(interaction.guild.id);
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
                getLogChannel,
                updatePanel
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
    handleMessage,
    handleInteraction,
    updatePanel,
    restorePanels,
    cleanupGuild,
    getPanelMessages
};
