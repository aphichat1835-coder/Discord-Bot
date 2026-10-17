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

async function _handleModeSelect(interaction, repository) {
    const selectedModeId = interaction.values[0];
    const mode = getMode(selectedModeId);
    const panel = repository.findPanelByChannelId(interaction.channelId) || {};
    const modal = buildBaseSetupModal({ mode, currentState: panel });
    await interaction.showModal(modal);
}

async function _handleStartButton(interaction, repository) {
    if (joinCampaignService.isRunning) {
        await interaction.reply({
            content: `> ${emoji.loading} ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จสิ้นก่อนนะครับ`,
            ephemeral: true
        });
        return;
    }

    const panel = repository.findPanelByChannelId(interaction.channelId) || {};
    const mode = getMode(panel.mode);

    if (!panel.targetGuildId) {
        const modal = buildBaseSetupModal({ mode, currentState: panel });
        await interaction.showModal(modal);
        return;
    }

    const startModal = buildStartOptionsModal();
    await interaction.showModal(startModal);
}

async function _updateMainPanelRunningState(client, repository, channelId, requestedAmount) {
    try {
        const panel = repository.findPanelByChannelId(channelId);
        if (!panel?.messageId) return;

        const channel = await client.channels.fetch(panel.channelId).catch(() => null);
        if (!channel) return;

        const message = await channel.messages.fetch(panel.messageId).catch(() => null);
        if (!message) return;

        const mode = getMode(panel.mode);
        const targetGuild = client.guilds.cache.get(panel.targetGuildId);
        const targetQuota = requestedAmount || panel.requestedAmount || panel.lastReadyCount;
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
    } catch (_) {
        // Non-critical background message edit failure; panel refreshes on next worker update
    }
}

async function _handleConfirmButton(interaction, client, repository) {
    const stageId = interaction.customId.slice(CONFIRM_IDS.BTN_CONFIRM_PREFIX.length);
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
        return;
    }

    await interaction.update({
        content: `> ${emoji.boost} ${result.message}`,
        embeds: [],
        components: []
    });

    await _updateMainPanelRunningState(client, repository, interaction.channelId, result.requestedAmount);
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

    if (interaction.isStringSelectMenu() && customId === PANEL_IDS.SELECT_MODE) {
        await _handleModeSelect(interaction, repository);
        return true;
    }

    if (interaction.isButton() && customId === PANEL_IDS.BTN_START) {
        await _handleStartButton(interaction, repository);
        return true;
    }

    if (interaction.isButton() && customId.startsWith(CONFIRM_IDS.BTN_CONFIRM_PREFIX)) {
        await _handleConfirmButton(interaction, client, repository);
        return true;
    }

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
