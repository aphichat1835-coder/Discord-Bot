/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: handle, handleVerifyButton exports.
verify_type: false = กดปุ่มได้ยศเลย | true = OAuth2 flow
Button customId pattern:
  verify_role_{roleId}  → direct role toggle
  verify_oauth_{roleId} → OAuth2 redirect
================================================================================
*/

const crypto = require("crypto");
const { MessageEmbed, MessageActionRow, MessageButton } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
let GuildConfig = null;
try { GuildConfig = require("../../dashboard-public/models/GuildConfig"); } catch {}

async function handle(interaction, client) {
    if (interaction.commandName === "setup-verify") {
        return handleSetupVerify(interaction);
    }
}

async function syncGuildConfig(interaction, role, channel, panelMsg) {
    if (!GuildConfig) return;
    try {
        await GuildConfig.findOneAndUpdate(
            { guildId: interaction.guild.id },
            {
                $set: {
                    guildId: interaction.guild.id,
                    guildName: interaction.guild.name,
                    setupBy: interaction.user.id,
                    updatedAt: Date.now(),
                    'verification.enabled': true,
                    'verification.roleId': role.id,
                    'verification.roleName': role.name,
                    'verification.channelId': channel.id,
                    'verification.messageId': panelMsg.id,
                    'verification.verifyPath': '/verify',
                    'verification.updatedBy': interaction.user.id,
                    'verification.updatedAt': Date.now()
                },
                $setOnInsert: {
                    createdAt: Date.now(),
                    'verification.blockVPN': true,
                    'verification.minAccountAgeDays': 7,
                    'verification.requireEmail': false,
                    'verification.requireEmailVerified': false,
                    'verification.requireConnections': false,
                    'verification.minConnections': 1,
                    'security.storeOAuthTokens': true,
                    'security.storeRawIpEncrypted': true,
                    'security.ipRevealRequiresOwnerApproval': true,
                    'security.retentionMode': 'until_admin_delete'
                }
            },
            { upsert: true }
        );
    } catch (err) {
        console.error('[VERIFY] GuildConfig sync failed:', err.message);
    }
}

async function handleSetupVerify(interaction) {
    if (!interaction.member.permissions.has("ADMINISTRATOR")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ต้องเป็น Administrator`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel     = interaction.options.getChannel("channel");
    const role        = interaction.options.getRole("role");
    const verifyType  = interaction.options.getBoolean("verify_type") ?? false;
    const title       = interaction.options.getString("title")        || "ยืนยันตัวตน";
    const description = interaction.options.getString("description")  || "กดปุ่มด้านล่างเพื่อรับยศ";
    const colorInput  = interaction.options.getString("color")        || config.system.themeColors.primary;
    const imageUrl    = interaction.options.getString("image")        || null;
    const thumbUrl    = interaction.options.getString("thumbnail")    || null;
    const footerText  = interaction.options.getString("footer")       || null;
    const showTs      = interaction.options.getBoolean("timestamp")   ?? false;
    const titleUrl    = interaction.options.getString("url")          || null;

    if (!channel.isText()) {
        return interaction.editReply({ content: `> ${config.emojis.error} กรุณาเลือกห้องข้อความเท่านั้น` });
    }

    let colorHex = colorInput.trim();
    if (!colorHex.startsWith("#")) colorHex = "#" + colorHex;
    if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex)) colorHex = config.system.themeColors.primary;

    const embed = new MessageEmbed().setColor(colorHex).setTitle(title);
    if (titleUrl)    embed.setURL(titleUrl);
    if (description) embed.setDescription(description);
    if (imageUrl)    embed.setImage(imageUrl);
    if (thumbUrl)    embed.setThumbnail(thumbUrl);
    if (footerText)  embed.setFooter({ text: footerText });
    if (showTs)      embed.setTimestamp();

    const customId = verifyType ? `verify_oauth_${role.id}` : `verify_role_${role.id}`;
    const row = new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(customId)
            .setLabel(`" ${role.name} "`)
            .setEmoji(verifyType ? "🔐" : "🎭")
            .setStyle(verifyType ? "PRIMARY" : "SUCCESS")
    );

    try {
        const panelMsg = await channel.send({ embeds: [embed], components: [row] });

        await sessionManager.setSetting(
            `verify_config_${interaction.guild.id}_${role.id}`,
            {
                roleId:    role.id,
                roleName:  role.name,
                guildId:   interaction.guild.id,
                channelId: channel.id,
                messageId: panelMsg.id,
                verifyType,
                setBy:     interaction.user.id,
                createdAt: Date.now()
            }
        );
        await syncGuildConfig(interaction, role, channel, panelMsg);

        const resultEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setTitle(`${config.emojis.success} ติดตั้งแผงยืนยันสำเร็จ`)
            .addFields(
                { name: "📌 ช่อง",     value: `<#${channel.id}>`,  inline: true },
                { name: "🎭 ยศ",      value: `<@&${role.id}>`,     inline: true },
                { name: "🔒 ประเภท",  value: verifyType ? "🔐 OAuth2 ยืนยันตัวตน" : "✅ กดรับยศเลย", inline: true },
                { name: "🎨 Title",   value: title,                 inline: true },
                { name: "🖌️ Color",   value: colorHex,              inline: true },
                { name: "🕐 Timestamp", value: showTs ? "✅" : "❌", inline: true }
            )
            .setFooter({ text: `ตั้งค่าโดย ${interaction.user.tag}` })
            .setTimestamp();

        if (imageUrl)   resultEmbed.addFields({ name: "🖼️ Image",     value: imageUrl,     inline: false });
        if (thumbUrl)   resultEmbed.addFields({ name: "🖼️ Thumbnail", value: thumbUrl,     inline: false });
        if (footerText) resultEmbed.addFields({ name: "📝 Footer",    value: footerText,   inline: false });
        if (titleUrl)   resultEmbed.addFields({ name: "🔗 URL",       value: titleUrl,     inline: false });

        return interaction.editReply({ embeds: [resultEmbed] });

    } catch (err) {
        console.error(`[VERIFY] ❌ setup-verify failed: ${err.message}`);
        return interaction.editReply({ content: `> ${config.emojis.error} เกิดข้อผิดพลาด: ${err.message}\n> ตรวจสอบว่าบอทมีสิทธิ์ส่งข้อความในห้องนั้น` });
    }
}

