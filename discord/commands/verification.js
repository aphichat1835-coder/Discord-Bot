/* eslint-disable complexity -- Verification setup flow is behavior-sensitive; refactor separately. */
/*
================================================================================
  Verification Command Module — unified runtime compatible

  verify_type:
  - false = กดปุ่มได้ยศเลยแบบเดิม
  - true  = OAuth2 direct Discord authorize URL button

  Updates:
  - รองรับ option ใหม่ button_text เช่น "✅ ยืนยันตัวตนเข้าดิส"
  - ยังรองรับ option เดิม button_label / button_emoji เผื่อคำสั่งเก่ายัง cache อยู่
  - ถ้า emoji ใช้ไม่ได้ ระบบ fallback โดยไม่ทำให้คำสั่งพัง
  - Sync GuildConfig ให้หน้า Dashboard อิงแผงล่าสุดจาก Discord ได้ตรงขึ้น
  - OAuth panel จาก /setup-verify ใช้ state v4 + panelRevision แล้ว
  - Legacy verify_oauth_ button ไม่สร้าง OAuth URL ต่อแล้ว เพื่อกันแผงเก่าชน panelRevision
================================================================================
*/

const { PermissionFlagsBits } = require("discord.js");
const crypto = require("node:crypto");
const { MessageEmbed, MessageActionRow, MessageButton } = require("../core/discordCompat");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const { createCompactCallbackState } = require("../verification/utils/state");
const { resolvePublicBaseUrl } = require("../core/publicUrl");
const { markCommandAccepted } = require("../guards/commandGuards");
const { sendWebhookEvent, getDiscordGuildIconUrl } = require("../core/webhooks");

let GuildConfig = null;

try {
    GuildConfig = require("../verification/models/GuildConfig");
} catch (err) {
    console.warn("[VERIFY] GuildConfig model unavailable:", err.message);
}

const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";
const PANEL_LIMITS = Object.freeze({ content: 2000, title: 256, description: 4096, footer: 2048, url: 2048 });
const PERSIST_RETRY_DELAYS_MS = Object.freeze([0, 150, 400]);
const SNOWFLAKE_RE = /^\d{17,22}$/;

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

function strictSnowflake(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return SNOWFLAKE_RE.test(normalized) ? normalized : null;
}

function normalizeNewlines(value) {
    return cleanText(value, "").replace(/\\n/g, "\n");
}

function validatePanelText(value, field, maxLength) {
    if (String(value || "").length <= maxLength) return;
    const err = new Error("PANEL_INPUT_TOO_LONG");
    err.safeMessage = `${field} ยาวเกิน ${maxLength} ตัวอักษร`;
    throw err;
}

function cleanHttpsUrl(value, field) {
    const raw = cleanText(value, null);
    if (!raw) return null;
    validatePanelText(raw, field, PANEL_LIMITS.url);
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
        return parsed.toString();
    } catch {
        const err = new Error("PANEL_URL_INVALID");
        err.safeMessage = `${field} ต้องเป็นลิงก์ HTTPS ที่ถูกต้อง`;
        throw err;
    }
}

