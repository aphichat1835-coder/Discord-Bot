'use strict';

const {
    AttachmentBuilder,
    MessageEmbed,
    MessageActionRow,
    MessageButton,
    Modal,
    TextInputComponent
} = require('../core/discordCompat');
const config = require('../config.json');
const { IDS } = require('./customIds');
const { safeReply, safeDefer, markCommandAccepted } = require('../guards/commandGuards');
const { isConfiguredOwner } = require('../core/env');
const tokenChecker = require('../features/tokenChecker');

const MAX_BATCH_TOKENS = 20;
const TOKEN_CHECK_BANNER_ATTACHMENT_NAME = 'token-check-banner.gif';

function isBotOwner(userId) {
    return isConfiguredOwner(config, userId);
}

function getTokenCheckBannerPath() {
    try {
        return require.resolve('../assets/token-check-banner.gif');
    } catch {
        return null;
    }
}

function buildTokenCheckPanelEmbed({ hasAttachment = false } = {}) {
    const primaryColor = config.system?.themeColors?.primary || '#57F287';
    const universeEmoji = config.emojis?.universe || '🔥';
    const dreamworldEmoji = config.emojis?.dreamworld || '✨';
    const ownerId = config.system?.ownerId || '661415152146710558';

    const embed = new MessageEmbed()
        .setColor(primaryColor)
        .setTitle(`${universeEmoji} : Phomueangtai ตรวจสอบ Discord Token`)
        .setDescription(
            `ระบบตรวจสอบ Discord Token อัตโนมัติ ${dreamworldEmoji}\n\n` +
            `ตรวจสอบสถานะบัญชี Nitro, Boost และข้อมูลบัญชี ${dreamworldEmoji}\n\n` +
            `ตั้งค่าใส่Tokenควบคุมผ่านปุ่มข้างล่าง ${dreamworldEmoji}\n\n` +
            `*Developed by <@${ownerId}>*`
        );

    if (hasAttachment) {
        embed.setImage(`attachment://${TOKEN_CHECK_BANNER_ATTACHMENT_NAME}`);
    } else if (config.system?.tokenCheckBannerUrl) {
        embed.setImage(config.system.tokenCheckBannerUrl);
    } else if (config.system?.bannerUrl) {
        embed.setImage(config.system.bannerUrl);
    }

    return embed;
}

function buildTokenCheckPanelRow() {
    const searchEmoji = config.emojis?.search || '🔍';
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_TOKEN_CHECK)
            .setLabel('ตรวจสอบ Token')
            .setEmoji(searchEmoji)
            .setStyle('PRIMARY')
    );
}

async function handleTokenCheckCommand(interaction) {
    markCommandAccepted(interaction);

    if (!isBotOwner(interaction.user?.id)) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.no_entry || '⛔'} คำสั่งเปิดแผงควบคุม \`/token-check\` สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
            flags: 64
        });
    }

    await safeDefer(interaction);

    const bannerPath = getTokenCheckBannerPath();
    const hasAttachment = Boolean(bannerPath);
    const embed = buildTokenCheckPanelEmbed({ hasAttachment });
    const row = buildTokenCheckPanelRow();

    const payload = {
        embeds: [embed],
        components: [row]
    };

    if (hasAttachment) {
        payload.files = [new AttachmentBuilder(bannerPath, { name: TOKEN_CHECK_BANNER_ATTACHMENT_NAME })];
    }

    return safeReply(interaction, payload);
}

async function handleTokenCheckButton(interaction) {
    const searchEmoji = config.emojis?.search || '🔍';
    const modal = new Modal()
        .setCustomId(IDS.MODAL_TOKEN_CHECK)
        .setTitle(`${searchEmoji} ตรวจสอบ Discord Token`);

    const tokenInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_TOKEN_INPUT)
        .setLabel('Discord Token')
        .setStyle('PARAGRAPH')
        .setPlaceholder('ใส่ 1 Token ต่อ 1 บรรทัด')
        .setRequired(true);

    const row = new MessageActionRow().addComponents(tokenInput);
    modal.addComponents(row);

    return interaction.showModal(modal);
}

async function handleTokenCheckModal(interaction) {
    const rawInput = interaction.fields.getTextInputValue(IDS.FIELD_TOKEN_INPUT) || '';
    const tokens = [...new Set(rawInput.split('\n').map(t => t.trim()).filter(Boolean))];

    if (tokens.length === 0) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.error || '❌'} ไม่พบข้อมูล Token กรุณากรอกอย่างน้อย 1 Token ในแบบฟอร์ม`,
            flags: 64
        });
    }

    if (tokens.length > MAX_BATCH_TOKENS) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.error || '❌'} รองรับการตรวจสอบสูงสุดครั้งละ **${MAX_BATCH_TOKENS} Token** กรุณาลดจำนวนแล้วลองใหม่อีกครั้ง`,
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });
    const loadingEmoji = config.emojis?.loading || '⏳';

    try {
        if (tokens.length === 1) {
            await interaction.editReply({
                content: `${loadingEmoji} กำลังตรวจสอบ...`
            }).catch(() => null);

            const result = await tokenChecker.checkSingleToken(tokens[0]);
            const embed = tokenChecker.buildSingleTokenEmbed(result);
            return await interaction.editReply({ content: null, embeds: [embed] });
        }

        const loadingCircleEmoji = config.emojis?.loading_circle || loadingEmoji;
        const loadingBarEmoji = config.emojis?.loading_bar || loadingCircleEmoji;

        await interaction.editReply({
            content: `${loadingCircleEmoji} กำลังตรวจสอบ...`
        }).catch(() => null);

        const batchData = await tokenChecker.checkBatchTokens(tokens, {
            delayMs: 150,
            onProgress: async (current, total) => {
                await interaction.editReply({
                    content: `${loadingBarEmoji} กำลังตรวจสอบ ${current}/${total}...`
                }).catch(() => null);
            }
        });
        const embed = tokenChecker.buildBatchSummaryEmbed(batchData);
        return await interaction.editReply({ content: null, embeds: [embed] });
    } catch (error) {
        console.error('[TOKEN-CHECK] Verification failed:', error?.message || error);
        return await interaction.editReply({
            content: `> ${config.emojis?.error || '❌'} ตรวจสอบ Token ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง`
        });
    }
}

module.exports = {
    MAX_BATCH_TOKENS,
    buildTokenCheckPanelEmbed,
    buildTokenCheckPanelRow,
    handleTokenCheckCommand,
    handleTokenCheckButton,
    handleTokenCheckModal
};
