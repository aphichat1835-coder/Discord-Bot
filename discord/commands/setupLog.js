/*
 * Dedicated /setup-log handler for Advanced Audit + Protection logging.
 * Keeps the large utility.js stable while adding the new moderation log channel.
 */

const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const auditLogger = require("../auditLogger");
const { requireMemberPermission, requireBotPermission, safeDefer } = require("../guards/commandGuards");
const { LOG_CHANNEL_TYPES, safeAuditText } = require("../logging/logCore");

const LOG_CATEGORIES = Object.freeze([
    LOG_CHANNEL_TYPES.MESSAGE,
    LOG_CHANNEL_TYPES.MEMBER,
    LOG_CHANNEL_TYPES.VOICE,
    LOG_CHANNEL_TYPES.SERVER,
    LOG_CHANNEL_TYPES.SECURITY,
    LOG_CHANNEL_TYPES.MODERATION
]);

function getConfiguredChannelName(category) {
    return config.audit_channels?.[category] || `log-${category}`;
}

function isTextChannel(channel) {
    return !!channel && (typeof channel.isText === "function" ? channel.isText() : channel.type === "GUILD_TEXT" || channel.type === "text");
}

function findExistingLogChannel(guild, category, mappedId = null) {
    if (mappedId) {
        const mapped = guild.channels.cache.get(mappedId);
        if (isTextChannel(mapped)) return mapped;
    }

    const configuredName = getConfiguredChannelName(category);
    return guild.channels.cache.find(channel => isTextChannel(channel) && channel.name === configuredName) || null;
}

function buildPermissionOverwrites(guild) {
    const overwrites = [
        { id: guild.id, deny: ["VIEW_CHANNEL"] },
        { id: guild.members.me.id, allow: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "EMBED_LINKS"] }
    ];

    if (guild.roles.cache.has(config.roles.fallbackAdminId)) {
        overwrites.push({
            id: config.roles.fallbackAdminId,
            allow: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "EMBED_LINKS"]
        });
    }

    return overwrites;
}

async function getOrCreateAuditCategory(guild) {
    let auditCategory = guild.channels.cache.find(
        channel => channel.type === "GUILD_CATEGORY" && channel.name === config.audit_channels.categoryName
    );

    if (auditCategory) return { channel: auditCategory, created: false };

    auditCategory = await guild.channels.create(config.audit_channels.categoryName, {
        type: "GUILD_CATEGORY",
        permissionOverwrites: buildPermissionOverwrites(guild),
        reason: "Advanced Audit /setup-log"
    });

    return { channel: auditCategory, created: true };
}

async function saveLogChannel(sessionManager, guildId, category, channelId) {
    if (category === LOG_CHANNEL_TYPES.MODERATION) {
        // Compatibility: sessionManager schema may not have moderationChannelId yet.
        await sessionManager.setSetting(`logChannelMapExtra_${guildId}`, {
            moderationChannelId: channelId,
            updatedAt: Date.now()
        }).catch(() => {});
    }

    const saved = await sessionManager.setLogChannelMap(guildId, category, channelId).catch(() => false);
    if (!saved && category !== LOG_CHANNEL_TYPES.MODERATION) return false;
    return true;
}

async function createOrResolveLogChannel(interaction, sessionManager, category, auditCategory) {
    const existingMap = await sessionManager.getLogChannelMap(interaction.guild.id).catch(() => null);
    const extraMap = await sessionManager.getSetting?.(`logChannelMapExtra_${interaction.guild.id}`, null).catch(() => null);
    const mappedId = existingMap?.[`${category}ChannelId`] || extraMap?.[`${category}ChannelId`] || null;
    const existing = findExistingLogChannel(interaction.guild, category, mappedId);

    if (existing) {
        await saveLogChannel(sessionManager, interaction.guild.id, category, existing.id);
        return { channel: existing, created: false };
    }

    const channelName = getConfiguredChannelName(category);
    const createOptions = {
        type: "GUILD_TEXT",
        topic: `Advanced Audit Log — ${category}`,
        permissionOverwrites: buildPermissionOverwrites(interaction.guild),
        reason: "Advanced Audit /setup-log"
    };
    if (auditCategory) createOptions.parent = auditCategory.id;

    const channel = await interaction.guild.channels.create(channelName, createOptions);
    await saveLogChannel(sessionManager, interaction.guild.id, category, channel.id);
    return { channel, created: true };
}

function buildSetupSummaryEmbed(guild, results) {
    const lines = results.map(result => {
        if (result.ok) {
            const status = result.created ? "สร้างใหม่" : "มีอยู่แล้ว";
            return `${config.emojis.success} **${result.category}** — ${status} <#${result.channelId}>`;
        }
        return `${config.emojis.error} **${result.category}** — ล้มเหลว: ${safeAuditText(result.error, 180)}`;
    });

    return new MessageEmbed()
        .setColor(config.system.themeColors.success)
        .setTitle(`${config.emojis.settings_icon} Advanced Audit Log ติดตั้งเรียบร้อย`)
        .setDescription(lines.join("\n"))
        .addField("ระบบที่พร้อมใช้งาน", "Message / Member / Voice / Server / Security / Moderation", false)
        .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

async function handle(interaction, client, sessionManager) {
    if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ต้องเป็น Administrator`)) return;
    if (!await requireBotPermission(
        interaction,
        ["MANAGE_CHANNELS", "VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS", "READ_MESSAGE_HISTORY"],
        `> ${config.emojis.error} บอทต้องมีสิทธิ์ Manage Channels / Send Messages / Embed Links`
    )) return;

    await safeDefer(interaction, { ephemeral: true });
    await interaction.editReply({ content: `${config.emojis.loading} **กำลังติดตั้ง Advanced Audit Log channels...**` });

    const results = [];
    let auditCategory = null;

    try {
        const categoryResult = await getOrCreateAuditCategory(interaction.guild);
        auditCategory = categoryResult.channel;
        results.push({
            ok: true,
            category: "category",
            channelId: auditCategory.id,
            created: categoryResult.created
        });
    } catch (err) {
        results.push({ ok: false, category: "category", error: err.message });
    }

    for (const category of LOG_CATEGORIES) {
        try {
            const result = await createOrResolveLogChannel(interaction, sessionManager, category, auditCategory);
            results.push({
                ok: true,
                category,
                channelId: result.channel.id,
                created: result.created
            });

            await interaction.editReply({
                content: `${config.emojis.loading} **กำลังติดตั้ง...**\n` + results.map(item =>
                    item.ok
                        ? `${config.emojis.success} ${item.category} → <#${item.channelId}>`
                        : `${config.emojis.error} ${item.category} — ${safeAuditText(item.error, 120)}`
                ).join("\n")
            });

            await new Promise(resolve => setTimeout(resolve, 900));
        } catch (err) {
            results.push({ ok: false, category, error: err.message });
        }
    }

    auditLogger.invalidateAuditCache?.(interaction.guild.id);
    return interaction.editReply({ embeds: [buildSetupSummaryEmbed(interaction.guild, results)], content: null });
}

module.exports = {
    handle,
    LOG_CATEGORIES,
    _test: {
        getConfiguredChannelName,
        isTextChannel,
        buildPermissionOverwrites,
        findExistingLogChannel
    }
};
