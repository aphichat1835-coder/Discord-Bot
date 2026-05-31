/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: handle, handleVerifyButton exports.

verify_type:
- false = กดปุ่มได้ยศเลยแบบเดิม
- true  = OAuth2 direct Discord authorize URL button

Important:
- OAuth2 panel ใหม่ต้องใช้ LINK button เท่านั้น
- ปุ่ม OAuth ต้องเปิด discord.com/oauth2/authorize โดยตรง
- ห้ามให้ user กดแล้วบอท reply ลิงก์อีกชั้นสำหรับ panel ใหม่
- handleVerifyButton ยังเก็บ verify_oauth_ ไว้เพื่อ legacy panel เก่าเท่านั้น
================================================================================
*/

const crypto = require("crypto");
const { MessageEmbed, MessageActionRow, MessageButton } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");

let GuildConfig = null;
try {
    GuildConfig = require("../../dashboard-public/models/GuildConfig");
} catch (err) {
    console.warn("[VERIFY] GuildConfig model unavailable:", err.message);
}

const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";

function getStateSecret() {
    return String(
        process.env.VERIFY_STATE_SECRET ||
        process.env.API_SECRET ||
        process.env.INTERNAL_API_SECRET ||
        process.env.SESSION_SECRET ||
        process.env.ENCRYPTION_KEY ||
        ""
    );
}

function getDashboardUrl() {
    return String(
        process.env.PUBLIC_DASHBOARD_URL ||
        process.env.DASHBOARD_URL ||
        ""
    ).replace(/\/$/, "");
}

function getDiscordClientId(interaction) {
    return String(
        process.env.DISCORD_CLIENT_ID ||
        config?.discord?.clientId ||
        config?.system?.clientId ||
        interaction?.client?.application?.id ||
        interaction?.client?.user?.id ||
        ""
    );
}

function b64url(input) {
    return Buffer.from(input).toString("base64url");
}

function signPayload(encodedPayload) {
    const secret = getStateSecret();

    if (!secret) {
        throw new Error("Missing VERIFY_STATE_SECRET/API_SECRET/ENCRYPTION_KEY for verify state signing");
    }

    return crypto
        .createHmac("sha256", secret)
        .update(encodedPayload)
        .digest("base64url");
}

function createSignedState(payload) {
    const encoded = b64url(JSON.stringify(payload));
    return `${encoded}.${signPayload(encoded)}`;
}

/**
 * State สำหรับ Discord OAuth callback โดยตรง
 * LINK button เป็น static จึงยังไม่รู้ userId ตอนสร้าง panel
 * userId จะรู้ตอน Discord redirect กลับ /auth/callback
 */
function createCallbackState({ guildId, roleId, expectedUserId = null }) {
    return createSignedState({
        v: 3,
        type: "verify-callback",
        guildId,
        roleId,
        expectedUserId,
        ts: Date.now(),
        nonce: crypto.randomBytes(16).toString("hex")
    });
}

/**
 * Legacy state สำหรับปุ่มเก่า verify_oauth_
 * ใช้เฉพาะ panel เก่าที่เคยสร้างไว้ก่อนเปลี่ยนเป็น LINK button
 */
function createLegacyUserVerifyState({ guildId, roleId, userId }) {
    return createSignedState({
        v: 2,
        type: "verify-callback",
        guildId,
        roleId,
        expectedUserId: userId,
        ts: Date.now(),
        nonce: crypto.randomBytes(16).toString("hex")
    });
}

function buildDiscordAuthorizeUrl({ interaction, guildId, roleId, expectedUserId = null }) {
    const dashboardUrl = getDashboardUrl();
    const clientId = getDiscordClientId(interaction);

    if (!dashboardUrl) {
        throw new Error("Missing PUBLIC_DASHBOARD_URL/DASHBOARD_URL");
    }

    if (!clientId) {
        throw new Error("Missing DISCORD_CLIENT_ID/Application ID");
    }

    const redirectUri = `${dashboardUrl}/auth/callback`;
    const state = createCallbackState({ guildId, roleId, expectedUserId });

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: VERIFY_SCOPE,
        state,
        prompt: "consent"
    });

    return `https://discord.com/oauth2/authorize?${params.toString()}`;
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

                    "verification.enabled": true,
                    "verification.roleId": role.id,
                    "verification.roleName": role.name,
                    "verification.channelId": channel.id,
                    "verification.messageId": panelMsg.id,
                    "verification.verifyPath": "/auth/callback",
                    "verification.oauthMode": "direct-discord-authorize",
                    "verification.updatedBy": interaction.user.id,
                    "verification.updatedAt": Date.now()
                },
                $setOnInsert: {
                    createdAt: Date.now(),

                    "verification.blockVPN": true,
                    "verification.minAccountAgeDays": 7,
                    "verification.requireEmail": false,
                    "verification.requireEmailVerified": false,
                    "verification.requireConnections": false,
                    "verification.minConnections": 1,

                    "security.storeOAuthTokens": true,
                    "security.storeRawIpEncrypted": true,
                    "security.ipRevealRequiresOwnerApproval": true,
                    "security.retentionMode": "until_admin_delete"
                }
            },
            { upsert: true }
        );
    } catch (err) {
        console.error("[VERIFY] GuildConfig sync failed:", err.message);
    }
}

