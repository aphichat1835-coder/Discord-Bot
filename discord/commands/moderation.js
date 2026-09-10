/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores and activeBackups Sets.
DO NOT REMOVE: finally blocks — they unlock race condition guards.
DO NOT SIMPLIFY: Permission check chain — each check serves a specific purpose.
================================================================================
*/

const { PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const {
    requireMemberPermission,
    requireBotPermission,
    safeDefer,
    markCommandAccepted
} = require("../guards/commandGuards");
const { handleModerationCommand } = require("./moderationWorkflow");

const { MessageEmbed } = require("../core/discordCompat");

// Race Condition Guards
const activeClearChannels = new Set();
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BULK_DELETE_SAFETY_MS = 60 * 1000;
const PARALLEL_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handle(interaction, client) {
    const cmd = interaction.commandName;

    if (cmd === "clear")        return handleClear(interaction);
    if (["ban", "kick", "timeout"].includes(cmd)) return handleModerationCommand(interaction, client);
}

// ════════════════════════════════════════════════════════════════════════════
//  🧹  CLEAR
// ════════════════════════════════════════════════════════════════════════════
function isBulkDeletableMessage(message, now = Date.now()) {
    const createdAt = Number(message?.createdTimestamp || 0);
    return createdAt > 0 && now - createdAt < BULK_DELETE_MAX_AGE_MS - BULK_DELETE_SAFETY_MS;
}

async function deleteMessagesIndividually(messages, options = {}) {
    const batchSize = Math.max(1, Number(options.batchSize) || PARALLEL_BATCH_SIZE);
    const defaultDelay = process.env.NODE_ENV === "test" ? 0 : BATCH_DELAY_MS;
    const delayMs = typeof options.delayMs === "number" ? options.delayMs : defaultDelay;

    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < messages.length; i += batchSize) {
        const chunk = messages.slice(i, i + batchSize);
        const results = await Promise.allSettled(chunk.map(msg => msg.delete()));
        for (const res of results) {
            if (res.status === "fulfilled") {
                deleted++;
            } else {
                failed++;
            }
        }
        if (i + batchSize < messages.length && delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return { deleted, failed };
}

async function executeBatchDeletion(channel, messages, now, options) {
    const recent = messages.filter(message => isBulkDeletableMessage(message, now));
    const historical = messages.filter(message => !isBulkDeletableMessage(message, now));
    const bulkDeletedIds = new Set();
    let batchBulkDeleted = 0;

    if (recent.length >= 2) {
        try {
            const deleted = await channel.bulkDelete(recent, true);
            batchBulkDeleted = Number(deleted?.size || 0);
            for (const id of deleted?.keys?.() || []) bulkDeletedIds.add(String(id));
        } catch {
            // Fall through to parallel deletion
        }
    }

    const remainingRecent = recent.filter(message => !bulkDeletedIds.has(String(message.id)));
    const toDeleteIndividually = [...remainingRecent, ...historical];
    const individualResult = toDeleteIndividually.length > 0
        ? await deleteMessagesIndividually(toDeleteIndividually, options)
        : { deleted: 0, failed: 0 };

    return {
        batchBulkDeleted,
        individualResult,
        recentCount: recent.length
    };
}

async function deleteChannelMessages(channel, amount, now = Date.now(), options = {}) {
    let totalBulkDeleted = 0;
    let totalIndividualDeleted = 0;
    let totalFetched = 0;
    let totalFailed = 0;
    let lastMessageId = null;

    while (totalBulkDeleted + totalIndividualDeleted + totalFailed < amount) {
        const remaining = amount - (totalBulkDeleted + totalIndividualDeleted + totalFailed);
        const fetchLimit = Math.min(remaining, 100);
        const fetchOptions = { limit: fetchLimit };
        if (lastMessageId) {
            fetchOptions.before = lastMessageId;
        }

        const fetched = await channel.messages.fetch(fetchOptions);
        if (!fetched || (fetched.size ?? fetched.length ?? 0) === 0) {
            break;
        }

        const messages = Array.from(fetched.values ? fetched.values() : fetched);
        if (messages.length === 0) break;

        totalFetched += messages.length;
        const { batchBulkDeleted, individualResult, recentCount } = await executeBatchDeletion(channel, messages, now, options);

        totalBulkDeleted += batchBulkDeleted;
        totalIndividualDeleted += individualResult.deleted;
        totalFailed += individualResult.failed;

        if (individualResult.failed > 0 || batchBulkDeleted < recentCount) {
            lastMessageId = messages.at(-1)?.id || null;
        } else {
            lastMessageId = null;
        }

        if (batchBulkDeleted === 0 && individualResult.deleted === 0) {
            break;
        }
    }

    return {
        requested: amount,
        fetched: totalFetched,
        bulkDeleted: totalBulkDeleted,
        individualDeleted: totalIndividualDeleted,
        deleted: totalBulkDeleted + totalIndividualDeleted,
        failed: totalFailed
    };
}

async function handleClear(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.Administrator, `> ⛔ คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`)) return;
    if (!await requireBotPermission(interaction, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages], `> ${config.emojis.error} บอทไม่มีสิทธิ์ดูประวัติหรือลบข้อความในช่องนี้`, interaction.channel)) return;

    const amt = interaction.options.getInteger("amount");
    if (amt < 1 || amt > 1000) {
        const warnEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.warning || "#FEE75C")
            .setDescription(`> ${config.emojis.warning} กรุณาระบุจำนวน 1-1,000 เท่านั้น`);
        return interaction.reply({ embeds: [warnEmbed], ephemeral: true });
    }

    if (activeClearChannels.has(interaction.channel.id)) {
        const busyEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.warning || "#FEE75C")
            .setDescription(`> ${config.emojis.warning} ห้องนี้กำลังลบข้อความอยู่ กรุณารอให้รอบเดิมเสร็จก่อน`);
        return interaction.reply({
            embeds: [busyEmbed],
            ephemeral: true
        });
    }

    activeClearChannels.add(interaction.channel.id);
    markCommandAccepted(interaction);
    try {
        if (!await safeDefer(interaction, { ephemeral: true })) return null;

        const loadingEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.info || "#5865F2")
            .setAuthor({
                name: "กำลังทำความสะอาดห้องแชท...",
                iconURL: interaction.guild?.iconURL() || undefined
            })
            .setDescription(
                `> ${config.emojis.broom || "🧹"} กำลังสแกนและลบข้อความเป้าหมาย **${amt.toLocaleString()}** ข้อความ...\n` +
                `> ${config.emojis.loading || "⏳"} กรุณารอสักครู่ ระบบกำลังเร่งดำเนินการด้วยความเร็วสูงสุด ⚡`
            )
            .setFooter({
                text: `ผู้สั่งการ: ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL?.() || undefined
            });
        await interaction.editReply({ embeds: [loadingEmbed] }).catch(() => {});

        const result = await deleteChannelMessages(interaction.channel, amt);
        if (result.deleted === 0) {
            const emptyEmbed = new MessageEmbed()
                .setColor(config.system.themeColors.warning || "#FEE75C")
                .setAuthor({
                    name: "ผลการทำความสะอาดห้องแชท",
                    iconURL: interaction.guild?.iconURL() || undefined
                })
                .setDescription(
                    result.fetched === 0
                        ? `> ${config.emojis.warning} ไม่พบข้อความให้ลบในช่องนี้`
                        : `> ${config.emojis.warning} ลบไม่สำเร็จ **${result.failed}** ข้อความ`
                );
            return interaction.editReply({ embeds: [emptyEmbed] });
        }

        const successEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success || "#57F287")
            .setAuthor({
                name: "กวาดล้างห้องแชทเรียบร้อย",
                iconURL: interaction.guild?.iconURL() || undefined
            })
            .setDescription(
                `> ${config.emojis.success} **ลบข้อความสำเร็จทั้งหมด \`${result.deleted.toLocaleString()}\` ข้อความ!**`
            )
            .addFields([
                { name: "⚡ ลบความเร็วสูง (Bulk)", value: `\`${result.bulkDeleted.toLocaleString()}\` ข้อความ`, inline: true },
                { name: "⏳ ลบรายข้อความ/เก่า", value: `\`${result.individualDeleted.toLocaleString()}\` ข้อความ`, inline: true },
                { name: "📌 ช่องแชท", value: `<#${interaction.channel.id}>`, inline: true }
            ]);

        if (result.failed > 0) {
            successEmbed.addFields([
                { name: "⚠️ ล้มเหลว", value: `\`${result.failed.toLocaleString()}\` ข้อความ`, inline: true }
            ]);
        }

        successEmbed.setFooter({
            text: `ผู้ดำเนินการ: ${interaction.user.tag}`,
            iconURL: interaction.user.displayAvatarURL?.() || undefined
        });
        successEmbed.setTimestamp();
        return interaction.editReply({ embeds: [successEmbed] });
    } catch (e) {
        let errorMsg = `> ${config.emojis.error} ลบข้อความไม่สำเร็จ กรุณาลองใหม่`;
        if (e.code === 50013) {
            errorMsg = `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้`;
        } else if ([10003, 50001].includes(e.code)) {
            errorMsg = `> ${config.emojis.error} บอทไม่สามารถเข้าถึงช่องหรือประวัติข้อความได้`;
        }
        const errorEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.error || "#ED4245")
            .setDescription(errorMsg);
        return interaction.editReply({ embeds: [errorEmbed] });
    } finally {
        activeClearChannels.delete(interaction.channel.id);
    }
}

function getRuntimeDiagnostics() {
    return {
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
