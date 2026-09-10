/* eslint-disable complexity -- Utility command flows are behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups Sets — race condition guards.
DO NOT REMOVE: finally blocks — they MUST unlock Sets after every operation.
DO NOT SIMPLIFY: Restore loop — delay + setImmediate required (เฟส 19+21).
================================================================================
*/

const {
    MessageEmbed,
    MessageActionRow,
    MessageButton,
    getLegacyChannelType,
    resolveChannelType
} = require("../core/discordCompat");
const { PermissionFlagsBits } = require("discord.js");
const crypto = require("node:crypto");
const config = require("../config.json");
const { isConfiguredOwner } = require("../core/env");
const sessionManager = require("../sessionManager");
const {
    requireMemberPermission,
    requireBotPermission,
    safeDefer,
    sanitizeUserMessage,
    markCommandAccepted
} = require("../guards/commandGuards");
const dmService = require("../dm");
const { safeError } = require("../core/safeLogger");
const {
    sendWebhookEvent,
    getDiscordAvatarUrl,
    getDiscordGuildIconUrl
} = require("../core/webhooks");

// Race Condition Guards
const activeRestores = new Set();
const activeBackups  = new Set();
const activeEmojiCopies = new Set();

function restoreStateLabel(state) {
    if (state === "complete") return "สำเร็จครบถ้วน";
    if (state === "partial") return "สำเร็จบางส่วน";
    return "ไม่สำเร็จ";
}

function restoreTone(state) {
    if (state === "complete") return "success";
    if (state === "partial") return "warning";
    return "danger";
}

function buildRestoreResultDmEmbed(input) {
    const stateLabel = restoreStateLabel(input.resultState);
    const tone = restoreTone(input.resultState);
    return dmService.design.buildDmEmbed({
        tone,
        title: input.resultState === "complete" ? "✅ กู้คืนเซิร์ฟเวอร์เสร็จแล้ว" : "⚠️ ผลการกู้คืนต้องตรวจสอบ",
        summary: `งานกู้คืนสิ้นสุดด้วยสถานะ “${stateLabel}” รายละเอียดนี้ส่งเฉพาะผู้สั่งงาน`,
        profile: dmService.design.profileFromUser(input.interaction.user),
        fields: [
            { name: "🏠 เซิร์ฟเวอร์", value: `${dmService.design.markdownText(input.interaction.guild.name, "ไม่ทราบเซิร์ฟเวอร์", 100)}\n${dmService.design.code(input.interaction.guild.id)}`, inline: true },
            { name: "🎖️ ยศที่สร้าง", value: `${input.restoredRoles} ยศ`, inline: true },
            { name: "🗂️ ห้องที่สร้าง", value: `${input.restoredChannels} ห้อง`, inline: true },
            { name: "⏭️ รายการที่ข้าม", value: `${input.skippedRoles} ยศ / ${input.skippedChannels} ห้อง`, inline: true },
            { name: "❓ ชื่อซ้ำหรือไม่แน่ชัด", value: `${input.ambiguousRoles} ยศ / ${input.ambiguousChannels} ห้อง`, inline: true },
            { name: "🔐 สิทธิ์ห้อง", value: `${input.overwriteStats.restored} สำเร็จ / ${input.overwriteStats.skippedRoleMissing + input.overwriteStats.skippedMemberMissing} หาย / ${Number(input.overwriteStats.skippedMemberUnresolved || 0)} ตรวจไม่ได้`, inline: true },
            { name: "⚠️ ข้อผิดพลาด", value: String(input.restoreErrors), inline: true },
            { name: "⏱️ หมดเวลาระหว่างทำงาน", value: input.timeoutHit ? "ใช่" : "ไม่", inline: true }
        ],
        nextAction: input.resultState === "complete"
            ? "ตรวจสอบยศ ห้อง และสิทธิ์สำคัญใน Discord อีกครั้งก่อนเปิดใช้งานเต็มรูปแบบ"
            : "ตรวจสอบรายการที่ข้ามและข้อผิดพลาด แล้วกู้คืนเฉพาะส่วนที่ยังขาด",
        referenceId: input.interaction.id || `restore-${input.interaction.guild.id}`,
        footer: "Phomueangtai • กู้คืนเซิร์ฟเวอร์"
    });
}

function buildRestoreDeliveryFailureEvent(interaction) {
    const guildId = String(interaction.guild?.id || "unknown");
    const userId = String(interaction.user?.id || "unknown");
    return {
        target: "LOG",
        severity: "WARNING",
        category: "BACKUP",
        code: "restore.result.private_delivery_failed",
        title: "ส่งผลการกู้คืนแบบส่วนตัวไม่สำเร็จ",
        description: "ระบบแสดงผลใน Interaction และส่งข้อความส่วนตัวไม่ได้",
        impact: "ผู้สั่งงานอาจไม่เห็นรายละเอียดผลลัพธ์หลัง Interaction หมดอายุ",
        action: "ตรวจสอบสิทธิ์รับข้อความส่วนตัวและสถานะการส่ง DM ของผู้สั่งงาน",
        context: {
            "Guild ID": guildId,
            "User ID": userId,
            "Interaction ID": String(interaction.id || "unknown")
        },
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
        thumbnailUrl: getDiscordAvatarUrl(interaction.user),
        dedupeKey: `restore-private-delivery:${guildId}:${userId}`,
        dedupeMs: 5 * 60 * 1000,
        summaryLabel: "ส่งผลการกู้คืนแบบส่วนตัวไม่สำเร็จ"
    };
}

async function handle(interaction) {
    const cmd = interaction.commandName;
    if (cmd === "say")        return handleSay(interaction);
    if (cmd === "announce")   return handleAnnounce(interaction);
    if (cmd === "copy-emojis") return handleSteal(interaction);
    if (cmd === "backup")     return handleBackup(interaction);
    if (cmd === "restore")    return handleRestore(interaction);
}

// ════════════════════════════════════════════════════════════════════════════
//  📢  SAY (Administrator only)
// ════════════════════════════════════════════════════════════════════════════
async function handleSay(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.Administrator, `> ${config.emojis.no_entry} ต้องเป็น Administrator เพื่อใช้คำสั่งนี้`)) return;
    if (!await requireBotPermission(interaction, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel], `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่องนี้ (ขาด SEND_MESSAGES หรือ VIEW_CHANNEL)`, interaction.channel)) return;

    const rawMsg = interaction.options.getString("message");
    const msg = sanitizeUserMessage(rawMsg, { maxLength: 2000 });
    if (!msg) return interaction.reply({
        content: `> ${config.emojis.error} ข้อความว่างหรือถูกบล็อกทั้งหมด`,
        ephemeral: true
    });

    markCommandAccepted(interaction);

    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    await interaction.channel.send({
        content: msg,
        allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
    });
    return interaction.editReply({ content: `> ${config.emojis.success} ส่งเรียบร้อย` });
}

