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
const { isConfiguredOwner } = require('../core/env');
const { safeReply } = require('../guards/commandGuards');

const DM_PANEL_BANNER_ATTACHMENT_NAME = 'dm-panel-banner.gif';

function getDmPanelBannerPath() {
    try {
        return require.resolve('../assets/dm-panel-banner.gif');
    } catch {
        return null;
    }
}
const {
    validateSecondaryBot,
    stageBroadcast,
    getStagedBroadcast,
    clearStagedBroadcast,
    startBroadcastJob,
    isBroadcastRunning,
    isValidWebhookUrl
} = require('../features/dmBroadcast');

function isBotOwner(userId) {
    return isConfiguredOwner(config, userId);
}

function buildDmPanelEmbed({ hasAttachment = false } = {}) {
    const primaryColor = config.system?.themeColors?.primary || '#57F287';
    const universeEmoji = config.emojis?.universe || '✨';
    const ownerId = config.system?.ownerId || '661415152146710558';

    const embed = new MessageEmbed()
        .setColor(primaryColor)
        .setTitle(`${universeEmoji} : Phomueangtai ระบบกระจายข้อความ DM`)
        .setDescription(
            `- ระบบส่ง DM ผ่านบอทตัวรอง\n\n` +
            `- ดำเนินการทุกคนตามบอทที่อยู่ในเซิฟเวอร์นั้น\n\n` +
            `- ตั้งค่าควบคุมผ่านปุ่มแผงควบคุมด้านล่าง\n\n` +
            `*Developed by <@${ownerId}>*`
        )
        .setFooter({ text: 'คลิกปุ่มด้านล่างเพื่อเริ่มการตั้งค่าการส่งข้อความ' })
        .setTimestamp();

    if (hasAttachment) {
        embed.setImage(`attachment://${DM_PANEL_BANNER_ATTACHMENT_NAME}`);
    } else if (config.system?.bannerUrl) {
        embed.setImage(config.system.bannerUrl);
    }

    return embed;
}

function buildDmPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_DM_PANEL_OPEN)
            .setLabel('ส่งข้อความ (DM)')
            .setEmoji('✉️')
            .setStyle('SUCCESS')
    );
}

function buildConfirmationRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_DM_CONFIRM)
            .setLabel('ยืนยันเริ่มส่ง')
            .setEmoji(config.emojis?.activate || config.emojis?.success || '✅')
            .setStyle('SUCCESS'),
        new MessageButton()
            .setCustomId(IDS.BTN_DM_CANCEL)
            .setLabel('ยกเลิก')
            .setEmoji(config.emojis?.stop || config.emojis?.error || '❌')
            .setStyle('DANGER')
    );
}

async function showDmPanelModal(interaction) {
    const modal = new Modal()
        .setCustomId(IDS.MODAL_DM_PANEL)
        .setTitle('✉️ ตั้งค่าการกระจายข้อความ DM');

    const tokenInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_DM_TOKEN)
        .setLabel('Bot Token ของบอทตัวรอง')
        .setPlaceholder('วาง Bot Token ของคุณที่นี่')
        .setStyle('SHORT')
        .setRequired(true)
        .setMaxLength(120);

    const guildIdInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_DM_GUILD_ID)
        .setLabel('Server ID (Guild ID) เป้าหมาย')
        .setPlaceholder('เช่น 123456789012345678')
        .setStyle('SHORT')
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(22);

    const messageInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_DM_MESSAGE)
        .setLabel('ข้อความที่ต้องการส่ง DM')
        .setPlaceholder('พิมพ์ข้อความโปรโมท หรือเนื้อหาที่ต้องการส่ง...')
        .setStyle('PARAGRAPH')
        .setRequired(true)
        .setMaxLength(2000);

    const imageInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_DM_IMAGE)
        .setLabel('ลิงก์รูปภาพแนบ (Image URL - ถ้ามี)')
        .setPlaceholder('https://.../image.png (เว้นว่างได้ถ้าไม่มี)')
        .setStyle('SHORT')
        .setRequired(false)
        .setMaxLength(500);

    const webhookInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_DM_WEBHOOK)
        .setLabel('Webhook URL สำหรับรับ Log การส่ง')
        .setPlaceholder('https://discord.com/api/webhooks/...')
        .setStyle('SHORT')
        .setRequired(true)
        .setMaxLength(300);

    modal.addComponents(
        new MessageActionRow().addComponents(tokenInput),
        new MessageActionRow().addComponents(guildIdInput),
        new MessageActionRow().addComponents(messageInput),
        new MessageActionRow().addComponents(imageInput),
        new MessageActionRow().addComponents(webhookInput)
    );

    return interaction.showModal(modal);
}