async function handle(interaction, client) {
    if (interaction.commandName === "setup-verify") {
        return handleSetupVerify(interaction);
    }
}

async function handleSetupVerify(interaction) {
    if (!interaction.member.permissions.has("ADMINISTRATOR")) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} ต้องเป็น Administrator`,
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel     = interaction.options.getChannel("channel");
    const role        = interaction.options.getRole("role");
    const verifyType  = interaction.options.getBoolean("verify_type") ?? false;

    const title       = interaction.options.getString("title")        || "ยืนยันตัวตนเพื่อเข้าดิส";
    const description = interaction.options.getString("description")  || "กดปุ่มด้านล่างเพื่อเริ่มขั้นตอนยืนยันตัวตน";
    const colorInput  = interaction.options.getString("color")        || config.system.themeColors.primary;
    const imageUrl    = interaction.options.getString("image")        || null;
    const thumbUrl    = interaction.options.getString("thumbnail")    || null;
    const footerText  = interaction.options.getString("footer")       || null;
    const showTs      = interaction.options.getBoolean("timestamp")   ?? false;
    const titleUrl    = interaction.options.getString("url")          || null;

    if (!channel.isText()) {
        return interaction.editReply({
            content: `> ${config.emojis.error} กรุณาเลือกห้องข้อความเท่านั้น`
        });
    }

    let colorHex = colorInput.trim();
    if (!colorHex.startsWith("#")) colorHex = "#" + colorHex;
    if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
        colorHex = config.system.themeColors.primary;
    }

    const embed = new MessageEmbed()
        .setColor(colorHex)
        .setTitle(title);

    if (titleUrl) embed.setURL(titleUrl);
    if (description) embed.setDescription(description);
    if (imageUrl) embed.setImage(imageUrl);
    if (thumbUrl) embed.setThumbnail(thumbUrl);
    if (footerText) embed.setFooter({ text: footerText });
    if (showTs) embed.setTimestamp();

    const row = new MessageActionRow();

    if (verifyType) {
        let authorizeUrl;

        try {
            authorizeUrl = buildDiscordAuthorizeUrl({
                interaction,
                guildId: interaction.guild.id,
                roleId: role.id
            });
        } catch (err) {
            console.error("[VERIFY] Direct OAuth URL build failed:", err.message);

            return interaction.editReply({
                content:
                    `> ${config.emojis.error} สร้างลิงก์ OAuth ไม่สำเร็จ: ${err.message}\n` +
                    `> ต้องตั้ง PUBLIC_DASHBOARD_URL, VERIFY_STATE_SECRET และถ้าจำเป็นให้ตั้ง DISCORD_CLIENT_ID ด้วย`
            });
        }

        row.addComponents(
            new MessageButton()
                .setStyle("LINK")
                .setURL(authorizeUrl)
                .setLabel("✅ ยืนยันตัวตนเข้าดิส")
                .setEmoji("✅")
        );
    } else {
        row.addComponents(
            new MessageButton()
                .setCustomId(`verify_role_${role.id}`)
                .setLabel(`" ${role.name} "`)
                .setEmoji("🎭")
                .setStyle("SUCCESS")
        );
    }

    try {
        const panelMsg = await channel.send({
            embeds: [embed],
            components: [row]
        });

        await sessionManager.setSetting(
            `verify_config_${interaction.guild.id}_${role.id}`,
            {
                roleId: role.id,
                roleName: role.name,
                guildId: interaction.guild.id,
                channelId: channel.id,
                messageId: panelMsg.id,
                verifyType,
                oauthMode: verifyType ? "direct-discord-authorize" : "direct-role",
                setBy: interaction.user.id,
                updatedAt: Date.now(),
                createdAt: Date.now()
            }
        );

        await syncGuildConfig(interaction, role, channel, panelMsg);

        const resultEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setTitle(`${config.emojis.success} ติดตั้งแผงยืนยันสำเร็จ`)
            .addFields(
                { name: "📌 ช่อง", value: `<#${channel.id}>`, inline: true },
                { name: "🎭 ยศ", value: `<@&${role.id}>`, inline: true },
                {
                    name: "🔒 ประเภท",
                    value: verifyType
                        ? "🔐 OAuth2 Direct Discord Authorize"
                        : "✅ กดรับยศเลย",
                    inline: true
                },
                { name: "🎨 Title", value: title, inline: true },
                { name: "🖌️ Color", value: colorHex, inline: true },
                { name: "🕐 Timestamp", value: showTs ? "✅" : "❌", inline: true }
            )
            .setFooter({ text: `ตั้งค่าโดย ${interaction.user.tag}` })
            .setTimestamp();

        if (verifyType) {
            resultEmbed.addFields({
                name: "🌐 Flow",
                value:
                    "กดปุ่ม → Discord OAuth authorize → เว็บประมวลผล → สำเร็จ/ล้มเหลว\n" +
                    "ปุ่มจะเปิดหน้า Discord โดยตรง ไม่ผ่าน /verify ก่อนแล้ว",
                inline: false
            });
        }

        if (imageUrl) resultEmbed.addFields({ name: "🖼️ Image", value: imageUrl, inline: false });
        if (thumbUrl) resultEmbed.addFields({ name: "🖼️ Thumbnail", value: thumbUrl, inline: false });
        if (footerText) resultEmbed.addFields({ name: "📝 Footer", value: footerText, inline: false });
        if (titleUrl) resultEmbed.addFields({ name: "🔗 URL", value: titleUrl, inline: false });

        return interaction.editReply({ embeds: [resultEmbed] });

    } catch (err) {
        console.error(`[VERIFY] ❌ setup-verify failed: ${err.message}`);

        return interaction.editReply({
            content:
                `> ${config.emojis.error} เกิดข้อผิดพลาด: ${err.message}\n` +
                `> ตรวจสอบว่าบอทมีสิทธิ์ส่งข้อความในห้องนั้น`
        });
    }
}

