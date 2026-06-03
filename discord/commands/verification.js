/*
================================================================================
  Verification Command Module — Dashboard Public v2 compatible

  verify_type:
  - false = กดปุ่มได้ยศเลยแบบเดิม
  - true  = OAuth2 direct Discord authorize URL button

  Notes:
  - รองรับ option ใหม่ button_text เช่น "✅ ยืนยันตัวตนเข้าดิส"
  - ยังรองรับ option เดิม button_label / button_emoji เผื่อคำสั่งเก่ายัง cache อยู่
  - ถ้า emoji ใช้ไม่ได้ ระบบ fallback โดยไม่ทำให้คำสั่งพัง
  - Sync GuildConfig ให้หน้า Dashboard อิงแผงล่าสุดจาก Discord ได้ตรงขึ้น
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
    oauthButtonText: "✅ ยืนยันตัวตนเข้าดิส",
    directButtonText: "🎭 รับยศ"
};

function cleanText(value, fallback = "") {
    const v = typeof value === "string" ? value.trim() : "";
    return v || fallback;
}

function normalizeNewlines(value) {
    return cleanText(value, "").replace(/\\n/g, "\n");
}

function boolToDashboardVerifyType(value) {
    return value ? "oauth" : "direct";
}

function boolToLegacyOauthMode(value) {
    return value ? "direct-discord-authorize-long-lived-state" : "direct-role";
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
        process.env.PUBLIC_BASE_URL ||
        process.env.DASHBOARD_PUBLIC_URL ||
        process.env.RENDER_EXTERNAL_URL ||
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

    // long-lived panel state: ไม่หมดอายุเองง่าย ๆ แต่ยังตรวจ HMAC signature ฝั่ง callback
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
        throw new Error("Missing PUBLIC_DASHBOARD_URL/DASHBOARD_URL/PUBLIC_BASE_URL");
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

    // กันเคส :emoji_name: / ตัวอักษรธรรมดา / custom mention ที่ไม่ครบ
    if (/[A-Za-z0-9_:<>]/.test(raw)) return false;

    try {
        return /\p{Extended_Pictographic}/u.test(raw) || /[\u2600-\u27BF]/.test(raw);
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
function extractButtonTextParts(rawText, fallbackText, client) {
    const raw = cleanText(rawText, fallbackText);

    const customMatch = raw.match(
        /^(<a?:[A-Za-z0-9_]{2,32}:\d{17,22}>|\d{17,22}|:[A-Za-z0-9_]{2,32}:|[\u2600-\u27BF]\uFE0F?|\p{Extended_Pictographic}\uFE0F?)\s*(.*)$/u
    );

    if (customMatch) {
        const emojiCandidate = customMatch[1];
        const labelCandidate = cleanText(customMatch[2], "ยืนยันตัวตนเข้าดิส");
        const emoji = parseButtonEmoji(emojiCandidate, null, client);

        if (emoji) {
            return {
                label: labelCandidate.slice(0, 80),
                emojiInput: emojiCandidate,
                emojiDisplay: emojiToDisplay(emoji, emojiCandidate),
                usedFallback: false
            };
        }
    }

    return {
        label: raw.slice(0, 80),
        emojiInput: null,
        emojiDisplay: "",
        usedFallback: false
    };
}

function normalizeColor(input) {
    let colorHex = cleanText(input, DEFAULT_PANEL.color);

    if (!colorHex.startsWith("#")) colorHex = "#" + colorHex;

    if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
        return config?.system?.themeColors?.primary || DEFAULT_PANEL.color;
    }

    return colorHex.toUpperCase();
}

async function syncGuildConfig(interaction, role, channel, panelMsg, panelData) {
    if (!GuildConfig) return;

    const dashboardVerifyType = boolToDashboardVerifyType(panelData.verifyType);
    const legacyOauthMode = boolToLegacyOauthMode(panelData.verifyType);

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
                    "verification.channelName": channel.name,
                    "verification.messageId": panelMsg.id,

                    "verification.verifyPath": "/auth/callback",
                    "verification.verifyType": dashboardVerifyType,
                    "verification.oauthMode": dashboardVerifyType,
                    "verification.legacyOauthMode": legacyOauthMode,
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

                    "verification.panel.buttonText": panelData.buttonLabel,
                    "verification.panel.buttonLabel": panelData.buttonLabel,
                    "verification.panel.buttonEmoji": panelData.buttonEmoji,

                    "verification.panel.verifyType": dashboardVerifyType,
                    "verification.panel.legacyVerifyType": panelData.verifyType ? "oauth2" : "direct-role"
                },
                $setOnInsert: {
                    createdAt: Date.now(),

                    "verification.blockVPN": true,
                    "verification.minAccountAgeDays": 7,
                    "verification.requireEmail": false,
                    "verification.requireEmailVerified": false,
                    "verification.requireConnections": false,
                    "verification.minConnections": 1,

                    "security.storeOAuthTokens": false,
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

    const content = normalizeNewlines(interaction.options.getString("content")) || DEFAULT_PANEL.content;
    const title = normalizeNewlines(interaction.options.getString("title")) || DEFAULT_PANEL.title;
    const description = normalizeNewlines(interaction.options.getString("description")) || DEFAULT_PANEL.description;
    const colorHex = normalizeColor(interaction.options.getString("color"));
    const imageUrl = cleanText(interaction.options.getString("image"), null);
    const thumbUrl = cleanText(interaction.options.getString("thumbnail"), null);
    const footerText = normalizeNewlines(interaction.options.getString("footer")) || DEFAULT_PANEL.footer;
    const showTs = interaction.options.getBoolean("timestamp") ?? false;
    const titleUrl = cleanText(interaction.options.getString("url"), null);

    /*
      รองรับทั้ง option ใหม่และเก่า:
      - ใหม่: button_text = "✅ ยืนยันตัวตนเข้าดิส"
      - เก่า: button_label + button_emoji
    */
    const newButtonText = interaction.options.getString("button_text");
    const oldButtonLabel = interaction.options.getString("button_label");
    const oldButtonEmoji = interaction.options.getString("button_emoji");

    const fallbackButtonText = verifyType
        ? DEFAULT_PANEL.oauthButtonText
        : `${DEFAULT_PANEL.directButtonText} ${role.name}`;

    let buttonParts;

    if (newButtonText) {
        buttonParts = extractButtonTextParts(newButtonText, fallbackButtonText, interaction.client);
    } else {
        const label = cleanText(
            oldButtonLabel,
            verifyType ? "ยืนยันตัวตนเข้าดิส" : `รับยศ ${role.name}`
        );

        const emojiInput = cleanText(
            oldButtonEmoji,
            verifyType ? "✅" : "🎭"
        );

        const resolved = resolveButtonEmoji(
            emojiInput,
            verifyType ? "✅" : "🎭",
            interaction.client
        );

        buttonParts = {
            label: label.slice(0, 80),
            emojiInput,
            emojiDisplay: emojiToDisplay(resolved, emojiInput),
            usedFallback: !!emojiInput && emojiToDisplay(resolved, emojiInput) !== emojiInput
        };
    }

    if (!channel?.isText?.()) {
        return interaction.editReply({
            content: `> ${config.emojis.error} กรุณาเลือกห้องข้อความเท่านั้น`
        });
    }

    const botMember = interaction.guild.me;
    const sendPerms = channel.permissionsFor(botMember);

    if (!sendPerms?.has("SEND_MESSAGES") || !sendPerms?.has("EMBED_LINKS")) {
        return interaction.editReply({
            content:
                `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความหรือ Embed ในห้อง <#${channel.id}>\n` +
                `> เปิดสิทธิ์ Send Messages และ Embed Links ให้บอทก่อน`
        });
    }

    if (role.managed) {
        return interaction.editReply({
            content: `> ${config.emojis.error} ยศนี้เป็น managed role ไม่สามารถให้ด้วยบอทได้`
        });
    }

    if (botMember?.roles?.highest && role.position >= botMember.roles.highest.position) {
        return interaction.editReply({
            content:
                `> ${config.emojis.error} ยศ <@&${role.id}> สูงกว่าหรือเท่ากับยศสูงสุดของบอท\n` +
                `> ให้ลากยศบอทขึ้นเหนือยศที่จะให้ก่อน`
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
            .setLabel(buttonParts.label);

        row.addComponents(
            applyEmoji(button, buttonParts.emojiInput, "✅", interaction.client)
        );
    } else {
        const button = new MessageButton()
            .setCustomId(`verify_role_${role.id}`)
            .setLabel(buttonParts.label)
            .setStyle("SUCCESS");

        row.addComponents(
            applyEmoji(button, buttonParts.emojiInput, "🎭", interaction.client)
        );
    }
        try {
        const panelPayload = {
            embeds: [embed],
            components: [row]
        };

        if (content) {
            panelPayload.content = content;
        }

        const panelMsg = await channel.send(panelPayload);

        const dashboardVerifyType = boolToDashboardVerifyType(verifyType);
        const legacyOauthMode = boolToLegacyOauthMode(verifyType);

        await sessionManager.setSetting(`verify_config_${interaction.guild.id}_${role.id}`, {
            roleId: role.id,
            roleName: role.name,
            guildId: interaction.guild.id,
            guildName: interaction.guild.name,
            channelId: channel.id,
            channelName: channel.name,
            messageId: panelMsg.id,

            verifyType,
            dashboardVerifyType,
            oauthMode: dashboardVerifyType,
            legacyOauthMode,

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

                buttonText: buttonParts.label,
                buttonLabel: buttonParts.label,
                buttonEmoji: buttonParts.emojiDisplay,

                verifyType: dashboardVerifyType,
                legacyVerifyType: verifyType ? "oauth2" : "direct-role"
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
            buttonLabel: buttonParts.label,
            buttonEmoji: buttonParts.emojiDisplay
        });

        const resultEmbed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setTitle(`${config.emojis.success} ติดตั้งแผงยืนยันสำเร็จ`)
            .setDescription(
                `แผงยืนยันถูกส่งไปที่ <#${channel.id}> แล้ว\n` +
                `ระบบบันทึกการตั้งค่าและพร้อมให้สมาชิกยืนยันตัวตน`
            )
            .addFields(
                {
                    name: "📌 ช่อง",
                    value: `<#${channel.id}>`,
                    inline: true
                },
                {
                    name: "🎭 ยศ",
                    value: `<@&${role.id}>`,
                    inline: true
                },
                {
                    name: "🔒 ประเภท",
                    value: verifyType ? "OAuth2 Direct Authorize" : "กดรับยศทันที",
                    inline: true
                },
                {
                    name: "🧩 ปุ่ม",
                    value: `${buttonParts.emojiDisplay || ""} ${buttonParts.label}`.trim(),
                    inline: false
                },
                {
                    name: "🎨 สี",
                    value: colorHex,
                    inline: true
                },
                {
                    name: "🕐 เวลา",
                    value: showTs ? "เปิด" : "ปิด",
                    inline: true
                },
                {
                    name: "🆔 Message ID",
                    value: `\`${panelMsg.id}\``,
                    inline: false
                }
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
                return interaction.reply({
                    content: `> ${config.emojis.success} คุณมียศ ${role.toString()} อยู่แล้ว`,
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
