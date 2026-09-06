'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
    AttachmentBuilder,
    MessageEmbed,
    MessageActionRow,
    MessageButton,
    MessageSelectMenu,
    Modal,
    TextInputComponent
} = require('../core/discordCompat');
const config = require('../config.json');
const { IDS } = require('./customIds');
const { isConfiguredOwner } = require('../core/env');
const { safeReply } = require('../guards/commandGuards');
const {
    getUserJobs,
    stopJob,
    stopScheduledJob,
    stopAllForUser,
    listScheduledRunners,
    startUserQuestSession
} = require('../quest');

const QUEST_BANNER_PATH = path.join(__dirname, '../quest/assets/banner.gif');
const QUEST_BANNER_ATTACHMENT_NAME = 'quest-banner.gif';

function isBotOwner(userId) {
    return isConfiguredOwner(config, userId);
}

function shortStatus(row) {
    if (row.lastError) return `มีข้อผิดพลาด: ${row.lastError}`.slice(0, 100);
    if (row.nextCheckAt) {
        const next = new Date(row.nextCheckAt);
        if (Number.isFinite(next.getTime())) {
            return `ตรวจครั้งถัดไป ${next.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false })}`.slice(0, 100);
        }
    }
    return 'ระบบอัตโนมัติรายวันกำลังทำงาน';
}

function buildQuestPanelEmbed(interaction = null, { hasAttachment = false } = {}) {
    const primaryColor = config.system?.themeColors?.primary || '#57F287';
    const universeEmoji = config.emojis?.universe || '🔥';
    const dreamworldEmoji = config.emojis?.dreamworld || '✨';
    const ownerId = config.system?.ownerId || '661415152146710558';

    const embed = new MessageEmbed()
        .setColor(primaryColor)
        .setTitle(`${universeEmoji} : Phomueangtai ระบบทำเควสอัตโนมัติ`)
        .setDescription(
            `ระบบทำเควสอัตโนมัติ ${dreamworldEmoji}\n\n` +
            `ทำเควส เเละ รับ Orbs ฟรี ${dreamworldEmoji}\n\n` +
            `ตั้งค่าใส่Tokenควบคุมผ่านปุ่มข้างล่าง ${dreamworldEmoji}\n\n` +
            `*Developed by <@${ownerId}>*`
        );

    if (hasAttachment) {
        embed.setImage(`attachment://${QUEST_BANNER_ATTACHMENT_NAME}`);
    } else if (config.system?.questBannerUrl) {
        embed.setImage(config.system.questBannerUrl);
    } else if (config.system?.bannerUrl) {
        embed.setImage(config.system.bannerUrl);
    }

    return embed;
}

function buildQuestPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_RUN_ONESHOT)
            .setLabel('START NOW')
            .setEmoji('🚀')
            .setStyle('SUCCESS'),
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_RUN_DAILY)
            .setLabel('AUTO DAILY')
            .setEmoji('🤖')
            .setStyle('PRIMARY'),
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_STOP)
            .setLabel('STOP')
            .setEmoji('🛑')
            .setStyle('DANGER')
    );
}

async function showQuestModal(interaction, mode = 'oneshot') {
    const isDaily = mode === 'scheduled';
    const modal = new Modal()
        .setCustomId(`${IDS.MODAL_QUEST_RUN}:${mode}`)
        .setTitle(isDaily ? '🤖 AUTO DAILY QUEST' : '🔥 AUTO QUEST LOGIN');

    const tokenInput = new TextInputComponent()
        .setCustomId(IDS.FIELD_QUEST_TOKENS)
        .setLabel('🔑 DISCORD TOKENS')
        .setStyle('PARAGRAPH')
        .setPlaceholder('1 TOKEN ต่อ 1 บรรทัด (รองรับสูงสุด 10 บัญชี)')
        .setRequired(true);

    const row = new MessageActionRow().addComponents(tokenInput);
    modal.addComponents(row);

    return interaction.showModal(modal);
}