async function handleDmPanelCommand(interaction) {
    if (!isBotOwner(interaction.user.id)) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.no_entry || '⛔'} คำสั่งเปิดแผงควบคุม \`/dm-panel\` สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
            flags: 64
        });
    }

    const bannerPath = getDmPanelBannerPath();
    const hasAttachment = Boolean(bannerPath);
    const embed = buildDmPanelEmbed({ hasAttachment });
    const row = buildDmPanelRow();

    const payload = {
        embeds: [embed],
        components: [row]
    };

    if (hasAttachment) {
        payload.files = [new AttachmentBuilder(bannerPath, { name: DM_PANEL_BANNER_ATTACHMENT_NAME })];
    }

    return interaction.reply(payload);
}

async function handleDmPanelButton(interaction) {
    if (!isBotOwner(interaction.user.id)) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.no_entry || '⛔'} คุณไม่มีสิทธิ์ใช้งานปุ่มควบคุมนี้ สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
            flags: 64
        });
    }

    const customId = interaction.customId;

    if (customId === IDS.BTN_DM_PANEL_OPEN) {
        if (isBroadcastRunning()) {
            return safeReply(interaction, {
                content: `> ${config.emojis?.warning || '⚠️'} มีงานกระจายข้อความ DM กำลังดำเนินการอยู่ในขณะนี้ กรุณารอให้งานปัจจุบันเสร็จสิ้นก่อนเริ่มงานใหม่`,
                flags: 64
            });
        }
        return showDmPanelModal(interaction);
    }

    if (customId === IDS.BTN_DM_CONFIRM) {
        const staged = getStagedBroadcast(interaction.user.id);
        if (!staged) {
            return interaction.update({
                content: `> ${config.emojis?.warning || '⚠️'} ข้อมูลการยืนยันหมดอายุหรือถูกยกเลิกแล้ว กรุณากดปุ่มเปิดแบบฟอร์มใหม่อีกครั้ง`,
                embeds: [],
                components: []
            });
        }

        if (isBroadcastRunning()) {
            return interaction.update({
                content: `> ${config.emojis?.warning || '⚠️'} มีงานกระจายข้อความอื่นเริ่มทำงานก่อนหน้านี้แล้ว กรุณารอให้งานปัจจุบันเสร็จสิ้น`,
                embeds: [],
                components: []
            });
        }

        clearStagedBroadcast(interaction.user.id);

        const startResult = await startBroadcastJob({
            token: staged.token,
            guildId: staged.guildId,
            message: staged.message,
            imageUrl: staged.imageUrl,
            webhookUrl: staged.webhookUrl,
            initiatedBy: interaction.user.id
        });

        if (!startResult.ok) {
            return interaction.update({
                content: `> ${config.emojis?.error || '❌'} ไม่สามารถเริ่มงานได้: ${startResult.error}`,
                embeds: [],
                components: []
            });
        }

        const successEmbed = new MessageEmbed()
            .setColor(config.system?.themeColors?.success || '#57F287')
            .setTitle(`${config.emojis?.activate || '🚀'} เริ่มการกระจายข้อความ DM แล้ว!`)
            .setDescription(
                `บอทตัวรอง **${staged.botUser?.tag || 'Helper Bot'}** เริ่มทำการส่งข้อความไปยังสมาชิกจำนวน **${staged.targetCount}** คน ในเซิร์ฟเวอร์ **${staged.guild?.name || staged.guildId}**\n\n` +
                `• คุณสามารถดูความคืบหน้าแบบ Real-time ได้ในช่อง Webhook ที่ระบุไว้\n` +
                `• เมื่อส่งครบทุกคน ระบบจะส่งรายงานสรุปยอดรวมและตัดการเชื่อมต่ออัตโนมัติ`
            )
            .setTimestamp();

        return interaction.update({
            embeds: [successEmbed],
            components: []
        });
    }

    if (customId === IDS.BTN_DM_CANCEL) {
        clearStagedBroadcast(interaction.user.id);
        return interaction.update({
            content: `> ${config.emojis?.stop || config.emojis?.error || '❌'} ยกเลิกการกระจายข้อความเรียบร้อยแล้ว`,
            embeds: [],
            components: []
        });
    }

    return safeReply(interaction, {
        content: `> ${config.emojis?.warning || '⚠️'} ปุ่มควบคุมนี้ไม่รองรับหรือไม่ถูกต้อง`,
        flags: 64
    });
}

function extractDmModalInputs(fields) {
    return {
        token: String(fields.getTextInputValue(IDS.FIELD_DM_TOKEN) || '').trim(),
        guildId: String(fields.getTextInputValue(IDS.FIELD_DM_GUILD_ID) || '').trim(),
        message: String(fields.getTextInputValue(IDS.FIELD_DM_MESSAGE) || '').trim(),
        imageUrl: String(fields.getTextInputValue(IDS.FIELD_DM_IMAGE) || '').trim(),
        webhookUrl: String(fields.getTextInputValue(IDS.FIELD_DM_WEBHOOK) || '').trim()
    };
}

function validateDmModalFields({ message, webhookUrl, imageUrl }) {
    if (!message) {
        return `> ${config.emojis?.error || '❌'} **กรุณาระบุข้อความที่ต้องการส่ง (ข้อความว่างเปล่า)**`;
    }
    if (!isValidWebhookUrl(webhookUrl)) {
        return `> ${config.emojis?.error || '❌'} **ลิงก์ Webhook ไม่ถูกต้อง**\n> กรุณาระบุ Discord Webhook URL ที่ถูกต้อง เช่น \`https://discord.com/api/webhooks/...\``;
    }
    if (imageUrl && !/^https?:\/\/.+/i.test(imageUrl)) {
        return `> ${config.emojis?.error || '❌'} **ลิงก์รูปภาพไม่ถูกต้อง**\n> ลิงก์รูปภาพต้องขึ้นต้นด้วย \`http://\` หรือ \`https://\``;
    }
    return null;
}

