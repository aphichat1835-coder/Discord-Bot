/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups, activeVoiceKicks Sets.
DO NOT REMOVE: finally blocks — they unlock race condition guards.
DO NOT SIMPLIFY: Permission check chain — each check serves a specific purpose.
================================================================================
*/

const { MessageEmbed, MessageActionRow, MessageButton } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const {
    requireMemberPermission,
    requireBotPermission,
    checkRoleHierarchy,
    safeDefer
} = require("../guards/commandGuards");
// Race Condition Guards
const activeVoiceKicks = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handle(interaction, client, sessionManager, getLogChannel) {
    const cmd = interaction.commandName;

    if (cmd === "voicekickall") return handleVoiceKickAll(interaction, getLogChannel);
    if (cmd === "clear")        return handleClear(interaction);
    if (["ban", "kick", "timeout"].includes(cmd)) return handleModeration(interaction, client, getLogChannel);
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
        let kicked = [];
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
                } catch (e) {}
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

// ════════════════════════════════════════════════════════════════════════════
//  ⚖️  BAN / KICK / TIMEOUT
// ════════════════════════════════════════════════════════════════════════════
async function handleModeration(interaction, client, getLogChannel) {
    const requiredPermission = {
        ban: "BAN_MEMBERS",
        kick: "KICK_MEMBERS",
        timeout: "MODERATE_MEMBERS"
    }[interaction.commandName];

    if (!await requireMemberPermission(
        interaction,
        [requiredPermission, "ADMINISTRATOR"],
        `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งานคำสั่งนี้!`,
        { mode: "any" }
    )) return;

    const target = interaction.options.getMember("target");
    const reason = interaction.options.getString("reason") || "ไม่มีเหตุผลระบุ";

    const hierarchy = checkRoleHierarchy({ interaction, target, client, config });
    if (!hierarchy.ok) return interaction.reply({ content: hierarchy.content, ephemeral: true });

    if (!target.manageable && interaction.commandName !== "ban") {
        return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการสมาชิกท่านนี้`, ephemeral: true });
    }

    if (interaction.commandName === "timeout") {
        const mins = interaction.options.getInteger("minutes");
        if (mins <= 0) return interaction.reply({ content: `> ${config.emojis.error} เวลาต้องมากกว่า 0 นาที!`, ephemeral: true });
        if (mins > 40000) return interaction.reply({ content: `> ${config.emojis.error} เกินขีดจำกัด Discord (สูงสุด ~40,000 นาที)`, ephemeral: true });
    }

    await safeDefer(interaction);
    const targetAvatar = target.user.displayAvatarURL({ dynamic: true, size: 1024 });

    const dmEmbed = new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setTitle(`${config.emojis.punishment} คุณถูกระงับสิทธิ์ในเซิร์ฟเวอร์ ${interaction.guild.name}`)
        .setThumbnail(targetAvatar);

    try {
        if (interaction.commandName === "ban") {
            if (!interaction.guild.members.me.permissions.has("BAN_MEMBERS")) throw new Error("MISSING_PERMS");
            dmEmbed.setDescription(`— **การดำเนินการ:** แบนถาวร\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
            await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
            await target.ban({ reason });

        } else if (interaction.commandName === "kick") {
            if (!interaction.guild.members.me.permissions.has("KICK_MEMBERS")) throw new Error("MISSING_PERMS");
            dmEmbed.setDescription(`— **การดำเนินการ:** เตะออกจากเซิร์ฟเวอร์\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
            await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
            await target.kick(reason);

        } else if (interaction.commandName === "timeout") {
            if (!interaction.guild.members.me.permissions.has("MODERATE_MEMBERS")) throw new Error("MISSING_PERMS");
            const mins = interaction.options.getInteger("minutes");
            dmEmbed.setDescription(`— **การดำเนินการ:** Timeout ${mins} นาที ${config.emojis.timeout_icon}\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
            await target.timeout(mins * 60000, reason);
            await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
        }

        const replyEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setAuthor({ name: "ลงดาบผู้กระทำผิดเรียบร้อย", iconURL: interaction.guild.iconURL() })
            .setDescription(
                `> ${config.emojis.success} **ดำเนินการสำเร็จ!**\n` +
                `> ${config.emojis.user} **เป้าหมาย:** <@${target.id}>\n` +
                `> ${config.emojis.hammer} **การดำเนินการ:** **${interaction.commandName.toUpperCase()}**\n` +
                `> ${config.emojis.note} **เหตุผล:** ${reason}`
            )
            .setThumbnail(targetAvatar);

        const logCh = await getLogChannel(interaction.guild, 'member');
        if (logCh) logCh.send({ embeds: [replyEmbed] }).catch(() => {});
        return interaction.editReply({ embeds: [replyEmbed] });

    } catch (err) {
        sessionManager.systemMetrics.increment('errors');
        if (err.message === "MISSING_PERMS") {
            return interaction.editReply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ที่จำเป็น!` });
        }
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่สามารถดำเนินการได้: ${err.message}` });
    }
}

function getRuntimeDiagnostics() {
    return {
        activeVoiceKicks: activeVoiceKicks.size
    };
}

module.exports = { handle, getRuntimeDiagnostics };