async function buildStopPanelPayload(ownerId, notice = null) {
    let rows = [];
    try {
        rows = await listScheduledRunners(ownerId);
    } catch {}

    const oneShotJobs = getUserJobs(ownerId, { mode: 'oneshot' });
    const scheduledJobs = getUserJobs(ownerId, { mode: 'scheduled' });
    const totalActive = rows.length + oneShotJobs.length;

    const embed = new MessageEmbed()
        .setTitle('🛑 AUTO QUEST RUNNER CONTROL')
        .setColor(totalActive > 0 ? '#ED4245' : '#57F287')
        .setDescription([
            notice ? `${notice}\n` : '',
            totalActive > 0
                ? 'เลือก Token ที่ต้องการหยุดจากเมนูด้านล่าง หรือกดปุ่ม **STOP ALL** เพื่อหยุดทั้งหมด'
                : 'ไม่มี Auto Daily หรือ One-shot Runner ที่กำลังทำงานอยู่'
        ].filter(Boolean).join('\n'))
        .setFooter({ text: `Auto Daily: ${rows.length} · กำลังทำงานอยู่: ${oneShotJobs.length + scheduledJobs.length}` })
        .setTimestamp();

    const components = [];

    if (rows.length > 0) {
        const select = new MessageSelectMenu()
            .setCustomId(IDS.SELECT_QUEST_STOP)
            .setPlaceholder('เลือก Token ที่ต้องการหยุด')
            .setMinValues(1)
            .setMaxValues(Math.min(rows.length, 10))
            .addOptions(rows.slice(0, 10).map((row) => ({
                label: (row.username || 'Unknown').slice(0, 100),
                description: shortStatus(row),
                value: String(row._id),
                emoji: '🤖'
            })));
        components.push(new MessageActionRow().addComponents(select));
    }

    const buttonRow = new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_REFRESH)
            .setLabel('Refresh')
            .setEmoji('🔄')
            .setStyle('SECONDARY'),
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_STOP_ALL)
            .setLabel('STOP ALL')
            .setEmoji('🛑')
            .setStyle('DANGER')
            .setDisabled(totalActive === 0)
    );
    components.push(buttonRow);

    return { embeds: [embed], components };
}

async function handleQuestCommand(interaction) {
    const subcommand = interaction.options.getSubcommand(false) || 'panel';

    if (subcommand === 'panel') {
        if (!isBotOwner(interaction.user.id)) {
            return safeReply(interaction, {
                content: '🔒 คำสั่งเปิดแผงควบคุม `/quest panel` สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น',
                flags: 64
            });
        }
        const hasAttachment = fs.existsSync(QUEST_BANNER_PATH);
        const embed = buildQuestPanelEmbed(interaction, { hasAttachment });
        const row = buildQuestPanelRow();
        const payload = { embeds: [embed], components: [row] };
        if (hasAttachment) {
            payload.files = [new AttachmentBuilder(QUEST_BANNER_PATH, { name: QUEST_BANNER_ATTACHMENT_NAME })];
        }
        return interaction.reply(payload);
    }

    return safeReply(interaction, {
        content: '❌ คำสั่งย่อยไม่ถูกต้อง กรุณาใช้ `/quest panel`',
        flags: 64
    });
}

