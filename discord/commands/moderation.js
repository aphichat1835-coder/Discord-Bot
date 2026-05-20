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
const voiceWorker = require("../voiceWorker");

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
    if (!interaction.member.permissions.has("ADMINISTRATOR")) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`, ephemeral: true });
    if (!interaction.guild.me.permissions.has("MOVE_MEMBERS")) return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ย้ายสมาชิก`, ephemeral: true });

    if (activeVoiceKicks.has(interaction.guild.id)) {
        return interaction.reply({ content: `> ${config.emojis.warning} ระบบกำลังดำเนินการอยู่ กรุณารอ`, ephemeral: true });
    }
    activeVoiceKicks.add(interaction.guild.id);
    await interaction.deferReply();

    try {
        const startTime = Date.now();
        const MAX_DURATION = 14 * 60 * 1000;
        let kicked = [];
        let isTimeoutHit = false;

        for (const [memberId, member] of vc.members) {
            // เฟส 21: Event Loop Yielding — กัน UptimeRobot timeout
            await new Promise(resolve => setImmediate(resolve));

            if (Date.now() - startTime > MAX_DURATION) { isTimeoutHit = true; break; }
            if (!member.permissions.has("ADMINISTRATOR")) {
                try {
                    await member.voice.disconnect();
                    kicked.push(`<@${memberId}>`);
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {}
            }
        }

        const limitMsg = isTimeoutHit ? `\n> ⚠️ **หยุดอัตโนมัติ:** เกิน 14 นาที` : "";
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setDescription(
                `> ${config.emojis.success} **จัดการห้องเสียงเรียบร้อย 🧹**\n\n` +
                `— **เตะสำเร็จ ${kicked.length} คน:**\n` +
                `${kicked.length > 0 ? kicked.join(", ") : "- ไม่มีใครถูกเตะ -"}${limitMsg}`
            );

        const logCh = await getLogChannel(interaction.guild);
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
    if (!interaction.member.permissions.has("MANAGE_MESSAGES")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ลบข้อความ`, ephemeral: true });
    }
    if (!interaction.guild.me.permissions.has("MANAGE_MESSAGES")) {
        return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้`, ephemeral: true });
    }

    const amt = interaction.options.getInteger("amount");
    if (amt < 1 || amt > 100) {
        return interaction.reply({ content: `> ${config.emojis.warning} กรุณาระบุจำนวน 1-100 เท่านั้น`, ephemeral: true });
    }

    try {
        // เฟส C1: Fetch สด แล้ว bulkDelete
        const deletedMsgs = await interaction.channel.bulkDelete(amt, true);
        if (deletedMsgs.size === 0) {
            return interaction.reply({
                content: `> ${config.emojis.warning} ลบไม่สำเร็จ: ไม่พบข้อความใหม่ (ข้อความเก่ากว่า 14 วันลบแบบรวดเดียวไม่ได้)`,
                ephemeral: true
            });
        }
        return interaction.reply({
            content: `> ${config.emojis.success} ลบข้อความสำเร็จ **${deletedMsgs.size}** ข้อความ`,
            ephemeral: true
        });
    } catch (e) {
        return interaction.reply({ content: `> ${config.emojis.error} ล้มเหลว: ${e.message}`, ephemeral: true });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚖️  BAN / KICK / TIMEOUT
// ════════════════════════════════════════════════════════════════════════════
async function handleModeration(interaction, client, getLogChannel) {
    if (!interaction.member.permissions.has("MODERATE_MEMBERS") && !interaction.member.permissions.has("ADMINISTRATOR")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งาน!`, ephemeral: true });
    }

    const target = interaction.options.getMember("target");
    const reason = interaction.options.getString("reason") || "ไม่มีเหตุผลระบุ";

    if (!target) return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่พบเป้าหมาย!`, ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ content: `> ${config.emojis.warning} คุณไม่สามารถทำโทษตัวเองได้!`, ephemeral: true });
    if (target.id === client.user.id) return interaction.reply({ content: `> ${config.emojis.warning} คุณไม่สามารถทำโทษบอทระบบได้!`, ephemeral: true });

    if (
        target.roles.highest.position >= interaction.member.roles.highest.position &&
        interaction.user.id !== interaction.guild.ownerId
    ) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} คุณไม่สามารถทำโทษผู้ที่มียศสูงกว่าหรือเท่ากับคุณได้!`, ephemeral: true });
    }

    if (target.roles.highest.position >= interaction.guild.me.roles.highest.position) {
        return interaction.reply({ content: `> ${config.emojis.error} ยศของบอทต่ำกว่าเป้าหมาย ไม่สามารถทำโทษได้!`, ephemeral: true });
    }

    if (!target.manageable && interaction.commandName !== "ban") {
        return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการสมาชิกท่านนี้`, ephemeral: true });
    }

    if (interaction.commandName === "timeout") {
        const mins = interaction.options.getInteger("minutes");
        if (mins <= 0) return interaction.reply({ content: `> ${config.emojis.error} เวลาต้องมากกว่า 0 นาที!`, ephemeral: true });
        if (mins > 40000) return interaction.reply({ content: `> ${config.emojis.error} เกินขีดจำกัด Discord (สูงสุด ~40,000 นาที)`, ephemeral: true });
    }

    await interaction.deferReply();
    const targetAvatar = target.user.displayAvatarURL({ dynamic: true, size: 1024 });

    const dmEmbed = new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setTitle(`🚨 คุณถูกระงับสิทธิ์ในเซิร์ฟเวอร์ ${interaction.guild.name}`)
        .setThumbnail(targetAvatar);

    try {
        if (interaction.commandName === "ban") {
            if (!interaction.guild.me.permissions.has("BAN_MEMBERS")) throw new Error("MISSING_PERMS");
            dmEmbed.setDescription(`— **การดำเนินการ:** แบนถาวร\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
            target.user.send({ embeds: [dmEmbed] }).catch(() => {});
            await target.ban({ reason });

        } else if (interaction.commandName === "kick") {
            if (!interaction.guild.me.permissions.has("KICK_MEMBERS")) throw new Error("MISSING_PERMS");
            dmEmbed.setDescription(`— **การดำเนินการ:** เตะออกจากเซิร์ฟเวอร์\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
            target.user.send({ embeds: [dmEmbed] }).catch(() => {});
            await target.kick(reason);

        } else if (interaction.commandName === "timeout") {
            if (!interaction.guild.me.permissions.has("MODERATE_MEMBERS")) throw new Error("MISSING_PERMS");
            const mins = interaction.options.getInteger("minutes");
            dmEmbed.setDescription(`— **การดำเนินการ:** Timeout ${mins} นาที ⏳\n— **ผู้ดำเนินการ:** ${interaction.user.tag}\n— **เหตุผล:** ${reason}`);
            target.user.send({ embeds: [dmEmbed] }).catch(() => {});
            await target.timeout(mins * 60000, reason);
        }

        const replyEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setAuthor({ name: "ลงดาบผู้กระทำผิดเรียบร้อย", iconURL: interaction.guild.iconURL() })
            .setDescription(
                `> ${config.emojis.success} **ดำเนินการสำเร็จ!**\n` +
                `> 👤 **เป้าหมาย:** <@${target.id}>\n` +
                `> 🔨 **การดำเนินการ:** **${interaction.commandName.toUpperCase()}**\n` +
                `> 📝 **เหตุผล:** ${reason}`
            )
            .setThumbnail(targetAvatar);

        const logCh = await getLogChannel(interaction.guild);
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

module.exports = { handle };