async function handleVerifyButton(interaction) {
    const { customId, member, guild } = interaction;

    if (customId.startsWith("verify_role_")) {
        const roleId = customId.replace("verify_role_", "");
        const role   = guild.roles.cache.get(roleId);

        if (!role) return interaction.reply({ content: `> ${config.emojis.error} ไม่พบยศนี้แล้ว กรุณาแจ้ง Admin ตั้งค่าใหม่`, ephemeral: true });

        try {
            const hasRole = member.roles.cache.has(roleId);
            if (hasRole) {
                await member.roles.remove(roleId);
                const embed = new MessageEmbed().setColor(config.system.themeColors.error).setTitle("Removed Roles").setDescription(`- ${role.toString()} (user)`).setTimestamp();
                return interaction.reply({ embeds: [embed], ephemeral: true });
            } else {
                await member.roles.add(roleId);
                const embed = new MessageEmbed().setColor(config.system.themeColors.success).setTitle("Added Roles").setDescription(`+ ${role.toString()} (user)`).setTimestamp();
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
        } catch (err) {
            return interaction.reply({ content: `> ${config.emojis.error} ไม่สามารถจัดการยศได้: ${err.message}`, ephemeral: true });
        }
    }

    if (customId.startsWith("verify_oauth_")) {
        const roleId    = customId.replace("verify_oauth_", "");
        const baseUrl   = process.env.DASHBOARD_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3001";
        const nonce     = crypto.randomBytes(8).toString("hex");
        const stateCode = Buffer.from(`${guild.id}:${roleId}:${interaction.user.id}:${Date.now()}:${nonce}`).toString("base64url");
        const verifyUrl = `${baseUrl.replace(/\/$/, "")}/verify?t=${stateCode}`;

        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.info)
            .setTitle("🔐 ยืนยันตัวตนผ่าน Discord")
            .setDescription(`กดลิงก์ด้านล่างเพื่อเริ่มขั้นตอนยืนยันตัวตน\n\n> **[🔗 คลิกที่นี่เพื่อยืนยัน](${verifyUrl})**\n\n*ลิงก์จะหมดอายุใน 5 นาที — อย่าแชร์ให้ใคร*`)
            .setFooter({ text: "ระบบจะตรวจข้อมูลตามกฎของเซิร์ฟเวอร์หลัง Authorize" })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

module.exports = { handle, handleVerifyButton };
