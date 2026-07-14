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
async function disconnectVoiceMembers(memberSnapshot, options = {}) {
    const startedAt = options.startedAt || Date.now();
    const maxDurationMs = options.maxDurationMs || 14 * 60 * 1000;
    const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const yieldTurn = options.yieldTurn || (() => new Promise(resolve => setImmediate(resolve)));
    const kicked = [];
    let failed = 0;
    let timedOut = false;

    for (const member of memberSnapshot) {
        await yieldTurn();
        if (Date.now() - startedAt > maxDurationMs) {
            timedOut = true;
            break;
        }
        if (member.permissions.has("ADMINISTRATOR")) continue;
        try {
            await member.voice.disconnect();
            kicked.push(`<@${member.id}>`);
            await pause(500);
        } catch {
            failed++;
        }
    }
    return { kicked, failed, timedOut };
}

function voiceKickResultState(result, eligibleCount) {
    if (result.kicked.length === 0) return "failed";
    return result.failed === 0 && !result.timedOut && result.kicked.length === eligibleCount
        ? "complete"
        : "partial";
}

function voiceKickResultColor(resultState) {
    if (resultState === "complete") return config.system.themeColors.success;
    if (resultState === "partial") return config.system.themeColors.warning;
    return config.system.themeColors.error;
}

function kickedMemberSummary(kicked) {
    if (kicked.length === 0) return "- ไม่มีใครถูกเตะ -";
    if (kicked.length <= 50) return kicked.join(", ");
    return `${kicked.slice(0, 50).join(", ")}\n... และอีก ${kicked.length - 50} คน`;
}

function buildVoiceKickResultEmbed(result, eligibleCount) {
    const resultState = voiceKickResultState(result, eligibleCount);
    const timeoutMessage = result.timedOut
        ? `\n> ${config.emojis.warning} **หยุดอัตโนมัติ:** เกิน 14 นาที`
        : "";
    return new MessageEmbed()
        .setColor(voiceKickResultColor(resultState))
        .setDescription(
            `> **ผลการจัดการ: ${resultState}** ${config.emojis.broom}\n> เป้าหมายทั้งหมด: ${eligibleCount} คน\n\n` +
            `— **เตะสำเร็จ ${result.kicked.length} คน:**\n${kickedMemberSummary(result.kicked)}\n` +
            `— **ล้มเหลว:** ${result.failed} คน${timeoutMessage}`
        );
}

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
        const memberSnapshot = Array.from(vc.members.values());
        const eligibleCount = memberSnapshot.filter(member => !member.permissions.has("ADMINISTRATOR")).length;
        const result = await disconnectVoiceMembers(memberSnapshot);
        const embed = buildVoiceKickResultEmbed(result, eligibleCount);
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
        deleteChannelMessages,
        disconnectVoiceMembers,
        voiceKickResultState,
        kickedMemberSummary,
        buildVoiceKickResultEmbed
    }
};