async function handleDmPanelModal(interaction) {
    if (!isBotOwner(interaction.user.id)) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.no_entry || '⛔'} คุณไม่มีสิทธิ์ส่งแบบฟอร์มนี้`,
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });
    await interaction.editReply({ content: `${config.emojis?.loading_circle || config.emojis?.loading || '⏳'} กำลังโหลด...` }).catch(() => null);

    const inputs = extractDmModalInputs(interaction.fields);
    const validationError = validateDmModalFields(inputs);
    if (validationError) {
        return interaction.editReply({ content: validationError });
    }

    // Perform Pre-check
    const checkResult = await validateSecondaryBot(inputs.token, inputs.guildId);
    if (!checkResult.ok) {
        return interaction.editReply({
            content: `> ${config.emojis?.error || '❌'} **การตรวจสอบล้มเหลว**\n> ${checkResult.error}`
        });
    }

    // Stage the broadcast data for confirmation
    stageBroadcast(interaction.user.id, {
        ...inputs,
        botUser: checkResult.botUser,
        guild: checkResult.guild,
        targetCount: checkResult.targetCount
    });

    const { message, imageUrl, webhookUrl } = inputs;

    const previewMessage = message.length > 300
        ? `${message.slice(0, 300)}...`
        : message;

    const confirmEmbed = new MessageEmbed()
        .setColor(config.system?.themeColors?.warning || '#FEE75C')
        .setTitle(`${config.emojis?.check_alt || config.emojis?.shield || '📋'} ตรวจสอบและยืนยันการกระจายข้อความ DM`)
        .setDescription('ระบบได้ตรวจสอบความพร้อมของบอทตัวรองเรียบร้อยแล้ว กรุณาตรวจสอบข้อมูลด้านล่างก่อนกดยืนยันเริ่มส่ง:')
        .addFields(
            { name: '🤖 บอทตัวรอง', value: `\`${checkResult.botUser.tag}\` (\`${checkResult.botUser.id}\`)`, inline: true },
            { name: `${config.emojis?.server_icon || '🌐'} เซิร์ฟเวอร์เป้าหมาย`, value: `**${checkResult.guild.name}** (\`${checkResult.guild.id}\`)`, inline: true },
            { name: `${config.emojis?.members || '👥'} สมาชิกเป้าหมาย`, value: `**${checkResult.targetCount}** คน (คัดแยกบอทออกแล้ว)`, inline: true },
            { name: '💬 ตัวอย่างข้อความที่จะส่ง', value: `\`\`\`\n${previewMessage}\n\`\`\``, inline: false },
            { name: '🖼️ รูปภาพแนบ', value: imageUrl || '*(ไม่มี)*', inline: true },
            { name: '🪝 Webhook รับ Log', value: `\`${webhookUrl.slice(0, 45)}...\``, inline: true }
        )
        .setFooter({ text: 'กดปุ่ม ยืนยันเริ่มส่ง เพื่อเริ่มการทำงาน หรือ ยกเลิก หากต้องการแก้ไข' })
        .setTimestamp();

    if (checkResult.botUser?.avatarUrl) {
        confirmEmbed.setThumbnail(checkResult.botUser.avatarUrl);
    }

    const row = buildConfirmationRow();

    return interaction.editReply({
        embeds: [confirmEmbed],
        components: [row]
    });
}

module.exports = {
    DM_PANEL_BANNER_ATTACHMENT_NAME,
    getDmPanelBannerPath,
    buildDmPanelEmbed,
    buildDmPanelRow,
    buildConfirmationRow,
    showDmPanelModal,
    handleDmPanelCommand,
    handleDmPanelButton,
    handleDmPanelModal,
    extractDmModalInputs,
    validateDmModalFields
};
