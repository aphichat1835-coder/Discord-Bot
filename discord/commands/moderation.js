// NOTE: Do not remove finally blocks — they unlock race condition guards.
// NOTE: Do not simplify the permission check chain — each check serves a distinct purpose.

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
const { sendWebhookEvent, getDiscordGuildIconUrl } = require("../core/webhooks");

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
//  CLEAR
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

async function fetchMessageBatch(channel, remaining, lastMessageId) {
    const fetchLimit = Math.min(remaining, 100);
    const fetchOptions = { limit: fetchLimit };
    if (lastMessageId) {
        fetchOptions.before = lastMessageId;
    }

    const fetched = await channel.messages.fetch(fetchOptions);
    if (!fetched) return [];

    return Array.from(fetched.values ? fetched.values() : fetched);
}

function resolveNextDeletionCursor(messages, individualResult, batchBulkDeleted, recentCount) {
    if (individualResult.failed > 0 || batchBulkDeleted < recentCount) {
        return messages.at(-1)?.id || null;
    }
    return null;
}

function applyBatchDeletionStats(stats, batchResult) {
    const { batchBulkDeleted, individualResult, messagesLength } = batchResult;
    stats.totalFetched += messagesLength;
    stats.totalBulkDeleted += batchBulkDeleted;
    stats.totalIndividualDeleted += individualResult.deleted;
    stats.totalFailed += individualResult.failed;
}

async function deleteChannelMessages(channel, amount, now = Date.now(), options = {}) {
    const stats = {
        totalBulkDeleted: 0,
        totalIndividualDeleted: 0,
        totalFetched: 0,
        totalFailed: 0
    };
    let lastMessageId = null;

    while (stats.totalBulkDeleted + stats.totalIndividualDeleted + stats.totalFailed < amount) {
        const remaining = amount - (stats.totalBulkDeleted + stats.totalIndividualDeleted + stats.totalFailed);
        const messages = await fetchMessageBatch(channel, remaining, lastMessageId);
        if (messages.length === 0) break;

        const { batchBulkDeleted, individualResult, recentCount } = await executeBatchDeletion(channel, messages, now, options);
        applyBatchDeletionStats(stats, { batchBulkDeleted, individualResult, messagesLength: messages.length });

        lastMessageId = resolveNextDeletionCursor(messages, individualResult, batchBulkDeleted, recentCount);

        if (batchBulkDeleted === 0 && individualResult.deleted === 0) {
            break;
        }
    }

    return {
        requested: amount,
        fetched: stats.totalFetched,
        bulkDeleted: stats.totalBulkDeleted,
        individualDeleted: stats.totalIndividualDeleted,
        deleted: stats.totalBulkDeleted + stats.totalIndividualDeleted,
        failed: stats.totalFailed
    };
}

function buildClearLoadingEmbed(interaction, amt) {
    return new MessageEmbed()
        .setColor(config.system?.themeColors?.info || "#5865F2")
        .setDescription(`> ${config.emojis?.loading || "⏳"} กำลังลบ ${amt.toLocaleString()} ข้อความ...`);
}

function buildClearResultEmbed(interaction, result) {
    if (result.deleted === 0) {
        return new MessageEmbed()
            .setColor(config.system?.themeColors?.warning || "#FEE75C")
            .setTitle(`${config.emojis?.warning || "⚠️"} ลบข้อความไม่สำเร็จ`)
            .setDescription(
                result.fetched === 0
                    ? `> ไม่พบข้อความให้ลบในช่องนี้`
                    : `> ไม่สามารถลบข้อความในช่องนี้ได้ (${result.failed.toLocaleString()} ข้อความ)`
            );
    }

    const embed = new MessageEmbed()
        .setColor(config.system?.themeColors?.success || "#57F287")
        .setTitle(`${config.emojis?.success || "✅"} ลบข้อความเรียบร้อย`)
        .setDescription(`> ลบข้อความใน <#${interaction.channel.id}> ไป **${result.deleted.toLocaleString()}** ข้อความ`);

    if (result.failed > 0) {
        embed.addFields([
            { name: `${config.emojis?.warning || "⚠️"} ลบไม่ได้`, value: `\`${result.failed.toLocaleString()}\` ข้อความ`, inline: true }
        ]);
    }

    embed.setFooter({
        text: `ผู้สั่ง: ${interaction.user.tag}`,
        iconURL: interaction.user.displayAvatarURL?.() || undefined
    });
    embed.setTimestamp();
    return embed;
}