async function handleQuestButton(interaction) {
    const customId = interaction.customId;

    if (customId === IDS.BTN_QUEST_RUN || customId === IDS.BTN_QUEST_RUN_ONESHOT) {
        return showQuestModal(interaction, 'oneshot');
    }

    if (customId === IDS.BTN_QUEST_RUN_DAILY) {
        return showQuestModal(interaction, 'scheduled');
    }

    if (customId === IDS.BTN_QUEST_STOP) {
        const payload = await buildStopPanelPayload(interaction.user.id);
        return interaction.reply({ ...payload, flags: 64 });
    }

    if (customId === IDS.BTN_QUEST_REFRESH) {
        const payload = await buildStopPanelPayload(interaction.user.id, '🔄 อัปเดตสถานะแล้ว');
        return interaction.update(payload);
    }

    if (customId === IDS.BTN_QUEST_STOP_ALL) {
        const stoppedCount = stopAllForUser(interaction.user.id);
        const scheduledList = await listScheduledRunners(interaction.user.id).catch(() => []);
        for (const r of scheduledList) {
            stopScheduledJob(interaction.user.id, String(r._id));
        }
        const totalStopped = stoppedCount + scheduledList.length;
        const payload = await buildStopPanelPayload(
            interaction.user.id,
            totalStopped > 0
                ? `🛑 สั่งหยุด Runner ทั้งหมดแล้ว **${totalStopped}** รายการ`
                : 'ℹ️ ไม่มี Runner ที่กำลังทำงาน'
        );
        return interaction.update(payload);
    }

    return safeReply(interaction, {
        content: 'ℹ️ ปุ่มควบคุมนี้หมดอายุหรือไม่รองรับแล้ว',
        flags: 64
    });
}

async function handleQuestSelect(interaction) {
    if (interaction.customId !== IDS.SELECT_QUEST_STOP) return;

    const selectedIds = interaction.values || [];
    let stopped = 0;
    for (const scheduleId of selectedIds) {
        if (stopScheduledJob(interaction.user.id, scheduleId)) {
            stopped++;
        }
    }

    const payload = await buildStopPanelPayload(
        interaction.user.id,
        stopped > 0
            ? `🛑 สั่งหยุด Auto Daily Runner ที่เลือกแล้ว **${stopped}** บัญชี`
            : 'ℹ️ ดำเนินการหยุดรายการที่เลือกเรียบร้อยแล้ว'
    );
    return interaction.update(payload);
}

async function handleQuestModalSubmit(interaction) {
    const customId = interaction.customId;
    const isDaily = customId.includes(':scheduled');
    const mode = isDaily ? 'scheduled' : 'oneshot';

    const rawTokens = interaction.fields.getTextInputValue(IDS.FIELD_QUEST_TOKENS) || '';
    const tokens = [...new Set(rawTokens.split('\n').map((t) => t.trim()).filter(Boolean))];

    if (tokens.length === 0) {
        return safeReply(interaction, {
            content: '❌ ไม่พบ Token กรุณาใส่อย่างน้อย 1 Token ในแบบฟอร์ม',
            flags: 64
        });
    }

    if (tokens.length > 10) {
        return safeReply(interaction, {
            content: '❌ สามารถส่งได้สูงสุด **10 บัญชี** ต่อครั้ง กรุณาแบ่งส่งใหม่',
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });

    const results = await startUserQuestSession({
        client: interaction.client,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        tokens,
        mode
    });

    const lines = results.map((r) => r.line || (r.started ? `✅ เริ่มสำเร็จ: ${r.username}` : '❌ เริ่มไม่สำเร็จ'));
    const anyStarted = results.some((r) => r.started);

    let finalContent = lines.join('\n');
    if (isDaily && anyStarted) {
        finalContent = `**🚀 NEVERDIE AUTO DAILY QUEST เปิดใช้งานแล้ว**\n\n${finalContent}\n\nระบบได้ส่งข้อความสถานะสดไปยัง **DM (แชทส่วนตัว)** ของคุณเรียบร้อยแล้ว (หากปิดรับ DM ระบบจะส่งในห้องนี้แทน) และสามารถใช้ปุ่ม **STOP** เพื่อหยุดได้ตลอดเวลา`;
    } else if (anyStarted) {
        finalContent = `**🚀 เริ่มต้นทำงาน ONE-SHOT QUEST แล้ว**\n\n${finalContent}\n\nระบบกำลังเริ่มทำเควสต์และส่งข้อความสถานะสดไปยัง **DM (แชทส่วนตัว)** ของคุณเรียบร้อยแล้ว (หากปิดรับ DM ระบบจะส่งในห้องนี้แทน)`;
    }

    return interaction.editReply({ content: finalContent });
}

module.exports = {
    handleQuestCommand,
    handleQuestButton,
    handleQuestSelect,
    handleQuestModalSubmit
};