async function retryPersistence(operation) {
    let lastError = null;
    for (const delay of PERSIST_RETRY_DELAYS_MS) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        try {
            const result = await operation();
            if (result === false || result === null) throw new Error("PERSIST_RETURNED_FALSE");
            return result;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error("PERSIST_FAILED");
}

async function resolveGuildBotMember(guild, client) {
    if (!guild) return null;
    if (guild.members?.me) return guild.members.me;
    if (guild.me) return guild.me;

    const botId = client?.user?.id || guild.client?.user?.id;
    if (!botId) return null;

    return guild.members?.cache?.get(botId) ||
        await guild.members?.fetch?.(botId).catch(() => null) ||
        null;
}

function validateDirectRoleAssignment(botMember, role) {
    if (!botMember) return { ok: false, reason: "ไม่พบข้อมูลบอทในเซิร์ฟเวอร์" };
    if (!botMember.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return { ok: false, reason: "บอทไม่มีสิทธิ์ Manage Roles" };
    if (!role) return { ok: false, reason: "ไม่พบยศนี้แล้ว กรุณาแจ้ง Admin ตั้งค่าใหม่" };
    if (role.managed) return { ok: false, reason: "ยศนี้เป็น managed role ไม่สามารถมอบให้อัตโนมัติได้" };
    if (botMember.roles?.highest && role.position >= botMember.roles.highest.position) {
        return { ok: false, reason: "ยศนี้อยู่สูงกว่าหรือเท่ากับยศบอท กรุณาให้ Admin ตั้งค่า role hierarchy ใหม่" };
    }

    return { ok: true };
}

function boolToDashboardVerifyType(value) {
    return value ? "oauth" : "direct";
}

function boolToLegacyOauthMode(value) {
    return value ? "direct-discord-authorize-long-lived-state" : "direct-role";
}

function getDashboardUrl() {
    return resolvePublicBaseUrl(process.env, process.env.RENDER_EXTERNAL_URL || "");
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

function makePanelRevision(prefix = "panel") {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

function buildDiscordAuthorizeUrl({
    interaction,
    guildId,
    roleId,
    expectedUserId = null,
    panelRevision = null
}) {
    const dashboardUrl = getDashboardUrl();
    const clientId = getDiscordClientId(interaction);

    if (!dashboardUrl) {
        throw new Error("Missing PUBLIC_DASHBOARD_URL/DASHBOARD_URL/PUBLIC_BASE_URL");
    }

    if (!clientId) {
        throw new Error("Missing DISCORD_CLIENT_ID/Application ID");
    }

    const panelState = createCompactCallbackState({
        guildId,
        roleId,
        expectedUserId,
        panelRevision
    });

    const url = `${dashboardUrl}/auth/start?state=${encodeURIComponent(panelState)}`;

    if (url.length > 512) {
        throw new Error(`OAuth URL too long (${url.length}/512). Use a shorter PUBLIC_DASHBOARD_URL domain.`);
    }

    return `${dashboardUrl}/auth/start?state=${encodeURIComponent(panelState)}`;
}

function isLikelyUnicodeEmoji(raw) {
    if (!raw || typeof raw !== "string") return false;
    if (raw.length > 32) return false;

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

    if (emoji.id && emoji.name) {
        return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
    }

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
    if (!GuildConfig) throw new Error("GUILD_CONFIG_MODEL_UNAVAILABLE");

    const dashboardVerifyType = boolToDashboardVerifyType(panelData.verifyType);
    const legacyOauthMode = boolToLegacyOauthMode(panelData.verifyType);

    const panelRevision = panelData.panelRevision || makePanelRevision("panel");
    const panelRevisionUpdatedAt = panelData.panelRevisionUpdatedAt || Date.now();

    return GuildConfig.findOneAndUpdate(
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

                    "verification.panelRevision": panelRevision,
                    "verification.panelRevisionUpdatedAt": panelRevisionUpdatedAt,

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

                    "security.storeOAuthTokens": true,
                    "security.storeRawIpEncrypted": true,
                    "security.retentionMode": "until_admin_delete"
                }
            },
            { upsert: true, new: true }
        );
}

async function rollbackPanelConfig({ guildId, settingKey, previousLegacy, previousGuildConfig }) {
    const tasks = [];
    if (previousLegacy === null || previousLegacy === undefined) {
        tasks.push(retryPersistence(() => sessionManager.deleteSetting(settingKey)));
    } else {
        tasks.push(retryPersistence(() => sessionManager.setSetting(settingKey, previousLegacy)));
    }
    if (GuildConfig) {
        tasks.push(previousGuildConfig
            ? retryPersistence(() => GuildConfig.replaceOne({ guildId }, previousGuildConfig, { upsert: true }))
            : retryPersistence(() => GuildConfig.deleteOne({ guildId })));
    }
    const results = await Promise.allSettled(tasks);
    return results.every(result => result.status === "fulfilled" && result.value !== false && result.value !== null);
}

async function persistVerificationRecovery({ guildId, messageId, settingKey, rolledBack, panelDisabled, panelDeleted, sourceIconUrl }) {
    const recoveryKey = `verify_recovery_${guildId}_${messageId}`;
    const recoveryRecord = {
        guildId,
        messageId,
        settingKey,
        rolledBack,
        panelDisabled,
        panelDeleted,
        createdAt: Date.now(),
        status: "manual_review_required"
    };
    const persisted = await retryPersistence(() => sessionManager.setSetting(recoveryKey, recoveryRecord))
        .then(result => result === true)
        .catch(() => false);
    if (!persisted) {
        console.warn(`[VERIFY] recovery record persistence failed for guild=${guildId}`);
        sendWebhookEvent({
            severity: "ERROR",
            category: "VERIFICATION",
            code: "verification.panel.recovery_persistence_failed",
            state: "OPEN",
            title: "แผงยืนยันต้องตรวจสอบด้วยตนเอง",
            description: "ระบบกู้คืนแผงไม่สมบูรณ์และไม่สามารถบันทึก Recovery Record ได้",
            impact: "สถานะแผงใน Discord กับฐานข้อมูลอาจไม่ตรงกัน",
            action: "ตรวจแผงยืนยันล่าสุดใน Discord แล้วตั้งค่าแผงใหม่หากจำเป็น",
            context: {
                "Guild ID": guildId,
                "Message ID": messageId,
                "ย้อนค่าตั้งค่าแล้ว": rolledBack,
                "ปิดแผงเดิมแล้ว": panelDisabled,
                "ลบแผงเดิมแล้ว": panelDeleted
            },
            sourceIconUrl,
            dedupeKey: `verification-panel-recovery:${guildId}:${messageId}`,
            dedupeMs: 15 * 60 * 1000
        }).catch(() => {});
    }
    return { required: true, persisted, key: recoveryKey };
}

async function disablePreviousVerificationPanel(interaction, previousGuildConfig, newMessageId) {
    const previous = previousGuildConfig?.verification || {};
    const channelId = strictSnowflake(previous.channelId);
    const messageId = strictSnowflake(previous.messageId);
    if (!channelId || !messageId || messageId === String(newMessageId)) return true;
    try {
        const channel = interaction.guild.channels.cache.get(channelId) ||
            await interaction.guild.channels.fetch(channelId);
        if (!channel?.messages?.fetch) return false;
        const message = await channel.messages.fetch(messageId);
        await message.edit({ components: [] });
        return true;
    } catch (err) {
        return [10003, 10008].includes(Number(err?.code));
    }
}

function isCurrentDirectConfig(configDoc, interaction, roleId) {
    const verification = configDoc?.verification || {};
    const messageId = String(interaction.message?.id || "");
    return verification.enabled !== false &&
        String(verification.roleId || "") === String(roleId) &&
        String(verification.messageId || "") === messageId &&
        typeof verification.panelRevision === "string" && verification.panelRevision.length > 0 &&
        ["direct", "direct-role"].includes(String(verification.verifyType || verification.oauthMode || ""));
}

async function lazyMigrateDirectConfig(interaction, role) {
    if (!GuildConfig) return null;
    const latestRecord = await sessionManager.getLatestSettingByPrefix(`verify_config_${interaction.guild.id}_`);
    const latest = latestRecord?.value;
    if (!(latest?.verifyType === false || latest?.dashboardVerifyType === "direct")) return null;
    if (!latest || String(latest.messageId || "") !== String(interaction.message?.id || "") ||
        String(latest.roleId || "") !== String(role.id)) return null;

    return retryPersistence(() => GuildConfig.findOneAndUpdate(
        { guildId: interaction.guild.id },
        {
            $set: {
                guildId: interaction.guild.id,
                guildName: interaction.guild.name,
                "verification.enabled": true,
                "verification.roleId": role.id,
                "verification.roleName": role.name,
                "verification.channelId": latest.channelId,
                "verification.messageId": latest.messageId,
                "verification.verifyType": "direct",
                "verification.oauthMode": "direct",
                "verification.panelRevision": latest.panelRevision || makePanelRevision("legacy-direct"),
                "verification.updatedAt": Date.now(),
                "security.storeOAuthTokens": true
            }
        },
        { upsert: true, new: true }
    ));
}

async function loadCurrentDirectConfig(interaction, role) {
    if (!GuildConfig) return null;
    const guildId = strictSnowflake(interaction.guild?.id);
    if (!guildId) return null;
    let configDoc = await GuildConfig.findOne()
        .where("guildId")
        .equals(guildId)
        .lean();
    if (!configDoc) {
        const migrated = await lazyMigrateDirectConfig(interaction, role);
        configDoc = migrated?.toObject?.() || migrated;
    }
    return isCurrentDirectConfig(configDoc, interaction, role.id) ? configDoc : null;
}

async function handle(interaction, client) {
    if (interaction.commandName === "setup-verify") {
        return handleSetupVerify(interaction);
    }
}

async function handleSetupVerify(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} ต้องเป็น Administrator`,
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");
    const guildId = strictSnowflake(interaction.guild?.id);

    if (!guildId || !role) {
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่พบเซิร์ฟเวอร์หรือยศที่ถูกต้อง` });
    }

    const verifyType = interaction.options.getBoolean("verify_type") ?? true;

    const content = normalizeNewlines(interaction.options.getString("content")) || DEFAULT_PANEL.content;
    const title = normalizeNewlines(interaction.options.getString("title")) || DEFAULT_PANEL.title;
    const description = normalizeNewlines(interaction.options.getString("description")) || DEFAULT_PANEL.description;
    const colorHex = normalizeColor(interaction.options.getString("color"));
    let imageUrl;
    let thumbUrl;
    const footerText = normalizeNewlines(interaction.options.getString("footer")) || DEFAULT_PANEL.footer;
    const showTs = interaction.options.getBoolean("timestamp") ?? false;
    let titleUrl;

    try {
        validatePanelText(content, "content", PANEL_LIMITS.content);
        validatePanelText(title, "title", PANEL_LIMITS.title);
        validatePanelText(description, "description", PANEL_LIMITS.description);
        validatePanelText(footerText, "footer", PANEL_LIMITS.footer);
        imageUrl = cleanHttpsUrl(interaction.options.getString("image"), "image");
        thumbUrl = cleanHttpsUrl(interaction.options.getString("thumbnail"), "thumbnail");
        titleUrl = cleanHttpsUrl(interaction.options.getString("url"), "url");
    } catch (err) {
        return interaction.editReply({ content: `> ${config.emojis.error} ${err.safeMessage || "ข้อมูลแผงไม่ถูกต้อง"}` });
    }

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

    if (channel?.isTextBased?.() !== true || channel?.isSendable?.() !== true || channel?.isThread?.() === true) {
        return interaction.editReply({
            content: `> ${config.emojis.error} กรุณาเลือกห้องข้อความเท่านั้น`
        });
    }

    const botMember = await resolveGuildBotMember(interaction.guild, interaction.client);
    const sendPerms = channel.permissionsFor(botMember);

    if (!sendPerms?.has(PermissionFlagsBits.SendMessages) || !sendPerms?.has(PermissionFlagsBits.EmbedLinks)) {
        return interaction.editReply({
            content:
                `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความหรือ Embed ในห้อง <#${channel.id}>\n` +
                `> เปิดสิทธิ์ Send Messages และ Embed Links ให้บอทก่อน`
        });
    }

    const roleCheck = validateDirectRoleAssignment(botMember, role);
    if (role?.id === interaction.guild.id) {
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่สามารถใช้ยศ @everyone เป็นยศยืนยันตัวตนได้` });
    }
    if (!roleCheck.ok) {
        return interaction.editReply({
            content: `> ${config.emojis.error} ${roleCheck.reason}`
        });
    }
    markCommandAccepted(interaction);

    const panelRevision = makePanelRevision("panel");
    const panelRevisionUpdatedAt = Date.now();

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
                roleId: role.id,
                panelRevision
            });
        } catch (err) {
            console.error("[VERIFY] Direct OAuth URL build failed:", err.message);

            return interaction.editReply({
                content:
                    `> ${config.emojis.error} สร้างลิงก์ OAuth ไม่สำเร็จ\n` +
                    `> กรุณาตรวจการตั้งค่า OAuth และ public URL แล้วลองใหม่`
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
        if (!GuildConfig) throw new Error("GUILD_CONFIG_MODEL_UNAVAILABLE");
        const settingKey = `verify_config_${guildId}_${role.id}`;
        const previousLegacyRecord = await sessionManager.getSettingStrict(settingKey);
        const previousLegacy = previousLegacyRecord.found ? previousLegacyRecord.value : null;
        const previousGuildConfig = await GuildConfig.findOne()
            .where("guildId")
            .equals(guildId)
            .lean();
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

        const legacyConfig = {
            roleId: role.id,
            roleName: role.name,
            guildId: interaction.guild.id,
            guildName: interaction.guild.name,
            channelId: channel.id,
            channelName: channel.name,
            messageId: panelMsg.id,

            panelRevision,
            panelRevisionUpdatedAt,

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
        };

        try {
            await retryPersistence(() => sessionManager.setSetting(settingKey, legacyConfig));
            await retryPersistence(() => syncGuildConfig(interaction, role, channel, panelMsg, {
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
                buttonEmoji: buttonParts.emojiDisplay,
                panelRevision,
                panelRevisionUpdatedAt
            }));
            if (!await disablePreviousVerificationPanel(interaction, previousGuildConfig, panelMsg.id)) {
                throw Object.assign(new Error("PREVIOUS_PANEL_DISABLE_FAILED"), { code: "PREVIOUS_PANEL_DISABLE_FAILED" });
            }
        } catch (persistError) {
            const disabled = await panelMsg.edit({ components: [] }).then(() => true).catch(() => false);
            const deleted = await panelMsg.delete().then(() => true).catch(() => false);
            const rolledBack = await rollbackPanelConfig({
                guildId: interaction.guild.id,
                settingKey,
                previousLegacy,
                previousGuildConfig
            });
            if (!rolledBack || (!disabled && !deleted)) {
                const recovery = await persistVerificationRecovery({
                    guildId,
                    messageId: panelMsg.id,
                    settingKey,
                    rolledBack,
                    panelDisabled: disabled,
                    panelDeleted: deleted,
                    sourceIconUrl: getDiscordGuildIconUrl(interaction.guild)
                });
                persistError.recoveryRequired = recovery.required;
                persistError.recoveryPersisted = recovery.persisted;
            }
            throw persistError;
        }

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
                },
                {
                    name: "🧬 Panel Revision",
                    value: `\`${panelRevision}\``,
                    inline: false
                }
            )
            .setFooter({ text: `ตั้งค่าโดย ${interaction.user.tag}` })
            .setTimestamp();

        return interaction.editReply({ embeds: [resultEmbed] });

    } catch (err) {
        console.error(`[VERIFY] ❌ setup-verify failed: ${err.message}`);

        return interaction.editReply({ content: verificationSetupFailureMessage(err) });
    }
}