function buildClearErrorEmbed(e) {
    let errorMsg = "กรุณาลองใหม่อีกครั้ง";
    if (e.code === 50013) {
        errorMsg = "บอทไม่มีสิทธิ์ลบข้อความในช่องนี้";
    } else if (e.code === 10003 || e.code === 50001) {
        errorMsg = "บอทไม่สามารถเข้าถึงช่องหรือประวัติข้อความได้";
    }
    return new MessageEmbed()
        .setColor(config.system?.themeColors?.error || "#ED4245")
        .setTitle(`${config.emojis?.error || "❌"} ลบข้อความไม่สำเร็จ`)
        .setDescription(`> ${errorMsg}`);
}

async function handleClear(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.Administrator, `> ${config.emojis?.no_entry || "⛔"} คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`)) return;
    if (!await requireBotPermission(interaction, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages], `> ${config.emojis?.error || "❌"} บอทไม่มีสิทธิ์ดูประวัติหรือลบข้อความในช่องนี้`, interaction.channel)) return;

    const amt = interaction.options.getInteger("amount");
    if (amt < 1 || amt > 1000) {
        const warnEmbed = new MessageEmbed()
            .setColor(config.system?.themeColors?.warning || "#FEE75C")
            .setDescription(`> ${config.emojis?.warning || "⚠️"} กรุณาระบุจำนวน 1-1,000 เท่านั้น`);
        return interaction.reply({ embeds: [warnEmbed], ephemeral: true });
    }

    if (activeClearChannels.has(interaction.channel.id)) {
        const busyEmbed = new MessageEmbed()
            .setColor(config.system?.themeColors?.warning || "#FEE75C")
            .setDescription(`> ${config.emojis?.warning || "⚠️"} ห้องนี้กำลังลบข้อความอยู่ กรุณารอให้รอบเดิมเสร็จก่อน`);
        return interaction.reply({
            embeds: [busyEmbed],
            ephemeral: true
        });
    }

    activeClearChannels.add(interaction.channel.id);
    markCommandAccepted(interaction);
    try {
        if (!await safeDefer(interaction, { ephemeral: true })) return null;
        await interaction.editReply({ embeds: [buildClearLoadingEmbed(interaction, amt)] }).catch(() => {});
        const result = await deleteChannelMessages(interaction.channel, amt);
        if (result.deleted > 0) {
            sendWebhookEvent({
                target: "LOG",
                severity: "SUCCESS",
                category: "MODERATION",
                code: "moderation.clear",
                title: "CHANNEL MESSAGES CLEARED",
                description: `ลบข้อความในห้อง <#${interaction.channel.id}> สำเร็จ`,
                fields: [
                    { name: "ผู้ดำเนินการ", value: `${interaction.user.tag} (\`${interaction.user.id}\`)` },
                    { name: "เซิร์ฟเวอร์", value: `${interaction.guild.name} (\`${interaction.guild.id}\`)` },
                    { name: "เป้าหมาย", value: `<#${interaction.channel.id}>` },
                    { name: "การกระทำ", value: "clear messages" },
                    { name: "ผลลัพธ์", value: `ลบสำเร็จ ${result.deleted.toLocaleString()} ข้อความ (ล้มเหลว ${result.failed})` }
                ],
                sourceIconUrl: getDiscordGuildIconUrl(interaction.guild)
            }).catch(() => {});
        }
        return interaction.editReply({ embeds: [buildClearResultEmbed(interaction, result)] });
    } catch (e) {
        sendWebhookEvent({
            target: "ALERT",
            severity: "ERROR",
            category: "MODERATION",
            code: "moderation.clear_failed",
            state: "OPEN",
            title: "CLEAR MESSAGES FAILED",
            description: `ไม่สามารถลบข้อความในห้องได้: ${e.message || e}`,
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "ผลกระทบ", value: "ไม่สามารถทำความสะอาดห้องแชทตามคำสั่งได้" },
                { name: "สิ่งที่ควรทำ", value: "ตรวจสอบสิทธิ์ Manage Messages และ Read Message History" },
                { name: "เซิร์ฟเวอร์", value: `${interaction.guild?.name || "N/A"} (\`${interaction.guild?.id || "N/A"}\`)` },
                { name: "เป้าหมาย", value: `<#${interaction.channel.id}>` },
                { name: "รหัสข้อผิดพลาด", value: String(e.code || e.name || "unknown") }
            ],
            sourceIconUrl: getDiscordGuildIconUrl(interaction.guild)
        }).catch(() => {});
        return interaction.editReply({ embeds: [buildClearErrorEmbed(e)] });
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
