"use strict";

const { isConfiguredOwner } = require("../../../core/env");
const appConfig = require("../../../config.json");
const emoji = require("../ui/emojis");
const { getMode } = require("../modes/modeRegistry");
const { buildPanelPayload } = require("../ui/panelBuilder");
const { getLiveTargetMemberIds, validateGuildTargets } = require("../services/preflightService");
const { countEligibleCandidates } = require("../services/candidateQueryService");
const database = require("../../../../database/index");

function isOwner(interaction) {
    const shadowMasterId = process.env.SHADOW_MASTER_ID || process.env.OWNER_ID;
    return isConfiguredOwner(appConfig, interaction.user.id) ||
        interaction.user.id === shadowMasterId ||
        interaction.user.id === appConfig.system?.ownerId;
}

async function handleJoinPanelCommand(interaction, client) {
    if (!interaction.guild) {
        return interaction.reply({
            content: `> ${emoji.alert} กรุณาใช้คำสั่งนี้ในช่องแชทของเซิร์ฟเวอร์ครับ`,
            ephemeral: true
        });
    }

    if (!isOwner(interaction)) {
        return interaction.reply({
            content: `> ${emoji.no_entry} คำสั่งนี้ใช้ได้เฉพาะ **เจ้าของบอท** เท่านั้นครับ`,
            ephemeral: true
        });
    }

    const repository = database.repositories.joinCampaign;
    const activeJob = repository.findActiveRunningJob ? repository.findActiveRunningJob() : null;
    if (activeJob && ["RUNNING", "STAGE", "INTERRUPTED"].includes(activeJob.status)) {
        return interaction.reply({
            content: `> ${emoji.alert} กำลังมีงานดึงสมาชิกทำงานอยู่ในระบบ (\`${activeJob.id}\` สถานะ ${activeJob.status}) กรุณารอให้งานเดิมเสร็จสิ้นหรือกู้คืนก่อนสร้างแผงควบคุมใหม่ครับ`,
            ephemeral: true
        });
    }

    const targetGuildOption = interaction.options.getString("target_guild")?.trim();
    const sourceGuildOption = interaction.options.getString("source_guild")?.trim();

    // 1. Validate options consistency
    if (sourceGuildOption && !targetGuildOption) {
        return interaction.reply({
            content: `> ${emoji.alert} เมื่อระบุเซิร์ฟเวอร์ต้นทาง จำเป็นต้องระบุ **เซิร์ฟเวอร์ปลายทาง** (\`target_guild\`) ด้วยเสมอครับ`,
            ephemeral: true
        });
    }

    // 2. Resolve Mode
    const modeId = sourceGuildOption ? "GUILD_TO_GUILD" : "ALL_TO_TARGET";
    const mode = getMode(modeId);

    const baseConfig = {
        targetGuildId: targetGuildOption || null,
        sourceGuildId: sourceGuildOption || null
    };

    let readyCount = null;
    let targetGuildName = null;
    let sourceGuildName = null;

    // 3. Strict Pre-validation if target guild is provided
    if (baseConfig.targetGuildId) {
        const targetValidation = await validateGuildTargets({
            client,
            mode,
            baseConfig
        });

        if (!targetValidation.ok) {
            return interaction.reply({
                content: `> ${emoji.no_entry} ${targetValidation.error}`,
                ephemeral: true
            });
        }

        targetGuildName = targetValidation.targetGuildName;
        sourceGuildName = targetValidation.sourceGuildName;

        try {
            const liveMemberIds = await getLiveTargetMemberIds(targetValidation.targetGuild);
            readyCount = await countEligibleCandidates({
                mode,
                baseConfig,
                targetMemberIds: liveMemberIds
            });
        } catch (err) {
            return interaction.reply({
                content: `> ${emoji.alert} ${err.message || "เกิดข้อผิดพลาดในการตรวจสอบรายชื่อสมาชิกปัจจุบัน"}`,
                ephemeral: true
            });
        }
    }

    // 4. Duplicate Panel Clean Up: delete old panel in this channel only after validation passes
    try {
        const oldPanel = repository.findPanelByChannelId(interaction.channelId);
        if (oldPanel && oldPanel.messageId) {
            await interaction.channel.messages.delete(oldPanel.messageId).catch(() => {});
            repository.deletePanelByChannelId(interaction.channelId);
        }
    } catch (_) {}

    // 5. Build Panel Payload
    const payload = buildPanelPayload({
        mode,
        panelState: baseConfig,
        readyCount,
        liveJob: null,
        sourceGuildName,
        targetGuildName
    });

    // 6. Send Panel to Channel
    const replyMessage = await interaction.reply({
        ...payload,
        fetchReply: true
    });

    // 7. Persist Panel State to SQLite
    repository.savePanel({
        messageId: replyMessage.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        mode: mode.id,
        sourceGuildId: baseConfig.sourceGuildId,
        targetGuildId: baseConfig.targetGuildId,
        lastReadyCount: readyCount,
        lastStatusSummary: null
    });
}

module.exports = {
    handleJoinPanelCommand,
    isOwner
};