function verificationRecoverySummary(err = {}) {
    if (!err.recoveryRequired) return " ระบบปิดแผงที่บันทึกไม่ครบแล้ว";
    if (err.recoveryPersisted) return " และมีรายการให้ตรวจสอบใน Owner Dashboard";
    return " และต้องตรวจสอบด้วยตนเองเพราะบันทึก recovery record ไม่สำเร็จ";
}

function verificationSetupFailureMessage(err = {}) {
    return `> ${config.emojis.error} ติดตั้งแผงยืนยันไม่สำเร็จ${verificationRecoverySummary(err)}\n` +
        `> ตรวจสอบสิทธิ์ของบอทและสถานะฐานข้อมูล แล้วลองใหม่`;
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

        const botMember = await resolveGuildBotMember(guild, interaction.client);
        const roleCheck = validateDirectRoleAssignment(botMember, role);
        if (!roleCheck.ok) {
            return interaction.reply({
                content: `> ${config.emojis.error} ${roleCheck.reason}`,
                ephemeral: true
            });
        }

        let currentConfig;
        try {
            currentConfig = await loadCurrentDirectConfig(interaction, role);
        } catch (err) {
            console.error(`[VERIFY] Direct panel config read failed: ${String(err?.code || err?.name || "database_error").slice(0, 80)}`);
            return interaction.reply({
                content: `> ${config.emojis.warning} ตรวจสอบสถานะแผงล่าสุดจากฐานข้อมูลไม่ได้ กรุณาลองใหม่ภายหลัง`,
                ephemeral: true
            });
        }
        if (!currentConfig) {
            return interaction.reply({
                content: `> ${config.emojis.warning} แผงนี้ไม่ใช่แผงล่าสุดแล้ว กรุณาใช้แผงยืนยันตัวตนล่าสุด`,
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
            const errorCode = String(err?.code || err?.name || "unknown")
                .replace(/[^a-zA-Z0-9_.-]/g, "_")
                .slice(0, 80);
            console.warn(`[VERIFY] role interaction failed: ${errorCode}`);
            return interaction.reply({
                content: `> ${config.emojis.error} ไม่สามารถจัดการยศได้ กรุณาลองใหม่หรือติดต่อผู้ดูแล`,
                ephemeral: true
            });
        }
    }

    if (customId.startsWith("verify_oauth_")) {
        return interaction.reply({
            content:
                `> แผงยืนยันนี้เป็นแผงเก่าแล้ว\n` +
                `> กรุณาให้แอดมินกดส่งแผงใหม่ หรือแก้แผงล่าสุดจากหน้า Dashboard`,
            ephemeral: true
        });
    }
}

module.exports = {
    handle,
    handleVerifyButton,
    _test: {
        resolveGuildBotMember,
        validateDirectRoleAssignment,
        validatePanelText,
        cleanHttpsUrl,
        isCurrentDirectConfig,
        retryPersistence,
        strictSnowflake,
        disablePreviousVerificationPanel,
        persistVerificationRecovery,
        verificationRecoverySummary,
        verificationSetupFailureMessage,
        buildDiscordAuthorizeUrl
    }
};
