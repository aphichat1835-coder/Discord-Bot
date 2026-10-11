"use strict";

const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");
const emoji = require("./emojis");
const { listModes } = require("../modes/modeRegistry");

const IDS = Object.freeze({
    SELECT_MODE: "join_camp_mode_select",
    BTN_START: "join_camp_btn_start",
    BTN_RUNNING: "join_camp_btn_running"
});

function buildPanelPayload({
    mode,
    panelState = {},
    readyCount = null,
    liveJob = null,
    sourceGuildName = null,
    targetGuildName = null
}) {
    const isRunning = Boolean(liveJob && liveJob.status === "RUNNING");

    // 1. Embed Build
    const embed = new EmbedBuilder()
        .setTitle(`${emoji.boost} จัดการดึงสมาชิกเข้าเซิร์ฟเวอร์`)
        .setDescription("ช่วยนำสมาชิกที่ยืนยันตัวตนเข้าสู่เซิร์ฟเวอร์เป้าหมายอย่างปลอดภัย สามารถเลือกรูปแบบและตั้งค่าเซิร์ฟเวอร์ได้จากเมนูด้านล่าง")
        .setColor(isRunning ? 0xFEE75C : 0x57F287)
        .setTimestamp();

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

    embed.setFooter({ text: "ดึงสมาชิกอัตโนมัติ • ปลอดภัยและเป็นไปตามข้อกำหนด" });

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

    return {
        embeds: [embed],
        components: [selectRow, actionRow]
    };
}

module.exports = {
    IDS,
    buildPanelPayload
};
