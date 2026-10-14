"use strict";

const path = require("path");
const fs = require("fs");
const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder
} = require("discord.js");
const config = require("../../../config.json");
const { getPrimaryOwnerId } = require("../../../core/env");
const emoji = require("./emojis");
const { listModes } = require("../modes/modeRegistry");

const IDS = Object.freeze({
    SELECT_MODE: "join_camp_mode_select",
    BTN_START: "join_camp_btn_start",
    BTN_RUNNING: "join_camp_btn_running"
});

const JOIN_PANEL_BANNER_ATTACHMENT_NAME = "join-panel-banner.gif";

function getJoinPanelBannerPath() {
    try {
        const resolved = path.resolve(__dirname, "../../../assets/join-panel-banner.gif");
        if (fs.existsSync(resolved)) {
            return resolved;
        }
        return require.resolve("../../../assets/join-panel-banner.gif");
    } catch {
        return null;
    }
}

function buildPanelPayload({
    mode,
    panelState = {},
    readyCount = null,
    liveJob = null,
    sourceGuildName = null,
    targetGuildName = null,
    includeFiles = false
}) {
    const isRunning = Boolean(liveJob && liveJob.status === "RUNNING");
    const primaryOwnerId = getPrimaryOwnerId(process.env, config) || config.system?.ownerId || "661415152146710558";
    const bannerPath = getJoinPanelBannerPath();
    const hasAttachment = Boolean(bannerPath);

    // 1. Embed Build
    const embed = new EmbedBuilder()
        .setTitle(`${emoji.universe || emoji.sparkle} : Phomueangtai จัดการดึงสมาชิกเข้าเซิร์ฟเวอร์`)
        .setDescription(
            `ระบบจัดการดึงสมาชิกเข้าเซิร์ฟเวอร์ ${emoji.dreamworld}\n\n` +
            `นำสมาชิกที่ยืนยันตัวตนเข้าสู่เซิร์ฟเวอร์อย่างปลอดภัย ${emoji.dreamworld}\n\n` +
            `เลือกรูปแบบและตั้งค่าควบคุมผ่านปุ่มข้างล่าง ${emoji.dreamworld}\n\n` +
            `*Developed by <@${primaryOwnerId}>*`
        )
        .setColor(isRunning ? 0xFEE75C : 0x57F287)
        .setTimestamp();

    if (hasAttachment) {
        embed.setImage(`attachment://${JOIN_PANEL_BANNER_ATTACHMENT_NAME}`);
    } else if (config.system?.joinCampaignBannerUrl) {
        embed.setImage(config.system.joinCampaignBannerUrl);
    } else if (config.system?.bannerUrl) {
        embed.setImage(config.system.bannerUrl);
    }

    // Add fields specific to the mode
    const modeFields = mode.formatPanelFields({
        panelState,
        readyCount,
        liveJob,
        sourceGuildName,
        targetGuildName
    });
    embed.addFields(modeFields);

    // Status Field
    if (isRunning) {
        const joined = liveJob.joinedCount ?? liveJob.joined_count ?? 0;
        const targetQuota = liveJob.requestedAmount ?? liveJob.requested_amount ?? (liveJob.selectedAmount ?? liveJob.selected_amount ?? 0);
        embed.addFields({
            name: `${emoji.loading} สถานะงานปัจจุบัน`,
            value: `กำลังดึงสมาชิกเข้าเซิร์ฟเวอร์: **${Number(joined).toLocaleString("th-TH")}** / **${Number(targetQuota).toLocaleString("th-TH")}** คน`,
            inline: false
        });
    } else if (panelState.lastStatusSummary) {
        embed.addFields({
            name: `${emoji.success} สถานะล่าสุด`,
            value: panelState.lastStatusSummary,
            inline: false
        });
    } else {
        embed.addFields({
            name: `${emoji.online} สถานะความพร้อม`,
            value: panelState.targetGuildId ? "พร้อมเริ่มดึงสมาชิกแล้ว" : "กรุณาเลือกรูปแบบด้านล่างเพื่อตั้งค่าเซิร์ฟเวอร์",
            inline: false
        });
    }

    // 2. Select Menu Row (Modes)
    const selectOptions = listModes().map(m => ({
        label: m.label,
        description: m.description.slice(0, 100),
        value: m.id,
        emoji: m.selectEmoji,
        default: m.id === mode.id
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(IDS.SELECT_MODE)
        .setPlaceholder("เลือกรูปแบบการดึงสมาชิก...")
        .setDisabled(isRunning)
        .addOptions(selectOptions);

    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // 3. Action Button Row
    const actionRow = new ActionRowBuilder();
    if (isRunning) {
        const btnRunning = new ButtonBuilder()
            .setCustomId(IDS.BTN_RUNNING)
            .setLabel("กำลังดึงสมาชิก...")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);
        actionRow.addComponents(btnRunning);
    } else {
        const btnStart = new ButtonBuilder()
            .setCustomId(IDS.BTN_START)
            .setLabel("เริ่มดึงสมาชิก")
            .setStyle(ButtonStyle.Success)
            .setDisabled(false);
        actionRow.addComponents(btnStart);
    }

    const payload = {
        embeds: [embed],
        components: [selectRow, actionRow]
    };

    if (includeFiles && hasAttachment) {
        payload.files = [new AttachmentBuilder(bannerPath, { name: JOIN_PANEL_BANNER_ATTACHMENT_NAME })];
    }

    return payload;
}

module.exports = {
    IDS,
    JOIN_PANEL_BANNER_ATTACHMENT_NAME,
    getJoinPanelBannerPath,
    buildPanelPayload
};