// ════════════════════════════════════════════════════════════════════════════
//  📣  ANNOUNCE (Custom Embed & Target Channel Renovation)
// ════════════════════════════════════════════════════════════════════════════
function isValidHttpUrl(str) {
    if (!str || typeof str !== "string") return false;
    try {
        const u = new URL(str);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function resolveEmbedColor(colorHex, fallback) {
    if (!colorHex || typeof colorHex !== "string") return fallback;
    const cleaned = colorHex.trim().replace(/^#/, "");
    return /^[0-9A-Fa-f]{6}$/.test(cleaned) ? `#${cleaned}` : fallback;
}

function applyEmbedAuthor(embed, name, iconUrl) {
    if (!name) return;
    embed.setAuthor({
        name,
        iconURL: (iconUrl && isValidHttpUrl(iconUrl)) ? iconUrl.trim() : undefined
    });
}

function applyEmbedFooter(embed, text, iconUrl) {
    if (!text) return;
    embed.setFooter({
        text,
        iconURL: (iconUrl && isValidHttpUrl(iconUrl)) ? iconUrl.trim() : undefined
    });
}

function buildAnnouncementEmbed(options) {
    const embed = new MessageEmbed()
        .setColor(resolveEmbedColor(options.colorHex, config.system.themeColors.primary || "#5865F2"))
        .setDescription(options.messageText);

    if (options.title) {
        embed.setTitle(options.title);
    }
    if (options.url && isValidHttpUrl(options.url)) {
        embed.setURL(options.url.trim());
    }
    applyEmbedAuthor(embed, options.authorName, options.authorIcon);
    if (options.thumbnailUrl && isValidHttpUrl(options.thumbnailUrl)) {
        embed.setThumbnail(options.thumbnailUrl.trim());
    }
    if (options.imageUrl && isValidHttpUrl(options.imageUrl)) {
        embed.setImage(options.imageUrl.trim());
    }
    applyEmbedFooter(embed, options.footerText, options.footerIcon);
    if (options.timestamp === true) {
        embed.setTimestamp();
    }
    return embed;
}

function buildAnnouncementComponents(buttonText, buttonUrl) {
    if (!buttonText || !buttonUrl || !isValidHttpUrl(buttonUrl)) {
        return [];
    }
    const button = new MessageButton()
        .setLabel(buttonText.slice(0, 80))
        .setStyle("LINK")
        .setURL(buttonUrl.trim());
    return [new MessageActionRow().addComponents(button)];
}

async function handleAnnounce(interaction) {
    if (!await requireMemberPermission(
        interaction,
        PermissionFlagsBits.Administrator,
        `> ⛔ คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`
    )) return;

    const targetChannel = interaction.options.getChannel("channel") || interaction.channel;
    if (!targetChannel || typeof targetChannel.send !== "function") {
        return interaction.reply({
            content: `> ${config.emojis.error} ช่องเป้าหมายต้องเป็นห้องข้อความที่ส่งข้อความได้`,
            ephemeral: true
        });
    }

    if (!await requireBotPermission(
        interaction,
        [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks],
        `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่อง <#${targetChannel.id}> (ต้องการสิทธิ์ ส่งข้อความ, ดูช่อง, และ แนบลิงก์)`,
        targetChannel
    )) return;

    const rawMessage = interaction.options.getString("message");
    if (!rawMessage?.trim()) {
        return interaction.reply({ content: `> ${config.emojis.error} ข้อความประกาศต้องไม่ว่าง`, ephemeral: true });
    }

    const messageText = sanitizeUserMessage(rawMessage.replaceAll(String.raw`\n`, "\n"), { maxLength: 4096 });
    const rawTitle = interaction.options.getString("title");
    const rawContent = interaction.options.getString("content");
    const authorName = interaction.options.getString("author_name");
    const footerText = interaction.options.getString("footer");

    markCommandAccepted(interaction);

    const embed = buildAnnouncementEmbed({
        messageText,
        title: rawTitle ? sanitizeUserMessage(rawTitle, { maxLength: 256 }) : null,
        colorHex: interaction.options.getString("color"),
        imageUrl: interaction.options.getString("image"),
        thumbnailUrl: interaction.options.getString("thumbnail"),
        footerText: footerText ? sanitizeUserMessage(footerText, { maxLength: 2048 }) : null,
        footerIcon: interaction.options.getString("footer_icon"),
        authorName: authorName ? sanitizeUserMessage(authorName, { maxLength: 256 }) : null,
        authorIcon: interaction.options.getString("author_icon"),
        url: interaction.options.getString("url"),
        timestamp: interaction.options.getBoolean("timestamp")
    });

    const components = buildAnnouncementComponents(
        interaction.options.getString("button_text"),
        interaction.options.getString("button_url")
    );

    const content = rawContent ? sanitizeUserMessage(rawContent, { maxLength: 2000 }) : null;

    if (!await safeDefer(interaction, { ephemeral: true })) return null;

    try {
        const sentMsg = await targetChannel.send({
            content: content || undefined,
            embeds: [embed],
            components: components.length > 0 ? components : undefined,
            allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
        });

        const successText = targetChannel.id === interaction.channel.id
            ? `> ${config.emojis.success} ส่งประกาศเรียบร้อยแล้ว`
            : `> ${config.emojis.success} ส่งประกาศไปยังห้อง <#${targetChannel.id}> เรียบร้อยแล้ว`;

        return interaction.editReply({
            content: sentMsg?.url ? `${successText} • [เปิดดูข้อความ](${sentMsg.url})` : successText
        });
    } catch (err) {
        return interaction.editReply({
            content: `> ${config.emojis.error} ส่งประกาศไม่สำเร็จ: ${err?.message || "เกิดข้อผิดพลาด"}`
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  😀  COPY-EMOJIS (STEAL RENOVATION — 3-Stage Lifecycle + Smart Quota + Showcase)
// ════════════════════════════════════════════════════════════════════════════

function parseCustomEmojis(text) {
    if (!text || typeof text !== "string") return [];
    const regex = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;
    const seenEmojiIds = new Set();
    const results = [];
    for (const match of text.matchAll(regex)) {
        const isAnimated = match[1] === "a";
        let name = match[2];
        const id = match[3];
        if (seenEmojiIds.has(id)) continue;
        seenEmojiIds.add(id);

        if (name.length < 2) {
            name = name.padEnd(2, "_");
        } else if (name.length > 32) {
            name = name.slice(0, 32);
        }

        results.push({
            isAnimated,
            name,
            id,
            raw: match[0],
            url: `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? "gif" : "png"}`
        });
    }
    return results;
}

function calculateEmojiQuotas(guild) {
    const emojiManager = guild?.emojis;
    const tier = guild?.premiumTier || 0;
    const maxPerType = tier === 3 ? 250 : tier === 2 ? 150 : tier === 1 ? 100 : 50;
    const staticCount = emojiManager?.cache?.filter?.(e => !e.animated)?.size || 0;
    const animatedCount = emojiManager?.cache?.filter?.(e => e.animated)?.size || 0;
    const staticFree = Math.max(0, maxPerType - staticCount);
    const animatedFree = Math.max(0, maxPerType - animatedCount);

    return {
        tier,
        maxPerType,
        staticCount,
        animatedCount,
        staticFree,
        animatedFree
    };
}

function checkSmartEmojiQuota(quotas, parsedEmojis) {
    const reqStatic = parsedEmojis.filter(e => !e.isAnimated).length;
    const reqAnimated = parsedEmojis.filter(e => e.isAnimated).length;

    if (quotas.staticFree === 0 && quotas.animatedFree === 0) {
        return {
            allowed: false,
            reason: "ALL_FULL",
            title: "โควตาอิโมจิของเซิร์ฟเวอร์เต็มทั้งหมดแล้ว",
            description:
                `> ${config.emojis.error} **เซิร์ฟเวอร์นี้มีอิโมจิเต็มโควตาทั้งหมดแล้ว!**\n` +
                `> 🖼️ อิโมจิทั่วไป: **${quotas.staticCount}/${quotas.maxPerType}** | ✨ อิโมจิเคลื่อนไหว: **${quotas.animatedCount}/${quotas.maxPerType}**\n\n` +
                `💡 *กรุณาลบอิโมจิที่ไม่ใช้งาน หรือบูสต์เซิร์ฟเวอร์เพื่อเพิ่มขีดจำกัดโควตา*`
        };
    }

    if (reqStatic > 0 && reqAnimated === 0 && quotas.staticFree === 0) {
        return {
            allowed: false,
            reason: "STATIC_FULL",
            title: "ช่องเก็บอิโมจิทั่วไป (Static) เต็มแล้ว",
            description:
                `> ${config.emojis.error} **ช่องอิโมจิทั่วไปเต็มแล้ว (${quotas.staticCount}/${quotas.maxPerType})** ไม่สามารถนำเข้าได้\n` +
                `> คุณระบุอิโมจิทั่วไปมา **${reqStatic}** ตัว แต่ไม่มีช่องว่างเหลือเลย\n\n` +
                `💡 *มีช่องอิโมจิเคลื่อนไหวว่างเหลืออยู่ **${quotas.animatedFree}** ช่อง คุณสามารถนำเข้าอิโมจิแบบขยับได้แทน*`
        };
    }

    if (reqAnimated > 0 && reqStatic === 0 && quotas.animatedFree === 0) {
        return {
            allowed: false,
            reason: "ANIMATED_FULL",
            title: "ช่องเก็บอิโมจิเคลื่อนไหว (Animated) เต็มแล้ว",
            description:
                `> ${config.emojis.error} **ช่องอิโมจิเคลื่อนไหวเต็มแล้ว (${quotas.animatedCount}/${quotas.maxPerType})** ไม่สามารถนำเข้าได้\n` +
                `> คุณระบุอิโมจิเคลื่อนไหวมา **${reqAnimated}** ตัว แต่ไม่มีช่องว่างเหลือเลย\n\n` +
                `💡 *มีช่องอิโมจิทั่วไปว่างเหลืออยู่ **${quotas.staticFree}** ช่อง คุณสามารถนำเข้าอิโมจิแบบภาพนิ่งแทน*`
        };
    }

    return {
        allowed: true,
        reqStatic,
        reqAnimated,
        willSkipStatic: Math.max(0, reqStatic - quotas.staticFree),
        willSkipAnimated: Math.max(0, reqAnimated - quotas.animatedFree)
    };
}

function renderEmojiProgressBar(current, total, barLength = 10) {
    const validTotal = Math.max(1, total || 1);
    const ratio = Math.min(1, Math.max(0, current / validTotal));
    const filled = Math.min(barLength, Math.round(ratio * barLength));
    const empty = barLength - filled;
    const bar = "▰".repeat(filled) + "▱".repeat(empty);
    const percent = Math.round(ratio * 100);
    return `${bar} \`${percent}%\``;
}

function buildEmojiNoticeEmbed({ title, description, color = config.system.themeColors.error, guild, user }) {
    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(title)
        .setDescription(description);

    const guildIcon = guild?.iconURL?.({ dynamic: true });
    if (guildIcon) {
        embed.setThumbnail(guildIcon);
    }
    if (user?.tag) {
        embed.setFooter({
            text: `ผู้สั่งการ: ${user.tag}`,
            iconURL: user.displayAvatarURL?.({ dynamic: true }) || undefined
        });
    }
    return embed;
}

function buildEmojiProgressEmbed({ current, total, added, skipped, failed, currentEmojiName, isAnimated, guild, user }) {
    const bar = renderEmojiProgressBar(current, total, 10);
    return new MessageEmbed()
        .setColor(config.system.themeColors.warning || "#FEE75C")
        .setAuthor({
            name: "ระบบนำเข้าอิโมจิกำลังทำงาน...",
            iconURL: guild?.iconURL?.({ dynamic: true }) || undefined
        })
        .setTitle(`${config.emojis.loading || "⏳"} กำลังดึงและสร้างอิโมจิ (${current}/${total})`)
        .setDescription(
            `> ${bar}\n\n` +
            `> ⏳ **กำลังนำเข้า:** \`:${currentEmojiName || "emoji"}:\` (${isAnimated ? "เคลื่อนไหว ✨" : "ทั่วไป 🖼️"})\n` +
            `> ⚡ **สถานะปัจจุบัน:** ${config.emojis.success || "✅"} สำเร็จ \`${added}\` | ${config.emojis.warning || "⚠️"} ข้าม \`${skipped}\` | ${config.emojis.error || "❌"} พลาด \`${failed}\``
        )
        .setFooter({
            text: `ผู้สั่งการ: ${user?.tag || "ผู้ดูแลระบบ"} • ระบบความปลอดภัยหน่วงเวลา 1.2 วินาที`,
            iconURL: user?.displayAvatarURL?.({ dynamic: true }) || undefined
        })
        .setTimestamp();
}

function formatEmojiShowcase(emojis, isAnimated) {
    if (!emojis || emojis.length === 0) return null;
    let text = "";
    let shownCount = 0;
    for (const e of emojis) {
        const item = isAnimated ? `<a:${e.name}:${e.id}> ` : `<:${e.name}:${e.id}> `;
        if ((text + item).length > 950) {
            text += `\n*...และอีก ${emojis.length - shownCount} ตัว*`;
            break;
        }
        text += item;
        shownCount++;
    }
    return text.trim();
}

function formatFailedEmojiList(emojis) {
    if (!emojis || emojis.length === 0) return null;
    const lines = emojis.slice(0, 8).map(e => `• \`:${e.name}:\` — ${e.reason || "เกิดข้อผิดพลาด"}`);
    let res = lines.join("\n");
    if (emojis.length > 8) {
        res += `\n*...และอีก ${emojis.length - 8} ตัว*`;
    }
    return res.slice(0, 1024);
}

function formatSkippedEmojiList(emojis) {
    if (!emojis || emojis.length === 0) return null;
    const lines = emojis.slice(0, 8).map(e => `• \`:${e.name}:\` (${e.isAnimated ? "เคลื่อนไหว ✨" : "ทั่วไป 🖼️"})`);
    let res = lines.join("\n");
    if (emojis.length > 8) {
        res += `\n*...และอีก ${emojis.length - 8} ตัว*`;
    }
    return res.slice(0, 1024);
}

function buildEmojiResultEmbed({ total, added, skipped, failed, createdStatic, createdAnimated, skippedEmojis, failedEmojis, guild, user }) {
    let resultState = "failed";
    if (added === total) resultState = "complete";
    else if (added > 0) resultState = "partial";

    let color = config.system.themeColors.error || "#ED4245";
    let title = `${config.emojis.error || "❌"} นำเข้าอิโมจิไม่สำเร็จ`;
    if (resultState === "complete") {
        color = config.system.themeColors.success || "#57F287";
        title = `${config.emojis.success || "✅"} นำเข้าอิโมจิเสร็จสมบูรณ์ 100%`;
    } else if (resultState === "partial") {
        color = config.system.themeColors.warning || "#FEE75C";
        title = `${config.emojis.warning || "⚠️"} นำเข้าอิโมจิสำเร็จบางส่วน`;
    }

    const embed = new MessageEmbed()
        .setColor(color)
        .setAuthor({
            name: "ผลการนำเข้าอิโมจิเข้าสู่เซิร์ฟเวอร์",
            iconURL: guild?.iconURL?.({ dynamic: true }) || undefined
        })
        .setTitle(title)
        .setDescription(
            `> 📊 **สรุปการดำเนินการ:** นำเข้าสำเร็จ **${added}** จากทั้งหมด **${total}** ตัว\n` +
            `> 🟢 **สำเร็จ:** \`${added}\` ตัว | 🟡 **ข้าม (โควตาเต็ม):** \`${skipped}\` ตัว | 🔴 **ล้มเหลว:** \`${failed}\` ตัว`
        )
        .setFooter({
            text: `ผู้สั่งการ: ${user?.tag || "ผู้ดูแลระบบ"} • ดำเนินการเสร็จสิ้น`,
            iconURL: user?.displayAvatarURL?.({ dynamic: true }) || undefined
        })
        .setTimestamp();

    if (createdStatic.length > 0) {
        const showcase = formatEmojiShowcase(createdStatic, false);
        embed.addFields([
            { name: `🖼️ อิโมจิทั่วไป (Static) — ${createdStatic.length} ตัว`, value: showcase || "—", inline: false }
        ]);
    }

    if (createdAnimated.length > 0) {
        const showcase = formatEmojiShowcase(createdAnimated, true);
        embed.addFields([
            { name: `✨ อิโมจิเคลื่อนไหว (Animated) — ${createdAnimated.length} ตัว`, value: showcase || "—", inline: false }
        ]);
    }

    if (skippedEmojis.length > 0) {
        const skippedList = formatSkippedEmojiList(skippedEmojis);
        embed.addFields([
            { name: `⚠️ ข้ามเนื่องจากโควตาเต็ม — ${skippedEmojis.length} ตัว`, value: skippedList || "—", inline: false }
        ]);
    }

    if (failedEmojis.length > 0) {
        const failedList = formatFailedEmojiList(failedEmojis);
        embed.addFields([
            { name: `❌ รายการที่ล้มเหลว — ${failedEmojis.length} ตัว`, value: failedList || "—", inline: false }
        ]);
    }

    return embed;
}

function validateStealInput(interaction, rawText) {
    const matches = parseCustomEmojis(rawText);
    if (matches.length === 0) {
        return {
            ok: false,
            matches: [],
            noticeEmbed: buildEmojiNoticeEmbed({
                title: "ไม่พบอิโมจิ Custom ในข้อความที่ระบุ",
                description:
                    `> ${config.emojis.warning} กรุณาวางอิโมจิที่เป็น Custom ของ Discord เช่น \`<:name:id>\` หรือ \`<a:name:id>\`\n` +
                    `> 💡 *ไม่รองรับอิโมจิมาตรฐานของระบบ (Unicode Standard Emojis เช่น 😀, 🎉)*`,
                color: config.system.themeColors.warning || "#FEE75C",
                guild: interaction.guild,
                user: interaction.user
            })
        };
    }

    if (matches.length > 50) {
        return {
            ok: false,
            matches,
            noticeEmbed: buildEmojiNoticeEmbed({
                title: "จำนวนอิโมจิเกินขีดจำกัด",
                description:
                    `> ${config.emojis.error} สามารถนำเข้าได้สูงสุด **50 ตัว** ต่อครั้ง (คุณระบุมา \`${matches.length}\` ตัว)\n` +
                    `> 💡 *กรุณาแบ่งการนำเข้าเป็นชุดละไม่เกิน 50 ตัว*`,
                color: config.system.themeColors.error || "#ED4245",
                guild: interaction.guild,
                user: interaction.user
            })
        };
    }

    if (activeEmojiCopies.has(interaction.guild.id)) {
        return {
            ok: false,
            matches,
            noticeEmbed: buildEmojiNoticeEmbed({
                title: "เซิร์ฟเวอร์กำลังดำเนินการคัดลอกอิโมจิอยู่",
                description:
                    `> ${config.emojis.warning} มีกระบวนการคัดลอกอิโมจิกำลังทำงานอยู่ในเซิร์ฟเวอร์นี้\n` +
                    `> 💡 *กรุณารอให้กระบวนการก่อนหน้าเสร็จสิ้นก่อนเริ่มคำสั่งใหม่*`,
                color: config.system.themeColors.warning || "#FEE75C",
                guild: interaction.guild,
                user: interaction.user
            })
        };
    }

    return { ok: true, matches };
}

function resolveEmojiCreateFailureReason(err) {
    if (err?.code === 40005 || err?.message?.includes("large")) {
        return "ไฟล์ใหญ่เกินขนาดที่อนุญาต (สูงสุด 256KB)";
    }
    if (err?.code === 50035 || err?.message?.includes("name")) {
        return "ชื่ออิโมจิไม่ถูกต้องตามกฎ";
    }
    if (err?.message) {
        return err.message.slice(0, 100);
    }
    return "Discord ปฏิเสธการสร้าง";
}

async function createSingleEmoji(interaction, item) {
    try {
        const created = await interaction.guild.emojis.create({
            attachment: item.url,
            name: item.name,
            reason: `คัดลอกโดย ${interaction.user.tag} (${interaction.user.id}) ผ่านคำสั่ง /copy-emojis`
        });
        return { success: true, created: created || item };
    } catch (err) {
        return { success: false, reason: resolveEmojiCreateFailureReason(err) };
    }
}

async function executeEmojiCopyWorkflow(interaction, { matches, quotas, delayMs }) {
    let added = 0;
    let failed = 0;
    let skipped = 0;
    let staticAdded = 0;
    let animatedAdded = 0;
    const createdStatic = [];
    const createdAnimated = [];
    const skippedEmojis = [];
    const failedEmojis = [];

    const initialEmbed = buildEmojiProgressEmbed({
        current: 0,
        total: matches.length,
        added: 0,
        skipped: 0,
        failed: 0,
        currentEmojiName: matches[0]?.name,
        isAnimated: matches[0]?.isAnimated,
        guild: interaction.guild,
        user: interaction.user
    });
    await interaction.editReply({ embeds: [initialEmbed] }).catch(() => {});

    for (let i = 0; i < matches.length; i++) {
        const item = matches[i];
        const isAnimated = item.isAnimated;

        const isQuotaExceeded = isAnimated
            ? animatedAdded >= quotas.animatedFree
            : staticAdded >= quotas.staticFree;

        if (isQuotaExceeded) {
            skipped++;
            skippedEmojis.push(item);
            continue;
        }

        const res = await createSingleEmoji(interaction, item);
        if (delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
        }

        if (res.success) {
            added++;
            if (isAnimated) {
                animatedAdded++;
                createdAnimated.push(res.created);
            } else {
                staticAdded++;
                createdStatic.push(res.created);
            }
        } else {
            failed++;
            failedEmojis.push({ ...item, reason: res.reason });
        }

        const processed = i + 1;
        const shouldReport = matches.length <= 5 || (processed % 2 === 0) || (processed === matches.length);
        if (shouldReport && processed < matches.length) {
            const nextItem = matches[processed] || item;
            const progressEmbed = buildEmojiProgressEmbed({
                current: processed,
                total: matches.length,
                added,
                skipped,
                failed,
                currentEmojiName: nextItem.name,
                isAnimated: nextItem.isAnimated,
                guild: interaction.guild,
                user: interaction.user
            });
            await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});
        }
    }

    return buildEmojiResultEmbed({
        total: matches.length,
        added,
        skipped,
        failed,
        createdStatic,
        createdAnimated,
        skippedEmojis,
        failedEmojis,
        guild: interaction.guild,
        user: interaction.user
    });
}

async function handleSteal(interaction, { delayMs = 1200 } = {}) {
    if (!await requireMemberPermission(
        interaction,
        PermissionFlagsBits.Administrator,
        `> ⛔ คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`
    )) return;

    if (!await requireBotPermission(
        interaction,
        PermissionFlagsBits.ManageGuildExpressions,
        `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการอิโมจิและสติกเกอร์ (ต้องการสิทธิ์ MANAGE_GUILD_EXPRESSIONS)`
    )) return;

    const validation = validateStealInput(interaction, interaction.options.getString("emojis"));
    if (!validation.ok) {
        return interaction.reply({ embeds: [validation.noticeEmbed], ephemeral: true });
    }

    if (typeof interaction.guild?.emojis?.fetch === "function") {
        await interaction.guild.emojis.fetch().catch(() => null);
    }

    const quotas = calculateEmojiQuotas(interaction.guild);
    const quotaCheck = checkSmartEmojiQuota(quotas, validation.matches);

    if (!quotaCheck.allowed) {
        const noticeEmbed = buildEmojiNoticeEmbed({
            title: quotaCheck.title,
            description: quotaCheck.description,
            color: config.system.themeColors.error || "#ED4245",
            guild: interaction.guild,
            user: interaction.user
        });
        return interaction.reply({ embeds: [noticeEmbed], ephemeral: true });
    }

    markCommandAccepted(interaction);
    activeEmojiCopies.add(interaction.guild.id);

    try {
        if (!await safeDefer(interaction)) return null;
        const resultEmbed = await executeEmojiCopyWorkflow(interaction, {
            matches: validation.matches,
            quotas,
            delayMs
        });
        return interaction.editReply({ embeds: [resultEmbed] });
    } finally {
        activeEmojiCopies.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💾  BACKUP
// ════════════════════════════════════════════════════════════════════════════
function sortedCollectionValues(collection, compareFn) {
    return Array.from(collection?.values?.() || []).sort(compareFn);
}

function serializeRoleForBackup(role) {
    return {
        id: role.id,
        name: role.name,
        color: role.color,
        hexColor: role.hexColor,
        permissions: role.permissions.bitfield.toString(),
        hoist: !!role.hoist,
        mentionable: !!role.mentionable,
        position: role.position,
        managed: !!role.managed,
        createdTimestamp: role.createdTimestamp || null
    };
}

const SUPPORTED_BACKUP_CHANNEL_TYPES = new Set([
    "GUILD_TEXT",
    "GUILD_VOICE",
    "GUILD_CATEGORY",
    "GUILD_NEWS",
    "GUILD_STAGE_VOICE"
]);

function serializeChannelForBackup(channel) {
    if (!channel || channel.isThread?.() === true) return null;
    const legacyType = getLegacyChannelType(channel.type);
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(legacyType)) return null;
    const overwriteCache = channel.permissionOverwrites?.cache;
    if (!overwriteCache?.map) return null;

    const out = {
        id: channel.id,
        name: channel.name,
        type: legacyType,
        parentId: channel.parentId,
        position: channel.position,
        rawPosition: channel.rawPosition,
        permissionOverwrites: overwriteCache.map(o => ({
            id: o.id,
            type: o.type,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString()
        }))
    };

    for (const key of [
        "topic", "nsfw", "rateLimitPerUser", "bitrate", "userLimit",
        "rtcRegion", "videoQualityMode", "defaultAutoArchiveDuration"
    ]) {
        if (channel[key] !== undefined) out[key] = channel[key];
    }

    return out;
}

function restoreBigInt(value) {
    try { return BigInt(value || "0"); } catch { return BigInt(0); }
}

function findUniqueByName(collection, predicate) {
    const found = collection.filter(predicate);
    return found.size === 1 ? found.first() : null;
}

function roleCreatePayload(rData) {
    return {
        name: rData.name,
        color: rData.color || rData.hexColor || undefined,
        permissions: restoreBigInt(rData.permissions),
        hoist: !!rData.hoist,
        mentionable: !!rData.mentionable,
        reason: "Enterprise Restore"
    };
}

function channelCreatePayload(cData, parentId, permissionOverwrites) {
    const payload = {
        type: resolveChannelType(cData.type),
        parent: parentId,
        permissionOverwrites,
        reason: "Enterprise Restore"
    };

    for (const key of [
        "topic", "nsfw", "rateLimitPerUser", "bitrate", "userLimit",
        "rtcRegion", "videoQualityMode", "defaultAutoArchiveDuration"
    ]) {
        if (cData[key] !== undefined && cData[key] !== null) payload[key] = cData[key];
    }

    return payload;
}

function normalizeSnapshotChannelType(type) {
    return Number.isInteger(type) ? getLegacyChannelType(type) : type;
}

function normalizeSnapshotChannels(channels) {
    if (!Array.isArray(channels)) return [];
    return channels.map(channel => ({
        ...channel,
        type: normalizeSnapshotChannelType(channel?.type)
    }));
}

function buildBackupValidationReport(data) {
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const overwritesTotal = channels.reduce((sum, c) => sum + (Array.isArray(c.permissionOverwrites) ? c.permissionOverwrites.length : 0), 0);
    const unsupportedItems = [];
    const warnings = [];

    const managedRoles = roles.filter(role => role.managed).length;
    if (managedRoles) warnings.push(`${managedRoles} managed roles cannot be recreated`);

    const unsupportedChannels = channels.filter(c => !SUPPORTED_BACKUP_CHANNEL_TYPES
        .has(normalizeSnapshotChannelType(c.type)));
    for (const channel of unsupportedChannels) {
        unsupportedItems.push(`channel:${normalizeSnapshotChannelType(channel.type)}:${channel.name}`);
    }

    return {
        schemaVersion: data.schemaVersion || 1,
        rolesTotal: roles.length,
        channelsTotal: channels.length,
        overwritesTotal,
        unsupportedItems,
        warnings
    };
}

function isValidSnapshotSchema(data) {
    const snowflake = value => /^\d{17,22}$/.test(String(value || ""));
    const permissionBits = value => (
        (typeof value === "string" && /^\d+$/.test(value)) ||
        (Number.isSafeInteger(value) && value >= 0)
    );
    const overwriteType = value => [0, 1, "0", "1", "role", "member"].includes(value);
    const validOverwrite = overwrite => (
        !!overwrite &&
        snowflake(overwrite.id) &&
        overwriteType(overwrite.type) &&
        permissionBits(overwrite.allow) &&
        permissionBits(overwrite.deny)
    );
    if (!data || !Array.isArray(data.roles) || !Array.isArray(data.channels)) return false;
    if (!snowflake(data.guild?.id)) return false;
    if (data.roles.some(role => !role || !snowflake(role.id) || typeof role.name !== "string")) return false;
    return !data.channels.some(channel =>
        !channel || !snowflake(channel.id) || typeof channel.name !== "string" ||
        (channel.parentId != null && !snowflake(channel.parentId)) ||
        (channel.permissionOverwrites != null && !Array.isArray(channel.permissionOverwrites)) ||
        (Array.isArray(channel.permissionOverwrites) && channel.permissionOverwrites.some(overwrite => !validOverwrite(overwrite)))
    );
}

function snapshotIdentityMatches(backup, backupData, expectedGuildId = null) {
    const metadataGuildId = String(backup?.guildId || "");
    const payloadGuildId = String(backupData?.guild?.id || "");
    if (!metadataGuildId || payloadGuildId !== metadataGuildId) return false;
    return expectedGuildId === null || metadataGuildId === String(expectedGuildId || "");
}

function normalizeOverwriteType(value) {
    if (value === 0 || value === "0") return "role";
    if (value === 1 || value === "1") return "member";
    return value;
}

function findExistingChannelForRestore(guild, cData, parentId) {
    const channelType = normalizeSnapshotChannelType(cData.type);
    let matches = guild.channels.cache.filter(c =>
        c.name === cData.name && getLegacyChannelType(c.type) === channelType
    );

    if (channelType !== "GUILD_CATEGORY") {
        if (cData.parentId && parentId) {
            matches = matches.filter(c => c.parentId === parentId);
        } else if (cData.parentId && !parentId) {
            return { exists: null, ambiguous: matches.size > 0 };
        } else {
            matches = matches.filter(c => !c.parentId);
        }
    }

    return {
        exists: matches.size === 1 ? matches.first() : null,
        ambiguous: matches.size > 1
    };
}

function shouldSkipRestoreRole(roleData) {
    return roleData.managed || roleData.name === config.roles.adminName || roleData.name === config.roles.userName;
}

function planRestoreRole(guild, roleData, roleIdMap, plan) {
    if (shouldSkipRestoreRole(roleData)) {
        plan.rolesSkipped++;
        return;
    }

    let existingRole = findUniqueByName(guild.roles.cache, r => r.name === roleData.name);
    if (roleData.name === "@everyone") existingRole = guild.roles.everyone;

    if (!existingRole && guild.roles.cache.filter(r => r.name === roleData.name).size > 1) {
        plan.rolesAmbiguous++;
        return;
    }

    if (!existingRole) {
        plan.rolesToCreate++;
        if (roleData.id) roleIdMap.set(roleData.id, `planned-role:${roleData.id}`);
    }
    if (existingRole && roleData.id) roleIdMap.set(roleData.id, existingRole.id);
}

function planRestoreCategory(guild, channelData, categoryIdMap, plan) {
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(channelData.type)) {
        plan.channelsSkipped++;
        return;
    }
    const found = findExistingChannelForRestore(guild, channelData);

    if (found.ambiguous) {
        plan.channelsAmbiguous++;
    } else if (found.exists) {
        plan.channelsSkipped++;
        if (channelData.id) categoryIdMap.set(channelData.id, found.exists.id);
    } else {
        plan.channelsToCreate++;
        if (channelData.id) categoryIdMap.set(channelData.id, `planned-category:${channelData.id}`);
    }
}

const RESTORE_MEMBER_FETCH_CONCURRENCY = 4;
const RESTORE_MEMBER_FETCH_TIMEOUT_MS = 5000;

function collectRestoreMemberIds(channels) {
    const memberIds = new Set();
    for (const channelData of channels || []) {
        for (const overwrite of channelData.permissionOverwrites || []) {
            if (normalizeOverwriteType(overwrite.type) === "member") memberIds.add(overwrite.id);
        }
    }
    return [...memberIds];
}

function isMissingRestoreMemberError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    return code === 10007 || Number(error?.status) === 404;
}

async function fetchRestoreMemberWithTimeout(guild, memberId, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            Promise.resolve().then(() => guild.members.fetch(memberId)),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error(`RESTORE_MEMBER_FETCH_TIMEOUT:${memberId}`);
                    error.code = "RESTORE_MEMBER_FETCH_TIMEOUT";
                    reject(error);
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function resolveRestoreMemberTargets(guild, channels, options = {}) {
    const states = new Map();
    const pending = [];
    for (const memberId of collectRestoreMemberIds(channels)) {
        if (guild.members.cache.has(memberId)) states.set(memberId, "resolved");
        else pending.push(memberId);
    }

    if (pending.length === 0) return states;
    if (typeof guild.members.fetch !== "function") {
        for (const memberId of pending) states.set(memberId, "unresolved");
        return states;
    }

    const requestedConcurrency = Number(options.memberFetchConcurrency);
    const requestedTimeoutMs = Number(options.memberFetchTimeoutMs);
    const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.min(10, Math.trunc(requestedConcurrency)))
        : RESTORE_MEMBER_FETCH_CONCURRENCY;
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
        ? Math.max(100, Math.min(30000, Math.trunc(requestedTimeoutMs)))
        : RESTORE_MEMBER_FETCH_TIMEOUT_MS;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        while (cursor < pending.length) {
            const memberId = pending[cursor++];
            try {
                const member = await fetchRestoreMemberWithTimeout(guild, memberId, timeoutMs);
                states.set(memberId, member ? "resolved" : "missing");
            } catch (error) {
                states.set(memberId, isMissingRestoreMemberError(error) ? "missing" : "unresolved");
            }
        }
    });
    await Promise.all(workers);
    return states;
}

function resolveRestoreOverwriteTarget(guild, overwrite, roleIdMap, oldGuildId, memberTargetStates = new Map()) {
    const overwriteType = normalizeOverwriteType(overwrite.type);
    let targetId = roleIdMap.get(overwrite.id);
    if (overwrite.id === oldGuildId) targetId = guild.id;
    if (!targetId && overwriteType === "member" && guild.members.cache.has(overwrite.id)) targetId = overwrite.id;
    if (!targetId && overwriteType === "member" && memberTargetStates.get(overwrite.id) === "resolved") targetId = overwrite.id;
    if (!targetId && overwriteType === "role" && guild.roles.cache.has(overwrite.id)) targetId = overwrite.id;
    return targetId;
}

function buildResolvedOverwrites(guild, channelData, roleIdMap, oldGuildId, memberTargetStates = new Map()) {
    const stats = {
        restored: 0,
        skippedRoleMissing: 0,
        skippedMemberMissing: 0,
        skippedMemberUnresolved: 0
    };
    const overwrites = [];
    for (const overwrite of channelData.permissionOverwrites || []) {
        const overwriteType = normalizeOverwriteType(overwrite.type);
        const targetId = resolveRestoreOverwriteTarget(
            guild, overwrite, roleIdMap, oldGuildId, memberTargetStates
        );
        if (targetId) {
            stats.restored++;
            overwrites.push({
                id: targetId,
                allow: restoreBigInt(overwrite.allow),
                deny: restoreBigInt(overwrite.deny)
            });
        } else if (overwriteType === "member") {
            if (memberTargetStates.get(overwrite.id) === "unresolved") stats.skippedMemberUnresolved++;
            else stats.skippedMemberMissing++;
        } else {
            stats.skippedRoleMissing++;
        }
    }
    return { overwrites, stats };
}

function addOverwriteStats(target, source, { includeRestored = true } = {}) {
    if (includeRestored) target.restored += Number(source.restored || 0);
    target.skippedRoleMissing += Number(source.skippedRoleMissing || 0);
    target.skippedMemberMissing += Number(source.skippedMemberMissing || 0);
    target.skippedMemberUnresolved = Number(target.skippedMemberUnresolved || 0) +
        Number(source.skippedMemberUnresolved || 0);
}

function planRestoreOverwrites(guild, channelData, roleIdMap, oldGuildId, plan, memberTargetStates) {
    const resolved = buildResolvedOverwrites(
        guild, channelData, roleIdMap, oldGuildId, memberTargetStates
    );
    plan.overwritesRestored += resolved.stats.restored;
    plan.overwritesSkippedRoleMissing += resolved.stats.skippedRoleMissing;
    plan.overwritesSkippedMemberMissing += resolved.stats.skippedMemberMissing;
    plan.overwritesSkippedMemberUnresolved += resolved.stats.skippedMemberUnresolved;
}

function planRestoreChannel(
    guild, channelData, categoryIdMap, roleIdMap, oldGuildId, plan, memberTargetStates
) {
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(channelData.type)) {
        plan.channelsSkipped++;
        return;
    }
    const parentId = channelData.parentId ? categoryIdMap.get(channelData.parentId) : undefined;
    const found = findExistingChannelForRestore(guild, channelData, parentId);

    if (found.ambiguous) {
        plan.channelsAmbiguous++;
        return;
    }
    if (found.exists) {
        plan.channelsSkipped++;
        return;
    }
    plan.channelsToCreate++;
    planRestoreOverwrites(
        guild, channelData, roleIdMap, oldGuildId, plan, memberTargetStates
    );
}

async function buildRestorePlan(guild, backupData, oldGuildId, options = {}) {
    const roles = Array.isArray(backupData.roles) ? backupData.roles : [];
    const channels = normalizeSnapshotChannels(backupData.channels);
    const memberTargetStates = options.memberTargetStates instanceof Map
        ? options.memberTargetStates
        : await resolveRestoreMemberTargets(guild, channels, options);
    const roleIdMap = new Map();
    const categoryIdMap = new Map();
    const plan = {
        rolesToCreate: 0,
        rolesSkipped: 0,
        rolesAmbiguous: 0,
        channelsToCreate: 0,
        channelsSkipped: 0,
        channelsAmbiguous: 0,
        overwritesRestored: 0,
        overwritesSkippedRoleMissing: 0,
        overwritesSkippedMemberMissing: 0,
        overwritesSkippedMemberUnresolved: 0,
        warnings: []
    };

    for (const rData of roles) {
        planRestoreRole(guild, rData, roleIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type === "GUILD_CATEGORY")) {
        planRestoreCategory(guild, cData, categoryIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type !== "GUILD_CATEGORY")) {
        planRestoreChannel(
            guild, cData, categoryIdMap, roleIdMap, oldGuildId, plan, memberTargetStates
        );
    }

    if (plan.rolesAmbiguous || plan.channelsAmbiguous) {
        plan.warnings.push("พบชื่อซ้ำที่ต้องตรวจเองก่อน restore");
    }

    return plan;
}

function buildBackupCreatedEvent(interaction, snapshotId, data, durationMs) {
    return {
        target: "LOG", severity: "SUCCESS", category: "BACKUP", code: "backup.created",
        title: "สร้างข้อมูลสำรองเซิร์ฟเวอร์สำเร็จ",
        context: {
  "Guild ID": String(interaction.guild?.id || "unknown"),
  "User ID": String(interaction.user?.id || "unknown"),
  "Snapshot ID": String(snapshotId || "unknown"),
  "Schema": `v${data?.schemaVersion || 1}`,
  "Roles": Number(data?.roles?.length || 0),
  "Channels": Number(data?.channels?.length || 0),
  "ระยะเวลา": `${Math.max(0, Number(durationMs || 0))} ms`
        },
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
        thumbnailUrl: getDiscordAvatarUrl(interaction.user)
    };
}

function buildBackupFailedEvent(interaction, error, durationMs) {
    const guildId = String(interaction.guild?.id || "unknown");
    return {
        target: "ALERT", severity: "ERROR", category: "BACKUP", code: "backup.failed", state: "OPEN",
        title: "สร้างข้อมูลสำรองเซิร์ฟเวอร์ไม่สำเร็จ", description: safeError(error),
        impact: "ไม่มีการสลับไปใช้ snapshot ที่บันทึกไม่ครบ",
        action: "ตรวจ Runtime Log, MongoDB และสิทธิ์อ่านโครงสร้างเซิร์ฟเวอร์ก่อนลองใหม่",
        context: {
  "Guild ID": guildId,
  "User ID": String(interaction.user?.id || "unknown"),
  "ระยะเวลา": `${Math.max(0, Number(durationMs || 0))} ms`
        },
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
        thumbnailUrl: getDiscordAvatarUrl(interaction.user),
        dedupeKey: `backup-failed:${guildId}`, dedupeMs: 5 * 60 * 1000
    };
}

async function handleBackup(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId &&
        !isConfiguredOwner(config, interaction.user.id)) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} คำสั่งนี้สงวนไว้สำหรับ **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`,
            ephemeral: true
        });
    }

    if (activeBackups.has(interaction.guild.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} ระบบกำลังสำรองข้อมูลอยู่ โปรดรอ`,
            ephemeral: true
        });
    }
    activeBackups.add(interaction.guild.id);
    const backupStartedAt = Date.now();

    try {
        await interaction.deferReply();
        const existing = await sessionManager.getLatestSnapshotForGuild(interaction.guild.id);
        if (existing && !isConfiguredOwner(config, interaction.user.id)) {
            const hoursPassed = (Date.now() - existing.createdAt) / 3600000;
            if (hoursPassed < 24) {
                return interaction.editReply({
                    content: `> ${config.emojis.warning} บันทึกไปแล้วเมื่อ <t:${Math.floor(existing.createdAt / 1000)}:R> โปรดรอให้ครบ 24 ชั่วโมง`
                });
            }
        }
        markCommandAccepted(interaction);

        const data = {
            schemaVersion: 2,
            createdAt: Date.now(),
            guild: {
                id: interaction.guild.id,
                name: interaction.guild.name,
                ownerId: interaction.guild.ownerId,
                icon: interaction.guild.icon || null
            },
            limitations: [
                "restore_creates_missing_only",
                "managed_roles_not_recreated",
                "webhooks_invites_threads_messages_not_restored"
            ],
            roles: sortedCollectionValues(
                interaction.guild.roles.cache,
                (a, b) => a.position - b.position
            ).map(serializeRoleForBackup),
            channels: sortedCollectionValues(
                interaction.guild.channels.cache,
                (a, b) => (a.rawPosition || 0) - (b.rawPosition || 0)
            ).map(serializeChannelForBackup).filter(Boolean)
        };
        data.validationReport = buildBackupValidationReport(data);

        const snapshotId = crypto.randomUUID();
        const stored = await sessionManager.saveChunkedSnapshot(
            snapshotId,
            interaction.guild.id,
            interaction.user.id,
            data
        );
        if (!stored) throw new Error("SNAPSHOT_SAVE_FAILED");

        sendWebhookEvent(buildBackupCreatedEvent(
            interaction, snapshotId, data, Date.now() - backupStartedAt
        )).catch(() => {});

        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setDescription(
                `> ${config.emojis.backup_icon} **บันทึกโครงสร้างสำเร็จ!**\n` +
                `— **ผู้บันทึก:** <@${interaction.user.id}>\n` +
                `— **ยศ:** ${data.roles.length} ยศ\n` +
                `— **ห้อง:** ${data.channels.length} ห้อง`
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error("[BACKUP] Failed:", err.message);
        sendWebhookEvent(buildBackupFailedEvent(
            interaction, err, Date.now() - backupStartedAt
        )).catch(() => {});
        return interaction.editReply({ content: `> ${config.emojis.error} สำรองข้อมูลไม่สำเร็จ และไม่ได้สลับไปใช้ snapshot ที่บันทึกไม่ครบ` });
    } finally {
        activeBackups.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  RESTORE
// ════════════════════════════════════════════════════════════════════════════
async function handleRestore(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.user.id !== interaction.guild.ownerId &&
        !isConfiguredOwner(config, interaction.user.id)) {
        return interaction.editReply({
            content: `> ${config.emojis.no_entry} คุณต้องเป็น **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`
        });
    }
    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.editReply({
            content: `> ${config.emojis.error} บอทต้องมีสิทธิ์ **Administrator** เพื่อกู้คืน!`
        });
    }

    const targetId = interaction.options.getString("server_id");
    const dryRun = interaction.options.getBoolean("dry_run") === true;
    if (!/^\d{17,22}$/.test(String(targetId || ""))) {
        return interaction.editReply({ content: `> ${config.emojis.error} Server ID ไม่ถูกต้อง` });
    }

    const backup = await sessionManager.getLatestSnapshotForGuild(targetId);
    if (!backup) {
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup ของไอดีนี้` });
    }
    if (backup.Backup_Owner_ID !== interaction.user.id && !isConfiguredOwner(config, interaction.user.id)) {
        return interaction.editReply({
            content: `> ${config.emojis.lock} **ปฏิเสธ!** กุญแจผู้บันทึกไม่ตรงกัน`
        });
    }

    const backupData = await sessionManager.loadSnapshotData(backup);
    if (!isValidSnapshotSchema(backupData) || !snapshotIdentityMatches(backup, backupData, targetId)) {
        return interaction.editReply({ content: `> ${config.emojis.error} Backup ไม่ครบหรือ schema ไม่ถูกต้อง จึงไม่สามารถกู้คืนได้` });
    }
    markCommandAccepted(interaction);
    const plan = await buildRestorePlan(interaction.guild, backupData, backup.guildId);
    const validation = backupData.validationReport || buildBackupValidationReport(backupData);
    const planText =
        `— จะสร้างยศใหม่: ${plan.rolesToCreate}\n` +
        `— จะสร้างห้องใหม่: ${plan.channelsToCreate}\n` +
        `— ข้าม/ชื่อซ้ำ: ${plan.rolesSkipped + plan.channelsSkipped} ข้าม, ${plan.rolesAmbiguous + plan.channelsAmbiguous} ชื่อซ้ำ\n` +
        `— Permission overwrites: ${plan.overwritesRestored} ใช้ได้, ${plan.overwritesSkippedRoleMissing} role หาย, ${plan.overwritesSkippedMemberMissing} member หาย, ${plan.overwritesSkippedMemberUnresolved} member ตรวจไม่ได้`;

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setTitle(dryRun ? `${config.emojis.restore_icon} Restore Dry Run` : `${config.emojis.warning} ยืนยันการกู้คืนเซิร์ฟเวอร์`)
        .setDescription(
            `${config.emojis.folder} **ข้อมูล Backup:**\n` +
            `— บันทึกโดย: <@${backup.Backup_Owner_ID}>\n` +
            `— เวลา: <t:${Math.floor(backup.createdAt / 1000)}:F>\n` +
            `— Schema: v${backupData.schemaVersion || 1}\n` +
            `— ข้อมูล: ${backupData.roles.length} ยศ, ${backupData.channels.length} ห้อง\n` +
            `— Report: ${validation.rolesTotal} roles, ${validation.channelsTotal} channels, ${validation.overwritesTotal} overwrites\n\n` +
            `${config.emojis.signal} **แผน Restore:**\n${planText}\n\n` +
            `*กระบวนการนี้จะสร้างสิ่งที่หายไปกลับมา และจะไม่กู้คืนข้อความ, thread, webhook หรือ invite*`
        );

    if (dryRun) {
        return interaction.editReply({ embeds: [embed], components: [] });
    }

    const row = new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(`btn_restore_confirm_${interaction.guild.id}_${backup.snapshotId}`)
            .setLabel("ยืนยันกู้คืน").setStyle("SUCCESS"),
        new MessageButton()
            .setCustomId("btn_restore_cancel")
            .setLabel("ยกเลิก").setStyle("DANGER")
    );
    return interaction.editReply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅  RESTORE CONFIRM (Button Handler — ถูกเรียกจาก commands.js Router)
// ════════════════════════════════════════════════════════════════════════════
async function handleRestoreConfirm(interaction, sessionManager) {
    if (activeRestores.has(interaction.guild.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} กำลังกู้คืนอยู่ โปรดรอ`,
            ephemeral: true
        });
    }
    activeRestores.add(interaction.guild.id);

    const confirmParts = interaction.customId.replace("btn_restore_confirm_", "").split("_");
    const boundGuildId = confirmParts[0];
    const snapshotId = confirmParts[1];
    if (boundGuildId !== interaction.guild.id) {
        activeRestores.delete(interaction.guild.id);
        return interaction.reply({ content: `> ${config.emojis.no_entry} ปุ่ม Restore นี้ไม่ได้สร้างสำหรับเซิร์ฟเวอร์นี้`, ephemeral: true });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
        activeRestores.delete(interaction.guild.id);
        return interaction.reply({ content: `> ${config.emojis.error} รหัส Backup ไม่ถูกต้อง`, ephemeral: true });
    }

    try {
        await interaction.update({
            components: [],
            embeds: [new MessageEmbed()
                .setColor(config.system.themeColors.warning)
                .setDescription(`> ${config.emojis.signal} **กำลังกู้คืน กรุณารอสักครู่...**`)]
        });
    } catch {
        activeRestores.delete(interaction.guild.id);
        return null;
    }

    (async () => {
        try {
            const backup = await sessionManager.SnapshotModel.findOne({ snapshotId });
            const isOwner = interaction.user.id === interaction.guild.ownerId || isConfiguredOwner(config, interaction.user.id);
            const ownsBackup = backup?.Backup_Owner_ID === interaction.user.id || isConfiguredOwner(config, interaction.user.id);
            const botIsAdmin = interaction.guild.members.me.permissions.has(PermissionFlagsBits.Administrator);
            const backupData = await sessionManager.loadSnapshotData(backup);
            if (!isOwner || !ownsBackup || !botIsAdmin) {
                return interaction.followUp({ content: `> ${config.emojis.no_entry} สิทธิ์สำหรับ Restore เปลี่ยนไป กรุณาเริ่มคำสั่งใหม่`, ephemeral: true }).catch(() => {});
            }
            if (!isValidSnapshotSchema(backupData) || !snapshotIdentityMatches(backup, backupData)) {
                return interaction.followUp({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup`, ephemeral: true }).catch(() => {});
            }

            const guild = interaction.guild;
            const roles = backupData.roles;
            const channels = normalizeSnapshotChannels(backupData.channels);
            const memberTargetStates = await resolveRestoreMemberTargets(guild, channels);
            const oldGuildId = backup.guildId;
            const roleIdMap  = new Map();
            let restoredRoles    = 0;
            let restoredChannels = 0;
            let skippedRoles     = 0;
            let skippedChannels  = 0;
            let ambiguousRoles   = 0;
            let ambiguousChannels = 0;
            let restoreErrors    = 0;
            const overwriteStats = {
                restored: 0,
                skippedRoleMissing: 0,
                skippedMemberMissing: 0,
                skippedMemberUnresolved: 0
            };
            const startTime      = Date.now();
            const MAX_DUR        = 14 * 60 * 1000;
            let timeoutHit       = false;

            if (Array.isArray(roles)) {
                for (const rData of roles) {
                    await new Promise(resolve => setImmediate(resolve));

                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }
                    if (
                        rData.managed ||
                        rData.name === config.roles.adminName ||
                        rData.name === config.roles.userName
                    ) {
                        skippedRoles++;
                        continue;
                    }

                    let existingRole = findUniqueByName(guild.roles.cache, r => r.name === rData.name);
                    if (rData.name === "@everyone") existingRole = guild.roles.everyone;
                    if (!existingRole && guild.roles.cache.filter(r => r.name === rData.name).size > 1) {
                        ambiguousRoles++;
                        continue;
                    }

                    if (!existingRole) {
                        try {
                            existingRole = await guild.roles.create(roleCreatePayload(rData));
                            if (Number.isFinite(Number(rData.position))) {
                                try {
                                    await existingRole.setPosition(Number(rData.position), "Enterprise Restore role position");
                                } catch {
                                    restoreErrors++;
                                }
                            }
                            restoredRoles++;
                            await new Promise(r => setTimeout(r, 600));
                        } catch (e) {
                            console.error("[RESTORE] Role error:", e.message);
                            restoreErrors++;
                        }
                    }
                    if (existingRole && rData.id) roleIdMap.set(rData.id, existingRole.id);
                }
            }

            if (Array.isArray(channels)) {
                const categoryIdMap = new Map();
                const validTypes = new Set(SUPPORTED_BACKUP_CHANNEL_TYPES);



                // Pass 1: สร้าง Category ก่อน → เก็บ old ID → new ID
                for (const cData of channels) {
                    if (cData.type !== 'GUILD_CATEGORY') continue;
                    await new Promise(resolve => setImmediate(resolve));
                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }

                    const matches = guild.channels.cache.filter(c =>
                        c.name === cData.name && getLegacyChannelType(c.type) === "GUILD_CATEGORY"
                    );
                    const exists = matches.size === 1 ? matches.first() : null;
                    if (!exists && matches.size > 1) {
                        ambiguousChannels++;
                        continue;
                    }
                    if (exists) {
                        skippedChannels++;
                        if (cData.id) categoryIdMap.set(cData.id, exists.id);
                    } else {
                        try {
                            const resolvedOverwrites = buildResolvedOverwrites(guild, cData, roleIdMap, oldGuildId, memberTargetStates);
                            const newCat = await guild.channels.create({
                                name: cData.name,
                                ...channelCreatePayload(cData, undefined, resolvedOverwrites.overwrites),
                                type: resolveChannelType("GUILD_CATEGORY")
                            });
                            if (cData.id) categoryIdMap.set(cData.id, newCat.id);
                            addOverwriteStats(overwriteStats, resolvedOverwrites.stats);
                            restoredChannels++;
                            await new Promise(r => setTimeout(r, 600));
                        } catch (e) {
                            console.error("[RESTORE] Category error:", e.message);
                            restoreErrors++;
                        }
                    }
                }

                // Pass 2: สร้างห้องที่เหลือพร้อม parent ที่ถูกต้อง
                if (!timeoutHit) {
                    for (const cData of channels) {
                        if (cData.type === 'GUILD_CATEGORY') continue;
                        await new Promise(resolve => setImmediate(resolve));
                        if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }

                        const parentId = cData.parentId ? (categoryIdMap.get(cData.parentId) || undefined) : undefined;
                        const found = findExistingChannelForRestore(guild, cData, parentId);
                        const exists = found.exists;
                        if (!exists && found.ambiguous) {
                            ambiguousChannels++;
                            continue;
                        }
                        if (exists) {
                            skippedChannels++;
                            continue;
                        }
                        if (!exists) {
                            try {
                                if (validTypes.has(cData.type)) {
                                    const resolvedOverwrites = buildResolvedOverwrites(guild, cData, roleIdMap, oldGuildId, memberTargetStates);
                                    await guild.channels.create({
                                        name: cData.name,
                                        ...channelCreatePayload(cData, parentId, resolvedOverwrites.overwrites)
                                    });
                                    addOverwriteStats(overwriteStats, resolvedOverwrites.stats);
                                    restoredChannels++;
                                    await new Promise(r => setTimeout(r, 600));
                                } else {
                                    skippedChannels++;
                                }
                            } catch (e) {
                                console.error("[RESTORE] Channel error:", e.message);
                                restoreErrors++;
                            }
                        }
                    }
                }
            }

            const timeMsg = timeoutHit ? `\n> ${config.emojis.warning} หยุดอัตโนมัติ: เกิน 14 นาที` : "";
            const detailMsg =
                `\n— ข้าม: ${skippedRoles} ยศ, ${skippedChannels} ห้อง` +
                `\n— ชื่อซ้ำ/ไม่แน่ชัด: ${ambiguousRoles} ยศ, ${ambiguousChannels} ห้อง` +
                `\n— Permission overwrites: ${overwriteStats.restored} ใช้ได้, ${overwriteStats.skippedRoleMissing} role หาย, ${overwriteStats.skippedMemberMissing} member หาย, ${overwriteStats.skippedMemberUnresolved} member ตรวจไม่ได้` +
                `\n— Error: ${restoreErrors}`;
            const incompleteItems = skippedChannels + ambiguousRoles + ambiguousChannels +
                overwriteStats.skippedRoleMissing + overwriteStats.skippedMemberMissing +
                overwriteStats.skippedMemberUnresolved;
            let resultState = "failed";
            if (restoreErrors === 0 && !timeoutHit && incompleteItems === 0) resultState = "complete";
            else if (restoredRoles + restoredChannels > 0) resultState = "partial";
            const resultIcon = resultState === "complete" ? config.emojis.success : config.emojis.warning;
            const resultMsg = `> ${resultIcon} **ผลการกู้คืน: ${restoreStateLabel(resultState)}**\n— สร้างยศใหม่: ${restoredRoles} ยศ\n— สร้างห้องใหม่: ${restoredChannels} ห้อง${detailMsg}${timeMsg}`;
            const sent = await interaction.followUp({ content: resultMsg, ephemeral: true }).catch(() => null);
            if (!sent) {
                const embed = buildRestoreResultDmEmbed({
                    interaction,
                    resultState,
                    restoredRoles,
                    restoredChannels,
                    skippedRoles,
                    skippedChannels,
                    ambiguousRoles,
                    ambiguousChannels,
                    overwriteStats,
                    restoreErrors,
                    timeoutHit
                });
                const delivery = await dmService.send({
                    eventKey: `restore:${interaction.guild.id}:${interaction.id || startTime}`,
                    recipientId: interaction.user.id,
                    category: "restore",
                    priority: resultState === "complete" ? "normal" : "high",
                    payload: { embeds: [embed] }
                });
                if (!["sent", "retrying"].includes(delivery?.status)) {
                    console.warn(
                        `[RESTORE] Private result delivery unavailable | guild=${interaction.guild.id} | ref=${interaction.id || "unknown"}`
                    );
                    await sendWebhookEvent(buildRestoreDeliveryFailureEvent(interaction)).catch(() => false);
                }
            }

        } catch (err) {
            console.error("[RESTORE] Error:", err.message);
            await interaction.followUp({
                content: `> ${config.emojis.error} กู้คืนไม่สำเร็จ กรุณาตรวจสิทธิ์และลองใหม่`,
                ephemeral: true
            }).catch(() => {});
        } finally {
            activeRestores.delete(interaction.guild.id);
        }
    })().catch(err => {
        activeRestores.delete(interaction.guild.id);
        console.error('[RESTORE] ❌ Fatal IIFE error:', err.message);
    });
}

function getRuntimeDiagnostics() {
    return {
        activeRestores: activeRestores.size,
        activeBackups: activeBackups.size,
        activeEmojiCopies: activeEmojiCopies.size
    };
}

module.exports = {
    handle,
    handleRestoreConfirm,
    getRuntimeDiagnostics,
    _test: {
        handleSay,
        handleAnnounce,
        buildAnnouncementEmbed,
        buildAnnouncementComponents,
        isValidHttpUrl,
        resolveEmbedColor,
        isValidSnapshotSchema,
        snapshotIdentityMatches,
        buildBackupValidationReport,
        buildRestorePlan,
        collectRestoreMemberIds,
        resolveRestoreMemberTargets,
        buildResolvedOverwrites,
        addOverwriteStats,
        normalizeOverwriteType,
        normalizeSnapshotChannelType,
        normalizeSnapshotChannels,
        buildRestoreDeliveryFailureEvent,
        buildBackupCreatedEvent,
        buildBackupFailedEvent,
        sortedCollectionValues,
        restoreStateLabel,
        restoreTone,
        buildRestoreResultDmEmbed,
        handleSteal,
        parseCustomEmojis,
        calculateEmojiQuotas,
        checkSmartEmojiQuota,
        renderEmojiProgressBar,
        buildEmojiNoticeEmbed,
        buildEmojiProgressEmbed,
        buildEmojiResultEmbed,
        formatEmojiShowcase,
        formatFailedEmojiList,
        formatSkippedEmojiList,
        activeEmojiCopies
    }
};

