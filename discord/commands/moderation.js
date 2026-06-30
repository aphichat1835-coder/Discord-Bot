/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups, activeVoiceKicks Sets.
DO NOT REMOVE: finally blocks — they unlock race condition guards.
DO NOT SIMPLIFY: Permission check chain — each check serves a specific purpose.
================================================================================
*/

const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const {
    requireMemberPermission,
    requireBotPermission,
    safeDefer
} = require("../guards/commandGuards");
const { handleModerationCommand } = require("./moderationWorkflow");

// Race Condition Guards
const activeVoiceKicks = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handle(interaction, client, sessionManager, getLogChannel) {
    const cmd = interaction.commandName;

    if (cmd === "voicekickall") return handleVoiceKickAll(interaction, getLogChannel);
    if (cmd === "clear")        return handleClear(interaction);
    if (["ban", "kick", "timeout"].includes(cmd)) return handleModerationCommand(interaction, client);
}

// ════════════════════════════════════════════════════════════════════════════
//  🔇  VOICE KICK ALL
// ════════════════════════════════════════════════════════════════════════════
async function handleVoiceKickAll(interaction, getLogChannel) {
    const vc = interaction.member.voice.channel;
    if (!vc) return interaction.reply({ content: `> ${config.emojis.no_entry} คุณต้องอยู่ในห้องเสียงก่อน!`, ephemeral: true });
    if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`)) return;
    if (!await requireBotPermission(interaction, "MOVE_MEMBERS", `> ${config.emojis.error} บอทไม่มีสิทธิ์ย้ายสมาชิก`)) return;

    if (activeVoiceKicks.has(interaction.guild.id)) {
        return interaction.reply({ content: `> ${config.emojis.warning} ระบบกำลังดำเนินการอยู่ กรุณารอ`, ephemeral: true });
    }
    activeVoiceKicks.add(interaction.guild.id);
    await safeDefer(interaction);

    try {
        const startTime = Date.now();
        const MAX_DURATION = 14 * 60 * 1000;
        const kicked = [];
        let isTimeoutHit = false;

        const memberSnapshot = Array.from(vc.members.values());
        for (const member of memberSnapshot) {
            await new Promise(resolve => setImmediate(resolve));

            if (Date.now() - startTime > MAX_DURATION) { isTimeoutHit = true; break; }
            if (!member.permissions.has("ADMINISTRATOR")) {
                try {
                    await member.voice.disconnect();
                    kicked.push(`<@${member.id}>`);
                    await new Promise(r => setTimeout(r, 500));
                } catch {}
            }
        }

        const limitMsg = isTimeoutHit ? `\n> ${config.emojis.warning} **หยุดอัตโนมัติ:** เกิน 14 นาที` : "";
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setDescription(
                `> ${config.emojis.success} **จัดการห้องเสียงเรียบร้อย** ${config.emojis.broom}\n\n` +
                `— **เตะสำเร็จ ${kicked.length} คน:**\n` +
                `${kicked.length > 0
                    ? (kicked.length > 50
                        ? kicked.slice(0, 50).join(", ") + `\n... และอีก ${kicked.length - 50} คน`
                        : kicked.join(", "))
                    : "- ไม่มีใครถูกเตะ -"}${limitMsg}`
            );

        const logMap = await sessionManager.getLogChannelMap(interaction.guild.id);
        const logCh = logMap?.voiceChannelId ? interaction.guild.channels.cache.get(logMap.voiceChannelId) : null;
        if (logCh) logCh.send({ embeds: [embed] }).catch(() => {});
        return interaction.editReply({ embeds: [embed] });
    } finally {
        activeVoiceKicks.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🧹  CLEAR
// ════════════════════════════════════════════════════════════════════════════
async function handleClear(interaction) {
    if (!await requireMemberPermission(interaction, "MANAGE_MESSAGES", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ลบข้อความ`)) return;
    if (!await requireBotPermission(interaction, "MANAGE_MESSAGES", `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้`)) return;

    const amt = interaction.options.getInteger("amount");
    if (amt < 1 || amt > 100) {
        return interaction.reply({ content: `> ${config.emojis.warning} กรุณาระบุจำนวน 1-100 เท่านั้น`, ephemeral: true });
    }

    try {
        const deletedMsgs = await interaction.channel.bulkDelete(amt, true);
        if (deletedMsgs.size === 0) {
            return interaction.reply({
                content: `> ${config.emojis.warning} ลบไม่สำเร็จ: ไม่พบข้อความใหม่ (ข้อความเก่ากว่า 14 วันลบแบบรวดเดียวไม่ได้)`,
                ephemeral: true
            });
        }
        sessionManager.getLogChannelMap(interaction.guild.id).then(logMap => {
            const logCh = logMap?.messageChannelId ? interaction.guild.channels.cache.get(logMap.messageChannelId) : null;
            if (logCh) logCh.send({ embeds: [new MessageEmbed()
                .setColor(config.system.themeColors.warning)
                .setDescription(`> ${config.emojis.broom} **/clear ถูกใช้**\n— **โดย:** <@${interaction.user.id}>\n— **ห้อง:** <#${interaction.channel.id}>\n— **ลบ:** ${deletedMsgs.size} ข้อความ`)
                .setTimestamp()
            ] }).catch(() => {});
        }).catch(() => {});
        return interaction.reply({
            content: `> ${config.emojis.success} ลบข้อความสำเร็จ **${deletedMsgs.size}** ข้อความ`,
            ephemeral: true
        });
    } catch (e) {
        if (e.code === 50034) {
            return interaction.reply({ content: `> ${config.emojis.warning} ข้อความบางส่วนเก่าเกิน 14 วัน ลบแบบรวดเดียวไม่ได้`, ephemeral: true });
        }
        if (e.code === 50013) {
            return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้`, ephemeral: true });
        }
        if (e.code === 10008) {
            return interaction.reply({ content: `> ${config.emojis.warning} ข้อความบางรายการถูกลบไปแล้ว`, ephemeral: true });
        }
        return interaction.reply({ content: `> ${config.emojis.error} ล้มเหลว: ${e.message}`, ephemeral: true });
    }
}

function getRuntimeDiagnostics() {
    return {
        activeVoiceKicks: activeVoiceKicks.size
    };
}

module.exports = { handle, getRuntimeDiagnostics };