async function handleVerifyButton(interaction) {
    const { customId, member, guild } = interaction;

    if (customId.startsWith("verify_role_")) {
        const roleId = customId.replace("verify_role_", "");
        const role = guild.roles.cache.get(roleId);

        if (!role) {
            return interaction.reply({
                content: `> ${config.emojis.error} ไม่พบยศนี้แล้ว กรุณาแจ้ง Admin ตั้งค่าใหม่`,
                ephemeral: true
            });
        }

        try {
            const hasRole = member.roles.cache.has(roleId);

            if (hasRole) {
                await member.roles.remove(roleId);

                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.error)
                    .setTitle("Removed Roles")
                    .setDescription(`- ${role.toString()} (user)`)
                    .setTimestamp();

                return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            await member.roles.add(roleId);

            const embed = new MessageEmbed()
                .setColor(config.system.themeColors.success)
                .setTitle("Added Roles")
                .setDescription(`+ ${role.toString()} (user)`)
                .setTimestamp();

            return interaction.reply({ embeds: [embed], ephemeral: true });

        } catch (err) {
            return interaction.reply({
                content: `> ${config.emojis.error} ไม่สามารถจัดการยศได้: ${err.message}`,
                ephemeral: true
            });
        }
    }

    /**
     * Legacy panel เก่าเท่านั้น
     * Panel ใหม่จะไม่เข้า branch นี้แล้ว เพราะใช้ LINK button ไป Discord authorize ตรง ๆ
     */
    if (customId.startsWith("verify_oauth_")) {
        const roleId = customId.replace("verify_oauth_", "");

        let authorizeUrl;

        try {
            authorizeUrl = buildDiscordAuthorizeUrl({
                interaction,
                guildId: guild.id,
                roleId,
                expectedUserId: interaction.user.id
            });
        } catch (err) {
            console.error("[VERIFY] Legacy direct OAuth URL build failed:", err.message);

            return interaction.reply({
                content: `> ${config.emojis.error} สร้างลิงก์ OAuth ไม่สำเร็จ: ${err.message}`,
                ephemeral: true
            });
        }

        return interaction.reply({
            content:
                `> แผงนี้เป็นแผงเก่า กรุณาให้แอดมินสร้างแผงใหม่\n` +
                `> [คลิกเพื่อยืนยันตัวตน](${authorizeUrl})`,
            ephemeral: true
        });
    }
}

module.exports = {
    handle,
    handleVerifyButton
};
