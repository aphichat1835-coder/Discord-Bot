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
    safeDefer,
    markCommandAccepted
} = require("../guards/commandGuards");
const { handleModerationCommand } = require("./moderationWorkflow");

// Race Condition Guards
const activeVoiceKicks = new Set();
const activeClearChannels = new Set();
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BULK_DELETE_SAFETY_MS = 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handle(interaction, client) {
    const cmd = interaction.commandName;

    if (cmd === "voicekickall") return handleVoiceKickAll(interaction);
    if (cmd === "clear")        return handleClear(interaction);
    if (["ban", "kick", "timeout"].includes(cmd)) return handleModerationCommand(interaction, client);
}

// ════════════════════════════════════════════════════════════════════════════
//  🔇  VOICE KICK ALL
// ════════════════════════════════════════════════════════════════════════════
async function handleVoiceKickAll(interaction) {
    const vc = interaction.member.voice.channel;
    if (!vc) return interaction.reply({ content: `> ${config.emojis.no_entry} คุณต้องอยู่ในห้องเสียงก่อน!`, ephemeral: true });
    if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`)) return;
    if (!await requireBotPermission(interaction, "MOVE_MEMBERS", `> ${config.emojis.error} บอทไม่มีสิทธิ์ย้ายสมาชิกในห้องนี้`, vc)) return;

    if (activeVoiceKicks.has(interaction.guild.id)) {
        return interaction.reply({ content: `> ${config.emojis.warning} ระบบกำลังดำเนินการอยู่ กรุณารอ`, ephemeral: true });
    }
    activeVoiceKicks.add(interaction.guild.id);
    markCommandAccepted(interaction);

    try {
        if (!await safeDefer(interaction)) return null;
        const startTime = Date.now();
        const MAX_DURATION = 14 * 60 * 1000;
        const kicked = [];
        let failed = 0;
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
                } catch {
                    failed++;
                }
            }
        }

        const limitMsg = isTimeoutHit ? `\n> ${config.emojis.warning} **หยุดอัตโนมัติ:** เกิน 14 นาที` : "";
        const eligibleCount = memberSnapshot.filter(member => !member.permissions.has("ADMINISTRATOR")).length;
        let resultState = "failed";
        if (kicked.length > 0) {
            resultState = failed === 0 && !isTimeoutHit && kicked.length === eligibleCount
                ? "complete"
                : "partial";
        }
        let resultColor = config.system.themeColors.error;
        if (resultState === "complete") resultColor = config.system.themeColors.success;
        else if (resultState === "partial") resultColor = config.system.themeColors.warning;
        const embed = new MessageEmbed()
            .setColor(resultColor)
            .setDescription(
                `> **ผลการจัดการ: ${resultState}** ${config.emojis.broom}\n> เป้าหมายทั้งหมด: ${eligibleCount} คน\n\n` +
                `— **เตะสำเร็จ ${kicked.length} คน:**\n` +
                `${kicked.length > 0
                    ? (kicked.length > 50
                        ? kicked.slice(0, 50).join(", ") + `\n... และอีก ${kicked.length - 50} คน`
                        : kicked.join(", "))
                    : "- ไม่มีใครถูกเตะ -"}\n` +
                `— **ล้มเหลว:** ${failed} คน${limitMsg}`
            );

        return interaction.editReply({ embeds: [embed] });
    } finally {
        activeVoiceKicks.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🧹  CLEAR
// ════════════════════════════════════════════════════════════════════════════
function isBulkDeletableMessage(message, now = Date.now()) {
    const createdAt = Number(message?.createdTimestamp || 0);
    return createdAt > 0 && now - createdAt < BULK_DELETE_MAX_AGE_MS - BULK_DELETE_SAFETY_MS;
}

async function deleteMessagesIndividually(messages) {
    let deleted = 0;
    let failed = 0;
    for (const message of messages) {
        try {
            await message.delete();
            deleted++;
        } catch {
            failed++;
        }
    }
    return { deleted, failed };
}

async function deleteChannelMessages(channel, amount, now = Date.now()) {
    const fetched = await channel.messages.fetch({ limit: amount });
    const messages = Array.from(fetched.values());
    const recent = messages.filter(message => isBulkDeletableMessage(message, now));
    const historical = messages.filter(message => !isBulkDeletableMessage(message, now));
    const bulkDeletedIds = new Set();
    let bulkDeleted = 0;

    if (recent.length >= 2) {
        try {
            const deleted = await channel.bulkDelete(recent, true);
            bulkDeleted = Number(deleted?.size || 0);
            for (const id of deleted?.keys?.() || []) bulkDeletedIds.add(String(id));
        } catch {
            // Fall through to the single-message endpoint, which supports old messages too.
        }
    }

    const remainingRecent = recent.filter(message => !bulkDeletedIds.has(String(message.id)));
    const individual = await deleteMessagesIndividually([...remainingRecent, ...historical]);
    return {
        requested: amount,
        fetched: messages.length,
        bulkDeleted,
        individualDeleted: individual.deleted,
        deleted: bulkDeleted + individual.deleted,
        failed: individual.failed
    };
}

async function handleClear(interaction) {
    if (!await requireMemberPermission(interaction, "MANAGE_MESSAGES", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ลบข้อความ`)) return;
    if (!await requireBotPermission(interaction, ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "MANAGE_MESSAGES"], `> ${config.emojis.error} บอทไม่มีสิทธิ์ดูประวัติหรือลบข้อความในช่องนี้`, interaction.channel)) return;

    const amt = interaction.options.getInteger("amount");
    if (amt < 1 || amt > 100) {
        return interaction.reply({ content: `> ${config.emojis.warning} กรุณาระบุจำนวน 1-100 เท่านั้น`, ephemeral: true });
    }

    if (activeClearChannels.has(interaction.channel.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} ห้องนี้กำลังลบข้อความอยู่ กรุณารอให้รอบเดิมเสร็จก่อน`,
            ephemeral: true
        });
    }

    activeClearChannels.add(interaction.channel.id);
    markCommandAccepted(interaction);
    try {
        if (!await safeDefer(interaction, { ephemeral: true })) return null;
        const result = await deleteChannelMessages(interaction.channel, amt);
        if (result.deleted === 0) {
            return interaction.editReply({
                content: result.fetched === 0
                    ? `> ${config.emojis.warning} ไม่พบข้อความให้ลบ`
                    : `> ${config.emojis.warning} ลบไม่สำเร็จ ${result.failed} ข้อความ`
            });
        }
        return interaction.editReply({
            content: `> ${config.emojis.success} ลบข้อความสำเร็จ **${result.deleted}** ข้อความ` +
                `\n> แบบรวดเดียว: **${result.bulkDeleted}** | ข้อความเก่า/รายข้อความ: **${result.individualDeleted}**` +
                (result.failed > 0 ? ` | ล้มเหลว: **${result.failed}**` : "")
        });
    } catch (e) {
        if (e.code === 50013) {
            return interaction.editReply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้` });
        }
        if ([10003, 50001].includes(e.code)) {
            return interaction.editReply({ content: `> ${config.emojis.error} บอทไม่สามารถเข้าถึงช่องหรือประวัติข้อความได้` });
        }
        return interaction.editReply({ content: `> ${config.emojis.error} ลบข้อความไม่สำเร็จ กรุณาลองใหม่` });
    } finally {
        activeClearChannels.delete(interaction.channel.id);
    }
}

function getRuntimeDiagnostics() {
    return {
        activeVoiceKicks: activeVoiceKicks.size,
        activeClearChannels: activeClearChannels.size
    };
}

module.exports = {
    handle,
    getRuntimeDiagnostics,
    _test: {
        isBulkDeletableMessage,
        deleteMessagesIndividually,
        deleteChannelMessages
    }
};
