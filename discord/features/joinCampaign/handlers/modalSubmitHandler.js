"use strict";

const emoji = require("../ui/emojis");
const { getMode } = require("../modes/modeRegistry");
const { buildPanelPayload } = require("../ui/panelBuilder");
const { CUSTOM_IDS } = require("../ui/modals");
const { validateGuildTargets, getLiveTargetMemberIds } = require("../services/preflightService");
const { countEligibleCandidates } = require("../services/candidateQueryService");
const joinCampaignService = require("../services/joinCampaignService");
const database = require("../../../../database/index");

async function handleModalSubmit(interaction, client) {
    const repository = database.repositories.joinCampaign;
    const { customId } = interaction;

    // 1. Phase 1 Base Setup Modal Submission
    if (customId.startsWith(CUSTOM_IDS.MODAL_SETUP_PREFIX)) {
        const modeId = customId.slice(CUSTOM_IDS.MODAL_SETUP_PREFIX.length);
        const mode = getMode(modeId);

        let targetGuildId = interaction.fields.getTextInputValue(CUSTOM_IDS.FIELD_TARGET)?.trim();
        let sourceGuildId = null;

        if (mode.requiresSource) {
            try {
                sourceGuildId = interaction.fields.getTextInputValue(CUSTOM_IDS.FIELD_SOURCE)?.trim();
            } catch (_) {}
        }

        const baseConfig = { targetGuildId, sourceGuildId };

        // Defer ephemeral reply while verifying guilds and calculating candidates
        await interaction.deferReply({ ephemeral: true });

        const validation = await validateGuildTargets({ client, mode, baseConfig });
        if (!validation.ok) {
            return interaction.editReply({
                content: `> ${emoji.error} **ไม่สามารถตั้งค่าได้:** ${validation.error}`
            });
        }

        // Live Target Membership Check (Fail-closed)
        let readyCount;
        try {
            const targetMemberIds = await getLiveTargetMemberIds(validation.targetGuild);
            readyCount = await countEligibleCandidates({
                mode,
                baseConfig,
                targetMemberIds
            });
        } catch (err) {
            return interaction.editReply({
                content: `> ${emoji.error} **ไม่สามารถตรวจสอบจำนวนสมาชิกที่พร้อมดึงได้:** ${err.message || "เกิดข้อผิดพลาดในการตรวจสอบฐานข้อมูล กรุณาลองใหม่อีกครั้งครับ"}`
            });
        }

        // Find existing panel for this channel in SQLite
        const existingPanel = repository.findPanelByChannelId(interaction.channelId);
        const messageId = existingPanel?.messageId || interaction.message?.id;

        const updatedPanelState = {
            messageId,
            channelId: interaction.channelId,
            guildId: interaction.guildId,
            mode: mode.id,
            sourceGuildId,
            targetGuildId,
            lastReadyCount: readyCount,
            lastStatusSummary: null
        };

        if (messageId) {
            repository.savePanel(updatedPanelState);

            // Update main panel message in channel
            try {
                const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(messageId).catch(() => null);
                    if (message) {
                        const panelPayload = buildPanelPayload({
                            mode,
                            panelState: updatedPanelState,
                            readyCount,
                            liveJob: null,
                            sourceGuildName: validation.sourceGuildName,
                            targetGuildName: validation.targetGuildName
                        });
                        await message.edit(panelPayload).catch(() => {});
                    }
                }
            } catch (_) {}
        }

        return interaction.editReply({
            content: `> ${emoji.success} บันทึกการตั้งค่าเรียบร้อยแล้ว: ปลายทาง **${validation.targetGuildName}** (มีสมาชิกพร้อมดึงเข้า: **${Number(readyCount).toLocaleString("th-TH")}** คน)`
        });
    }

    // 2. Phase 2 Start Execution Modal Submission
    if (customId === CUSTOM_IDS.MODAL_START) {
        const amountRaw = interaction.fields.getTextInputValue(CUSTOM_IDS.FIELD_AMOUNT)?.trim();
        const webhookUrl = interaction.fields.getTextInputValue(CUSTOM_IDS.FIELD_WEBHOOK)?.trim();

        const panel = repository.findPanelByChannelId(interaction.channelId);
        if (!panel || !panel.targetGuildId) {
            return interaction.reply({
                content: `> ${emoji.alert} กรุณาเลือกรูปแบบจากเมนูด้านล่างเพื่อกำหนดเซิร์ฟเวอร์ก่อนเริ่มนะครับ`,
                ephemeral: true
            });
        }

        const mode = getMode(panel.mode);

        await interaction.deferReply({ ephemeral: true });

        const stageResult = await joinCampaignService.stageCampaign({
            client,
            repository,
            mode,
            baseConfig: {
                targetGuildId: panel.targetGuildId,
                sourceGuildId: panel.sourceGuildId
            },
            requestedAmount: amountRaw || null,
            webhookUrl: webhookUrl || null,
            startedByUserId: interaction.user.id,
            channelId: interaction.channelId
        });

        if (!stageResult.ok) {
            return interaction.editReply({
                content: `> ${emoji.error} **ไม่สามารถเตรียมงานได้:** ${stageResult.error}`
            });
        }

        return interaction.editReply(stageResult.payload);
    }
}

module.exports = {
    handleModalSubmit
};
