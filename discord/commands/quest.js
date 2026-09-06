'use strict';

const {
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
const {
    startUserQuestSession,
    stopAllUserQuestSessions
} = require('../quest');

function isBotOwner(userId) {
    return isConfiguredOwner(config, userId);
}

function buildQuestPanelEmbed() {
    const primaryColor = config.system?.themeColors?.primary || '#57F287';
    const universeEmoji = config.emojis?.universe || '🔥';
    const dreamworldEmoji = config.emojis?.dreamworld || '✨';
    const signalEmoji = config.emojis?.signal || '🚀';
    const stopEmoji = config.emojis?.stop || '🛑';
    const ownerId = config.system?.ownerId || '661415152146710558';

    const embed = new MessageEmbed()
        .setColor(primaryColor)
        .setTitle(`${universeEmoji} : Phomueangtai ระบบทำเควสต์อัตโนมัติ`)
        .setDescription([
            `**AUTO QUEST ENGINE** ${dreamworldEmoji}`,
            '',
            `• ${signalEmoji} **START NOW** — เริ่มต้นทำ Discord Quest อัตโนมัติ`,
            `• ${stopEmoji} **STOP ALL** — หยุดการทำเควสต์ทั้งหมดของคุณ`,
            '',
            '• รายงานสถานะความคืบหน้าแบบ Real-time จะส่งตรงไปยัง **DM ส่วนตัว** ของคุณ',
            '',
            `*Developed by <@${ownerId}>*`
        ].join('\n'))
        .setFooter({ text: 'POWERED BY NEVERDIE AUTO QUEST™' })
        .setTimestamp();

    if (config.system?.bannerUrl) {
        embed.setImage(config.system.bannerUrl);
    }

    return embed;
}

function buildQuestPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_RUN)
            .setLabel('START NOW')
            .setEmoji(config.emojis?.signal || '🚀')
            .setStyle('SUCCESS'),
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_STOP)
            .setLabel('STOP ALL')
            .setEmoji(config.emojis?.stop || '🛑')
            .setStyle('DANGER')
    );
}

async function handleQuestCommand(interaction) {
    if (!isBotOwner(interaction.user.id)) {
        return safeReply(interaction, {
            content: `🔒 คำสั่งนี้สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
            flags: 64
        });
    }

    const subcommand = interaction.options.getSubcommand(false) || 'panel';
    if (subcommand === 'panel') {
        const embed = buildQuestPanelEmbed();
        const row = buildQuestPanelRow();
        return interaction.reply({ embeds: [embed], components: [row] });
    }

    return safeReply(interaction, {
        content: '❌ คำสั่งย่อยไม่ถูกต้อง กรุณาใช้ `/quest panel`',
        flags: 64
    });
}

async function showQuestModal(interaction) {
    const modal = new Modal()
        .setCustomId(IDS.MODAL_QUEST_RUN)
        .setTitle('🔥 AUTO QUEST LOGIN');

    const tokenInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_QUEST_TOKENS)
        .setLabel('🔑 DISCORD TOKENS')
        .setStyle('PARAGRAPH')
        .setPlaceholder('1 TOKEN ต่อ 1 บรรทัด (รองรับสูงสุด 10 บัญชี)')
        .setRequired(true);

    modal.addComponents(new MessageActionRow().addComponents(tokenInput));

    try {
        await interaction.showModal(modal);
    } catch (err) {
        if (err?.code === 10062 || err?.code === 40060) return;
        throw err;
    }
}

async function handleQuestButton(interaction) {
    const customId = interaction.customId;

    if (customId === IDS.BTN_QUEST_RUN) {
        return showQuestModal(interaction);
    }

    if (customId === IDS.BTN_QUEST_STOP) {
        await interaction.deferReply({ flags: 64 });
        const stopped = stopAllUserQuestSessions(interaction.user.id);
        const text = stopped > 0
            ? `🛑 สั่งหยุดเควสต์ของคุณเรียบร้อยแล้ว (${stopped} รายการ)`
            : 'ℹ️ คุณไม่มีเควสต์ที่กำลังทำงานอยู่ในขณะนี้';
        return interaction.editReply(text);
    }

    return interaction.reply({
        content: 'ℹ️ ปุ่มนี้ไม่รองรับการทำงาน',
        flags: 64
    });
}

async function handleQuestModalSubmit(interaction) {
    const rawTokens = interaction.fields.getTextInputValue(IDS.FIELD_QUEST_TOKENS) || '';
    const tokens = [...new Set(rawTokens.split('\n').map((t) => t.trim()).filter(Boolean))];

    if (!tokens.length) {
        return interaction.reply({
            content: '❌ ไม่พบ Token กรุณากรอกอย่างน้อย 1 บัญชี',
            flags: 64
        });
    }

    if (tokens.length > 10) {
        return interaction.reply({
            content: '❌ กรุณากรอกไม่เกิน 10 Token ต่อรอบ เพื่อความปลอดภัยของระบบ',
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });

    const sessionResult = await startUserQuestSession({
        client: interaction.client,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag || interaction.user.username,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        tokens
    });

    let replyMsg = `🚀 **ระบบเริ่มดำเนินการทำ Quest ให้แล้ว (${tokens.length} บัญชี)**\n`;
    if (sessionResult.dmDelivered) {
        replyMsg += '📩 บอทได้ส่งข้อความเริ่มต้นและจะอัปเดตความคืบหน้าแบบ Real-time เข้า **DM ส่วนตัวของคุณ** เรียบร้อยแล้วครับ';
    } else {
        replyMsg += '⚠️ **ข้อควรระวัง:** ไม่สามารถส่งข้อความเข้า DM ของคุณได้ (อาจเพราะคุณปิดรับ DM จากสมาชิกเซิร์ฟเวอร์) แต่ระบบยังคงดำเนินการในระบบเบื้องหลังให้ตามปกติครับ';
    }

    return interaction.editReply(replyMsg);
}

module.exports = {
    handleQuestCommand,
    handleQuestButton,
    handleQuestModalSubmit
};
