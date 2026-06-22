/*
 * /case command handler
 * Read-only and reason-amend tools for moderation audit records.
 */

const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const modCaseManager = require("../logging/modCaseManager");
const { LOG_CHANNEL_TYPES, routeAndSendLog, safeAuditText } = require("../logging/logCore");
const { requireMemberPermission, safeDefer } = require("../guards/commandGuards");
const { formatDiscordTime } = require("../logging/logFormat");

function formatCaseLine(caseDoc) {
    const created = caseDoc.createdAt ? formatDiscordTime(caseDoc.createdAt, "d") : "ไม่ทราบวันที่";
    return `#${caseDoc.caseNumber} — **${String(caseDoc.action || "unknown").toUpperCase()}** <@${caseDoc.userId}> — ${created} — ${safeAuditText(caseDoc.reason || "ไม่มีเหตุผล", 120)}`;
}

function buildCaseListEmbed(title, cases = []) {
    const lines = cases.length
        ? cases.slice(0, 10).map(formatCaseLine).join("\n")
        : "ไม่พบ Case";

    return new MessageEmbed()
        .setColor(config.system.themeColors.info)
        .setTitle(title)
        .setDescription(lines)
        .setTimestamp();
}

async function requireCasePermission(interaction) {
    return requireMemberPermission(
        interaction,
        ["MODERATE_MEMBERS", "BAN_MEMBERS", "KICK_MEMBERS", "ADMINISTRATOR"],
        `> ${config.emojis.no_entry} ไม่มีสิทธิ์ดู/แก้ไข Case`,
        { mode: "any" }
    );
}

async function handleView(interaction) {
    const caseNumber = interaction.options.getInteger("case_id");
    const caseDoc = await modCaseManager.getCase(sessionManager, interaction.guild.id, caseNumber);
    if (!caseDoc) return interaction.editReply({ content: `> ${config.emojis.warning} ไม่พบ Case #${caseNumber}` });
    return interaction.editReply({ embeds: [modCaseManager.buildModerationCaseEmbed(caseDoc)] });
}

async function handleReason(interaction) {
    const caseNumber = interaction.options.getInteger("case_id");
    const reason = safeAuditText(interaction.options.getString("reason") || "ไม่มีเหตุผลระบุ", 500);
    const updated = await modCaseManager.updateCaseReason(sessionManager, interaction.guild.id, caseNumber, reason, interaction.user.id);
    if (!updated) return interaction.editReply({ content: `> ${config.emojis.warning} ไม่พบ Case #${caseNumber}` });

    const embed = modCaseManager.buildModerationCaseEmbed(updated, {
        title: `${config.emojis.note} Case #${updated.caseNumber} | แก้ไขเหตุผล`
    });
    await routeAndSendLog({ guild: interaction.guild, sessionManager, category: LOG_CHANNEL_TYPES.MODERATION, embed });
    return interaction.editReply({ embeds: [embed] });
}

async function handleUserCases(interaction) {
    const target = interaction.options.getMember("target") || interaction.options.getUser("target");
    if (!target?.id) return interaction.editReply({ content: `> ${config.emojis.warning} ไม่พบผู้ใช้เป้าหมาย` });
    const cases = await modCaseManager.listUserCases(sessionManager, interaction.guild.id, target.id, 10);
    return interaction.editReply({ embeds: [buildCaseListEmbed(`🧾 Cases ของ ${target.user?.tag || target.tag || target.id}`, cases)] });
}

async function handleLatest(interaction) {
    const target = interaction.options.getMember("target") || interaction.options.getUser("target") || interaction.member;
    const cases = await modCaseManager.listUserCases(sessionManager, interaction.guild.id, target.id, 1);
    if (!cases.length) return interaction.editReply({ content: `> ${config.emojis.warning} ไม่พบ Case ล่าสุดของผู้ใช้นี้` });
    return interaction.editReply({ embeds: [modCaseManager.buildModerationCaseEmbed(cases[0])] });
}

async function handle(interaction) {
    if (!await requireCasePermission(interaction)) return;
    await safeDefer(interaction, { ephemeral: true });

    const sub = interaction.options.getSubcommand();
    if (sub === "view") return handleView(interaction);
    if (sub === "reason") return handleReason(interaction);
    if (sub === "user") return handleUserCases(interaction);
    if (sub === "latest") return handleLatest(interaction);

    return interaction.editReply({ content: `> ${config.emojis.warning} Subcommand ไม่ถูกต้อง` });
}

module.exports = {
    handle,
    _test: {
        formatCaseLine,
        buildCaseListEmbed
    }
};
