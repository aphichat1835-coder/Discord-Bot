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
const { safeReply } = require('../guards/commandGuards');
const {
    checkSingleToken,
    checkBatchTokens,
    buildSingleTokenEmbed,
    buildBatchSummaryEmbed,
    createCategoryAttachments
} = require('../features/tokenChecker');

const MAX_BATCH_TOKENS = 20;
const TOKEN_CHECK_BANNER_ATTACHMENT_NAME = 'token-check-banner.gif';

function getTokenCheckBannerPath() {
    try {
        return require.resolve('../assets/token-check-banner.gif');
    } catch {
        return null;
    }
}

function buildTokenCheckPanelEmbed({ hasAttachment = false } = {}) {
    const primaryColor = config.system?.themeColors?.info || '#5865F2';
    const searchEmoji = config.emojis?.search || '🔍';
    const boostEmoji = config.emojis?.boost || '🚀';
    const lockEmoji = config.emojis?.lock || '🔒';

    const embed = new MessageEmbed()
        .setColor(primaryColor)
        .setTitle(`${searchEmoji} : Phomueangtai Discord Token Checker`)
        .setDescription(
            `ระบบตรวจสอบสถานะ Discord Token แบบส่วนตัว ${lockEmoji}\n\n` +
            `**ความสามารถในการตรวจสอบ:**\n` +
            `• ตรวจสอบความถูกต้องและสถานะของบัญชี (Valid / Locked / Invalid)\n` +
            `• ตรวจสอบสถานะ **Nitro** ทุกประเภท (Nitro Boost ${boostEmoji}, Nitro Classic, Nitro Basic)\n` +
            `• คำนวณวันและเวลาหมดอายุของ Nitro อัตโนมัติ (เวลาประเทศไทย)\n` +
            `• ตรวจสอบสิทธิ์ **Server Boost** ที่พร้อมใช้งาน\n` +
            `• ตรวจสอบความปลอดภัยของบัญชี (การผูกอีเมล, เบอร์โทรศัพท์, ระบบ 2FA)\n` +
            `• คำนวณวันสร้างบัญชีและอายุของบัญชีจาก Discord Snowflake\n` +
            `• รองรับการกรอก **1 โทเค่น** หรือ **หลายโทเค่นพร้อมกัน** (สูงสุด ${MAX_BATCH_TOKENS} บัญชี)\n\n` +
            `> *ข้อมูลทั้งหมดจะถูกส่งกลับแบบส่วนตัว (Ephemeral) เห็นเฉพาะคุณเท่านั้น ปลอดภัย 100%*`
        )
        .setFooter({ text: 'กดปุ่มด้านล่างเพื่อเปิดแบบฟอร์มกรอก Token' })
        .setTimestamp();

    if (hasAttachment) {
        embed.setImage(`attachment://${TOKEN_CHECK_BANNER_ATTACHMENT_NAME}`);
    }

    return embed;
}

function buildTokenCheckPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_TOKEN_CHECK)
            .setLabel('เช็คโทเคน')
            .setEmoji('🔍')
            .setStyle('PRIMARY')
    );
}

async function handleTokenCheckCommand(interaction) {
    const bannerPath = getTokenCheckBannerPath();
    const hasAttachment = Boolean(bannerPath);
    const embed = buildTokenCheckPanelEmbed({ hasAttachment });
    const row = buildTokenCheckPanelRow();

    const payload = {
        embeds: [embed],
        components: [row],
        flags: 64
    };

    if (hasAttachment) {
        payload.files = [new AttachmentBuilder(bannerPath, { name: TOKEN_CHECK_BANNER_ATTACHMENT_NAME })];
    }

    return interaction.reply(payload);
}

async function handleTokenCheckButton(interaction) {
    const modal = new Modal()
        .setCustomId(IDS.MODAL_TOKEN_CHECK)
        .setTitle('🔍 ตรวจสอบ Discord Token');

    const tokenInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_TOKEN_INPUT)
        .setLabel('กรอก Discord Token (1 บรรทัดต่อ 1 บัญชี)')
        .setStyle('PARAGRAPH')
        .setPlaceholder(`วาง Discord Token ที่นี่ (รองรับสูงสุด ${MAX_BATCH_TOKENS} บัญชี โดยขึ้นบรรทัดใหม่)`)
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
            content: '❌ ไม่พบข้อมูล Token กรุณากรอกอย่างน้อย 1 Token ในแบบฟอร์ม',
            flags: 64
        });
    }

    if (tokens.length > MAX_BATCH_TOKENS) {
        return safeReply(interaction, {
            content: `❌ รองรับการตรวจสอบสูงสุดครั้งละ **${MAX_BATCH_TOKENS} บัญชี** กรุณาลดจำนวนแล้วลองใหม่อีกครั้ง`,
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });

    try {
        if (tokens.length === 1) {
            const result = await checkSingleToken(tokens[0]);
            const embed = buildSingleTokenEmbed(result);
            return await interaction.editReply({ embeds: [embed] });
        }

        const batchData = await checkBatchTokens(tokens, 1200);
        const embed = buildBatchSummaryEmbed(batchData);
        const attachments = createCategoryAttachments(batchData.groups);

        const replyPayload = { embeds: [embed] };
        if (attachments.length > 0) {
            replyPayload.files = attachments;
        }

        return await interaction.editReply(replyPayload);
    } catch (error) {
        return await interaction.editReply({
            content: `❌ เกิดข้อผิดพลาดระหว่างการตรวจสอบ: ${error.message || 'Unknown Error'}`
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
