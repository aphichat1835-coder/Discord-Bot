"use strict";

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");
const emoji = require("./emojis");

const IDS = Object.freeze({
    BTN_CONFIRM_PREFIX: "join_camp_btn_confirm:"
});

function buildPreflightConfirmationPayload({
    stageId,
    mode,
    sourceGuildName = null,
    sourceGuildId = null,
    targetGuildName = null,
    targetGuildId,
    readyCount,
    requestedQuota,
    hasWebhook = false
}) {
    const embed = new EmbedBuilder()
        .setTitle(`${emoji.shield} ตรวจสอบข้อมูลก่อนเริ่มดึงสมาชิก`)
        .setDescription("ตรวจสอบรายละเอียดด้านล่างให้ถูกต้องเรียบร้อย แล้วกดยืนยันเพื่อเริ่มดึงสมาชิกได้เลยครับ")
        .setColor(0x57F287)
        .addFields([
            {
                name: `${emoji.sparkle} รูปแบบการทำงาน`,
                value: `**${mode.label}**`,
                inline: true
            },
            {
                name: `${emoji.server} เซิร์ฟเวอร์ปลายทาง`,
                value: targetGuildName ? `${targetGuildName} (\`${targetGuildId}\`)` : `\`${targetGuildId}\``,
                inline: true
            }
        ]);

    if (mode.requiresSource && sourceGuildId) {
        embed.addFields({
            name: `${emoji.server} เซิร์ฟเวอร์ต้นทาง`,
            value: sourceGuildName ? `${sourceGuildName} (\`${sourceGuildId}\`)` : `\`${sourceGuildId}\``,
            inline: true
        });
    }

    embed.addFields([
        {
            name: `${emoji.members} สมาชิกพร้อมดึงเข้า`,
            value: `**${Number(readyCount).toLocaleString("th-TH")}** คน *(ตัดคนที่อยู่ในเซิร์ฟเวอร์แล้วออก)*`,
            inline: false
        },
        {
            name: `${emoji.boost} เป้าหมายที่จะดึงเข้าสำเร็จ`,
            value: `**${Number(requestedQuota).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.key} ช่องทางแจ้งเตือน Webhook`,
            value: hasWebhook ? "เปิดแจ้งเตือนผ่าน Webhook" : "ไม่ได้ระบุ *(แสดงผลบนหน้าจอเท่านั้น)*",
            inline: true
        }
    ]);

    embed.setFooter({
        text: "หากไม่ต้องการเริ่มดึงสมาชิก สามารถกดปิดหน้าต่างนี้ได้ทันทีครับ"
    });

    const confirmBtn = new ButtonBuilder()
        .setCustomId(`${IDS.BTN_CONFIRM_PREFIX}${stageId}`)
        .setLabel("ยืนยันเริ่มดึงสมาชิก")
        .setStyle(ButtonStyle.Success);

    const actionRow = new ActionRowBuilder().addComponents(confirmBtn);

    return {
        embeds: [embed],
        components: [actionRow]
    };
}

module.exports = {
    IDS,
    buildPreflightConfirmationPayload
};
