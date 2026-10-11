"use strict";

const emoji = require("../ui/emojis");
const { isOwner } = require("./commandHandler");
const { getMode } = require("../modes/modeRegistry");
const { buildBaseSetupModal, buildStartOptionsModal, CUSTOM_IDS } = require("../ui/modals");
const { IDS: PANEL_IDS, buildPanelPayload } = require("../ui/panelBuilder");
const { IDS: CONFIRM_IDS } = require("../ui/confirmationBuilder");
const { handleModalSubmit } = require("./modalSubmitHandler");
const joinCampaignService = require("../services/joinCampaignService");
const database = require("../../../../database/index");

function isJoinCampaignInteraction(interaction) {
    const id = interaction.customId || "";
    return id === PANEL_IDS.SELECT_MODE ||
        id === PANEL_IDS.BTN_START ||
        id === PANEL_IDS.BTN_RUNNING ||
        id.startsWith(CONFIRM_IDS.BTN_CONFIRM_PREFIX) ||
        id.startsWith(CUSTOM_IDS.MODAL_SETUP_PREFIX) ||
        id === CUSTOM_IDS.MODAL_START;
}

async function handleJoinCampaignInteraction(interaction, client) {
    if (!isJoinCampaignInteraction(interaction)) {
        return false;
    }

    // Owner check for all control plane interactions
    if (!isOwner(interaction)) {
        const reply = {
            content: `> ${emoji.no_entry} ปุ่มควบคุมนี้ใช้ได้เฉพาะ **เจ้าของบอท** เท่านั้นครับ`,
            ephemeral: true
        };
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
        else await interaction.reply(reply);
        return true;
    }

    const repository = database.repositories.joinCampaign;
    const { customId } = interaction;

    // 1. Dropdown Mode Select Menu
    if (interaction.isStringSelectMenu() && customId === PANEL_IDS.SELECT_MODE) {
        const selectedModeId = interaction.values[0];
        const mode = getMode(selectedModeId);
        const panel = repository.findPanelByChannelId(interaction.channelId) || {};

        const modal = buildBaseSetupModal({
            mode,
            currentState: panel
        });
        await interaction.showModal(modal);
        return true;
    }

    // 2. Start Action Button
    if (interaction.isButton() && customId === PANEL_IDS.BTN_START) {
        if (joinCampaignService.isRunning) {
            await interaction.reply({
                content: `> ${emoji.loading} ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จสิ้นก่อนนะครับ`,
                ephemeral: true
            });
            return true;
        }

        const panel = repository.findPanelByChannelId(interaction.channelId) || {};
        const mode = getMode(panel.mode);

        // If Target Guild is not yet configured, open Setup Modal first
        if (!panel.targetGuildId) {
            const modal = buildBaseSetupModal({
                mode,
                currentState: panel
            });
            await interaction.showModal(modal);
            return true;
        }

        // If Target Guild is already configured, open Phase 2 Start Options Modal
        const startModal = buildStartOptionsModal();
        await interaction.showModal(startModal);
        return true;
    }

    // 3. Confirm Start Button (Preflight Ephemeral Confirmation)
    if (interaction.isButton() && customId.startsWith(CONFIRM_IDS.BTN_CONFIRM_PREFIX)) {
        const stageId = customId.slice(CONFIRM_IDS.BTN_CONFIRM_PREFIX.length);
        const result = await joinCampaignService.confirmAndStartCampaign({
            stageId,
            client,
            repository
        });

        if (!result.ok) {
            await interaction.update({
                content: `> ${emoji.error} **ไม่สามารถเริ่มงานได้:** ${result.error}`,
                components: []
            });
            return true;
        }

        // Update confirmation message
        await interaction.update({
            content: `> ${emoji.boost} ${result.message}`,
            embeds: [],
            components: []
        });

        // Trigger immediate visual update on main panel in channel
        try {
            const panel = repository.findPanelByChannelId(interaction.channelId);
            if (panel && panel.messageId) {
                const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (message) {
                        const mode = getMode(panel.mode);
                        const targetGuild = client.guilds.cache.get(panel.targetGuildId);
                        const targetQuota = result.requestedAmount || panel.requestedAmount || panel.lastReadyCount;
                        const payload = buildPanelPayload({
                            mode,
                            panelState: panel,
                            readyCount: panel.lastReadyCount,
                            liveJob: {
                                status: "RUNNING",
                                joinedCount: 0,
                                requestedAmount: targetQuota
                            },
                            targetGuildName: targetGuild?.name || panel.targetGuildId
                        });
                        await message.edit(payload).catch(() => {});
                    }
                }
            }
        } catch (_) {}

        return true;
    }

    // 4. Modal Submissions
    if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction, client);
        return true;
    }

    return false;
}

module.exports = {
    isJoinCampaignInteraction,
    handleJoinCampaignInteraction
};
