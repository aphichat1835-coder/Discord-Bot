/*
================================================================================
Verification Command Module

verify_type:
- false = กดปุ่มได้ยศเลยแบบเดิม
- true  = OAuth2 direct Discord authorize URL button

Important:
- OAuth2 panel ใช้ LINK button เปิด discord.com/oauth2/authorize โดยตรง
- compact state เป็น long-lived สำหรับ panel ถาวร
- Service 2 ยังเช็ก HMAC signature + GuildConfig/role ล่าสุดตอน callback
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

const DEFAULT_PANEL = {
    content: "",
    title: "🔐 ยืนยันตัวตนเพื่อเข้าดิส",
    description:
        "กดปุ่มด้านล่างเพื่อยืนยันตัวตนผ่าน Discord OAuth2\n" +
        "ระบบจะตรวจสอบบัญชีและเพิ่มยศให้โดยอัตโนมัติเมื่อผ่านเงื่อนไข",
    color: "#5865F2",
    footer: "Discord Verification System",
    buttonLabelOAuth: "ยืนยันตัวตนเข้าดิส",
    buttonEmojiOAuth: "✅",
    buttonEmojiRole: "🎭"
};

function cleanText(value, fallback = "") {
    const v = typeof value === "string" ? value.trim() : "";
    return v || fallback;
}

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

function signStateData(data) {
    const secret = getStateSecret();

    if (!secret) {
        throw new Error("Missing VERIFY_STATE_SECRET/API_SECRET/ENCRYPTION_KEY");
    }

    return crypto
        .createHmac("sha256", secret)
        .update(data)
        .digest("base64url")
        .slice(0, 22);
}

function createCompactCallbackState({ guildId, roleId, expectedUserId = null }) {
    const user = expectedUserId || "0";

    /*
      ใช้ timestamp อนาคตไกลเพื่อให้ panel แบบ direct OAuth ไม่หมดอายุเอง
      ฝั่ง Service 2 จะยัง verify signature อยู่ และยังเช็ก GuildConfig/role ล่าสุดตอน callback
    */
    const ts = (Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toString(36);
    const nonce = crypto.randomBytes(6).toString("base64url");

    const data = `3|${guildId}|${roleId}|${user}|${ts}|${nonce}`;
    const sig = signStateData(data);

    return `3.${guildId}.${roleId}.${user}.${ts}.${nonce}.${sig}`;
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
    const state = createCompactCallbackState({ guildId, roleId, expectedUserId });

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: VERIFY_SCOPE,
        state,
        prompt: "consent"
    });

    const url = `https://discord.com/oauth2/authorize?${params.toString()}`;

    if (url.length > 512) {
        throw new Error(`OAuth URL too long (${url.length}/512). Use a shorter PUBLIC_DASHBOARD_URL domain.`);
    }

    return url;
}

function isLikelyUnicodeEmoji(raw) {
    if (!raw || typeof raw !== "string") return false;
    if (raw.length > 32) return false;

    // กันเคส :emoji_name: / ตัวอักษรธรรมดา / custom mention ที่ไม่ครบ ไม่ให้หลุดไปเป็น emoji.name แล้ว Discord reject
    if (/[A-Za-z0-9_:<>]/.test(raw)) return false;

    try {
        return /\p{Extended_Pictographic}/u.test(raw) || /[\u2600-\u27BF]/u.test(raw);
    } catch {
        return /[\u2600-\u27BF]/.test(raw);
    }
}

function getEmojiFromCache(client, query) {
    const raw = cleanText(query, "");
    if (!raw || !client?.emojis?.cache) return null;

    if (/^\d{17,22}$/.test(raw)) {
        const foundById = client.emojis.cache.get(raw);
        if (!foundById) return null;

        return {
            id: foundById.id,
            name: foundById.name,
            animated: !!foundById.animated
        };
    }

    const nameOnly = raw.match(/^:?(?<name>[A-Za-z0-9_]{2,32}):?$/)?.groups?.name;
    if (!nameOnly) return null;

    const foundByName = client.emojis.cache.find(e => e.name === nameOnly);
    if (!foundByName) return null;

    return {
        id: foundByName.id,
        name: foundByName.name,
        animated: !!foundByName.animated
    };
}

function parseButtonEmoji(input, fallback = null, client = null) {
    const raw = cleanText(input, fallback || "");

    if (!raw) return null;

    const custom = raw.match(/^<(?<animated>a?):(?<name>[A-Za-z0-9_]{2,32}):(?<id>\d{17,22})>$/);

    if (custom?.groups) {
        return {
            id: custom.groups.id,
            name: custom.groups.name,
            animated: custom.groups.animated === "a"
        };
    }

    const cachedCustom = getEmojiFromCache(client, raw);
    if (cachedCustom) return cachedCustom;

    if (isLikelyUnicodeEmoji(raw)) return raw;

    return null;
}

function emojiToDisplay(emoji, fallback = "") {
    if (!emoji) return cleanText(fallback, "");
    if (typeof emoji === "string") return emoji;
    if (emoji.id && emoji.name) return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
    return cleanText(fallback, "");
}

function resolveButtonEmoji(input, fallback, client) {
    const primary = parseButtonEmoji(input, null, client);
    if (primary) return primary;

    return parseButtonEmoji(fallback, null, client);
}

function applyEmoji(button, emojiInput, fallback, client) {
    const emoji = resolveButtonEmoji(emojiInput, fallback, client);

    if (!emoji) return button;

    try {
        return button.setEmoji(emoji);
    } catch (err) {
        console.warn("[VERIFY] Invalid button emoji ignored:", err.message);
        return button;
    }
}

function normalizeColor(input) {
    let colorHex = cleanText(input, DEFAULT_PANEL.color);

    if (!colorHex.startsWith("#")) colorHex = "#" + colorHex;

    if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
        return config?.system?.themeColors?.primary || DEFAULT_PANEL.color;
    }

    return colorHex;
}

async function syncGuildConfig(interaction, role, channel, panelMsg, panelData) {
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
                    "verification.oauthMode": panelData.verifyType
                        ? "direct-discord-authorize-long-lived-state"
                        : "direct-role",
                    "verification.directStateMode": "long-lived-panel",
                    "verification.updatedBy": interaction.user.id,
                    "verification.updatedAt": Date.now(),

                    "verification.panel.content": panelData.content || "",
                    "verification.panel.title": panelData.title,
                    "verification.panel.description": panelData.description,
                    "verification.panel.color": panelData.colorHex,
                    "verification.panel.imageUrl": panelData.imageUrl || null,
                    "verification.panel.thumbnailUrl": panelData.thumbUrl || null,
                    "verification.panel.footerText": panelData.footerText || null,
                    "verification.panel.titleUrl": panelData.titleUrl || null,
                    "verification.panel.showTimestamp": !!panelData.showTs,
                    "verification.panel.buttonLabel": panelData.buttonLabel,
                    "verification.panel.buttonEmoji": panelData.buttonEmoji,
                    "verification.panel.verifyType": panelData.verifyType ? "oauth2" : "direct-role"
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

    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");

    const verifyType = interaction.options.getBoolean("verify_type") ?? true;

    const content = cleanText(interaction.options.getString("content"), DEFAULT_PANEL.content);
    const title = cleanText(interaction.options.getString("title"), DEFAULT_PANEL.title);
    const description = cleanText(interaction.options.getString("description"), DEFAULT_PANEL.description);
    const colorHex = normalizeColor(interaction.options.getString("color"));
    const imageUrl = cleanText(interaction.options.getString("image"), null);
    const thumbUrl = cleanText(interaction.options.getString("thumbnail"), null);
    const footerText = cleanText(interaction.options.getString("footer"), DEFAULT_PANEL.footer);
    const showTs = interaction.options.getBoolean("timestamp") ?? false;
    const titleUrl = cleanText(interaction.options.getString("url"), null);

    const buttonLabelInput = cleanText(
        interaction.options.getString("button_label"),
        verifyType ? DEFAULT_PANEL.buttonLabelOAuth : `รับยศ ${role.name}`
    );

    const buttonEmojiInput = cleanText(
        interaction.options.getString("button_emoji"),
        verifyType ? DEFAULT_PANEL.buttonEmojiOAuth : DEFAULT_PANEL.buttonEmojiRole
    );

    const buttonLabel = buttonLabelInput.slice(0, 80);
    const resolvedButtonEmoji = resolveButtonEmoji(
        buttonEmojiInput,
        verifyType ? DEFAULT_PANEL.buttonEmojiOAuth : DEFAULT_PANEL.buttonEmojiRole,
        interaction.client
    );
    const buttonEmojiDisplay = emojiToDisplay(
        resolvedButtonEmoji,
        verifyType ? DEFAULT_PANEL.buttonEmojiOAuth : DEFAULT_PANEL.buttonEmojiRole
    );
    const usedEmojiFallback = !!buttonEmojiInput && buttonEmojiDisplay !== buttonEmojiInput;

    if (!channel?.isText?.()) {
        return interaction.editReply({
            content: `> ${config.emojis.error} กรุณาเลือกห้องข้อความเท่านั้น`
        });
    }

    const embed = new MessageEmbed()
        .setColor(colorHex)
        .setTitle(title)
        .setDescription(description);

    if (titleUrl) embed.setURL(titleUrl);
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
                    `> ตรวจ PUBLIC_DASHBOARD_URL, VERIFY_STATE_SECRET, DISCORD_CLIENT_ID และความยาว domain`
            });
        }

        const button = new MessageButton()
            .setStyle("LINK")
            .setURL(authorizeUrl)
            .setLabel(buttonLabel);

        row.addComponents(applyEmoji(button, buttonEmojiInput, DEFAULT_PANEL.buttonEmojiOAuth, interaction.client));
    } else {
        const button = new MessageButton()
            .setCustomId(`verify_role_${role.id}`)
            .setLabel(buttonLabel)
            .setStyle("SUCCESS");

        row.addComponents(applyEmoji(button, buttonEmojiInput, DEFAULT_PANEL.buttonEmojiRole, interaction.client));
    }

    try {
        const panelPayload = {
            embeds: [embed],
            components: [row]
        };

        if (content) panelPayload.content = content;

        const panelMsg = await channel.send(panelPayload);

        await sessionManager.setSetting(`verify_config_${interaction.guild.id}_${role.id}`, {
            roleId: role.id,
            roleName: role.name,
            guildId: interaction.guild.id,
            channelId: channel.id,
            messageId: panelMsg.id,
            verifyType,
            oauthMode: verifyType ? "direct-discord-authorize-long-lived-state" : "direct-role",
            panel: {
                content,
                title,
                description,
                color: colorHex,
                imageUrl,
                thumbnailUrl: thumbUrl,
                footerText,
                titleUrl,
                showTimestamp: showTs,
                buttonLabel,
                buttonEmoji: buttonEmojiDisplay
            },
            setBy: interaction.user.id,
            updatedAt: Date.now(),
            createdAt: Date.now()
        });

        await syncGuildConfig(interaction, role, channel, panelMsg, {
            verifyType,
            content,
            title,
            description,
            colorHex,
            imageUrl,
            thumbUrl,
            footerText,
            titleUrl,
            showTs,
            buttonLabel,
            buttonEmoji: buttonEmojiDisplay
        });

        const resultEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setTitle(`${config.emojis.success} ติดตั้งแผงยืนยันสำเร็จ`)
            .setDescription(
                `แผงยืนยันถูกส่งไปที่ <#${channel.id}> แล้ว\n` +
                `ปุ่ม OAuth จะเปิดหน้าอนุญาต Discord โดยตรง และไม่หมดอายุเองจากอายุ state` +
                (usedEmojiFallback ? `\n\n⚠️ Emoji ที่กรอกไม่ถูกต้องหรือบอทมองไม่เห็น จึงใช้ emoji สำรองแทน` : "")
            )
            .addFields(
                { name: "📌 ช่อง", value: `<#${channel.id}>`, inline: true },
                { name: "🎭 ยศ", value: `<@&${role.id}>`, inline: true },
                { name: "🔒 ประเภท", value: verifyType ? "OAuth2 Direct Authorize" : "กดรับยศทันที", inline: true },
                { name: "🧩 ปุ่ม", value: `${buttonEmojiDisplay || ""} ${buttonLabel}`, inline: true },
                { name: "🎨 สี", value: colorHex, inline: true },
                { name: "🕐 เวลา", value: showTs ? "เปิด" : "ปิด", inline: true }
            )
            .setFooter({ text: `ตั้งค่าโดย ${interaction.user.tag}` })
            .setTimestamp();

        return interaction.editReply({ embeds: [resultEmbed] });

    } catch (err) {
        console.error(`[VERIFY] ❌ setup-verify failed: ${err.message}`);

        return interaction.editReply({
            content:
                `> ${config.emojis.error} เกิดข้อผิดพลาด: ${err.message}\n` +
                `> ตรวจสอบว่าบอทมีสิทธิ์ส่งข้อความในห้องนั้น และ URL/Emoji ถูกต้อง`
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
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId);

                return interaction.reply({
                    embeds: [
                        new MessageEmbed()
                            .setColor(config.system.themeColors.error)
                            .setTitle("Removed Roles")
                            .setDescription(`- ${role.toString()} (user)`)
                            .setTimestamp()
                    ],
                    ephemeral: true
                });
            }

            await member.roles.add(roleId);

            return interaction.reply({
                embeds: [
                    new MessageEmbed()
                        .setColor(config.system.themeColors.success)
                        .setTitle("Added Roles")
                        .setDescription(`+ ${role.toString()} (user)`)
                        .setTimestamp()
                ],
                ephemeral: true
            });

        } catch (err) {
            return interaction.reply({
                content: `> ${config.emojis.error} ไม่สามารถจัดการยศได้: ${err.message}`,
                ephemeral: true
            });
        }
    }

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
