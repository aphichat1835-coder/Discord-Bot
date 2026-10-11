'use strict';

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

const QUEST_BANNER_ATTACHMENT_NAME = 'quest-banner.gif';

function getQuestBannerPath() {
    try {
        return require.resolve('../quest/assets/banner.gif');
    } catch {
        return null;
    }
}

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

function buildQuestPanelRow({ showDaily = false } = {}) {
    const buttons = [
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_RUN_ONESHOT)
            .setLabel('START NOW')
            .setEmoji(config.emojis?.boost || '🚀')
            .setStyle('SUCCESS')
    ];

    if (showDaily) {
        buttons.push(
            new MessageButton()
                .setCustomId(IDS.BTN_QUEST_RUN_DAILY)
                .setLabel('AUTO DAILY')
                .setEmoji('🤖')
                .setStyle('PRIMARY')
        );
    }

    buttons.push(
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_STOP)
            .setLabel('STOP')
            .setEmoji(config.emojis?.stop || '🛑')
            .setStyle('DANGER')
    );

    return new MessageActionRow().addComponents(...buttons);
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

    const embedTitle = totalActive > 0 ? `${config.emojis?.stop || '🛑'} จัดการ Runner เควสอัตโนมัติ` : `${config.emojis?.success || '✅'} ไม่มี Runner ที่กำลังทำงาน`;
    const embedDesc = totalActive > 0
        ? 'เลือก Token ที่ต้องการหยุดจากเมนูด้านล่าง หรือกดปุ่ม **STOP ALL** เพื่อหยุดทั้งหมด'
        : 'สามารถกด **START NOW** หรือ **AUTO DAILY** ได้เลย';

    const embed = new MessageEmbed()
        .setTitle(embedTitle)
        .setColor(totalActive > 0 ? '#ED4245' : '#57F287')
        .setDescription([
            notice ? `${notice}\n` : '',
            embedDesc
        ].filter(Boolean).join('\n'))
        .setTimestamp();

    if (totalActive > 0) {
        embed.setFooter({ text: `Auto Daily: ${rows.length} · กำลังทำงานอยู่: ${oneShotJobs.length + scheduledJobs.length}` });
    }

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
            .setEmoji(config.emojis?.loading_circle || config.emojis?.loading || '🔄')
            .setStyle('SECONDARY'),
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_STOP_ALL)
            .setLabel('STOP ALL')
            .setEmoji(config.emojis?.stop || '🛑')
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
                content: `> ${config.emojis?.no_entry || '⛔'} คำสั่งเปิดแผงควบคุม \`/quest panel\` สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
                flags: 64
            });
        }
        const showDaily = interaction.options?.getBoolean?.('auto_daily') === true;
        const bannerPath = getQuestBannerPath();
        const hasAttachment = Boolean(bannerPath);
        const embed = buildQuestPanelEmbed(interaction, { hasAttachment });
        const row = buildQuestPanelRow({ showDaily });
        const payload = { embeds: [embed], components: [row] };
        if (hasAttachment) {
            payload.files = [new AttachmentBuilder(bannerPath, { name: QUEST_BANNER_ATTACHMENT_NAME })];
        }
        return interaction.reply(payload);
    }

    return safeReply(interaction, {
        content: `> ${config.emojis?.error || '❌'} คำสั่งย่อยไม่ถูกต้อง กรุณาใช้ \`/quest panel\``,
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
        if (typeof interaction.deferReply === 'function') {
            await interaction.deferReply({ flags: 64 });
            await interaction.editReply({ content: `${config.emojis?.loading_circle || config.emojis?.loading || '⏳'} กำลังโหลด...` }).catch(() => null);
            const payload = await buildStopPanelPayload(interaction.user.id);
            return interaction.editReply({ content: null, ...payload });
        }
        const payload = await buildStopPanelPayload(interaction.user.id);
        return interaction.reply({ ...payload, flags: 64 });
    }

    if (customId === IDS.BTN_QUEST_REFRESH) {
        if (typeof interaction.deferUpdate === 'function') {
            await interaction.deferUpdate();
            const payload = await buildStopPanelPayload(interaction.user.id, `${config.emojis?.loading_circle || config.emojis?.loading || '🔄'} อัปเดตสถานะแล้ว`);
            return interaction.editReply(payload);
        }
        const payload = await buildStopPanelPayload(interaction.user.id, `${config.emojis?.loading_circle || config.emojis?.loading || '🔄'} อัปเดตสถานะแล้ว`);
        return interaction.update(payload);
    }

    if (customId === IDS.BTN_QUEST_STOP_ALL) {
        if (typeof interaction.deferUpdate === 'function') {
            await interaction.deferUpdate();
        }
        const stoppedCount = stopAllForUser(interaction.user.id);
        const scheduledList = await listScheduledRunners(interaction.user.id).catch(() => []);
        for (const r of scheduledList) {
            stopScheduledJob(interaction.user.id, String(r._id));
        }
        const totalStopped = stoppedCount + scheduledList.length;
        const payload = await buildStopPanelPayload(
            interaction.user.id,
            totalStopped > 0
                ? `> ${config.emojis?.stop || '🛑'} สั่งหยุด Runner ทั้งหมดแล้ว **${totalStopped}** รายการ`
                : `> ${config.emojis?.alert || 'ℹ️'} ไม่มี Runner ที่กำลังทำงาน`
        );
        if (typeof interaction.editReply === 'function' && interaction.deferred) {
            return interaction.editReply(payload);
        }
        return interaction.update(payload);
    }

    return safeReply(interaction, {
        content: `> ${config.emojis?.warning || '⚠️'} ปุ่มควบคุมนี้หมดอายุหรือไม่รองรับแล้ว`,
        flags: 64
    });
}

async function handleQuestSelect(interaction) {
    if (interaction.customId !== IDS.SELECT_QUEST_STOP) return;

    if (typeof interaction.deferUpdate === 'function') {
        await interaction.deferUpdate();
    }

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
            ? `> ${config.emojis?.stop || '🛑'} สั่งหยุด Auto Daily Runner ที่เลือกแล้ว **${stopped}** บัญชี`
            : `> ${config.emojis?.success || '✅'} ดำเนินการหยุดรายการที่เลือกเรียบร้อยแล้ว`
    );
    if (typeof interaction.editReply === 'function' && interaction.deferred) {
        return interaction.editReply(payload);
    }
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
            content: `> ${config.emojis?.error || '❌'} ไม่พบ Token กรุณาระบุอย่างน้อย 1 Token ในแบบฟอร์ม`,
            flags: 64
        });
    }

    if (tokens.length > 10) {
        return safeReply(interaction, {
            content: `> ${config.emojis?.error || '❌'} สามารถส่งได้สูงสุด **10 บัญชี** ต่อครั้ง กรุณาแบ่งส่งใหม่`,
            flags: 64
        });
    }

    await interaction.deferReply({ flags: 64 });
    await interaction.editReply({ content: `${config.emojis?.loading || '⏳'} กำลังโหลด...` }).catch(() => null);

    const results = await startUserQuestSession({
        client: interaction.client,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        tokens,
        mode
    });

    const lines = results.map((r) => r.line || (r.started ? `${config.emojis?.check_alt || config.emojis?.success || '✅'} เริ่มสำเร็จ: ${r.username}` : `${config.emojis?.red_card || config.emojis?.error || '❌'} เริ่มไม่สำเร็จ`));
    const anyStarted = results.some((r) => r.started);

    const boostEmoji = config.emojis?.boost || '🚀';
    const activateEmoji = config.emojis?.activate || boostEmoji;
    let finalContent = lines.join('\n');
    if (isDaily && anyStarted) {
        finalContent = `**${activateEmoji} AUTO DAILY QUEST เปิดใช้งานแล้ว**\n\n${finalContent}\n\nระบบได้ส่งข้อความสถานะสดไปยัง **DM (แชทส่วนตัว)** ของคุณเรียบร้อยแล้ว (หากปิดรับ DM ระบบจะยังคงทำงานต่อไปในเบื้องหลังตามปกติ) และสามารถใช้ปุ่ม **STOP** เพื่อหยุดได้ตลอดเวลา`;
    } else if (anyStarted) {
        finalContent = `**${activateEmoji} เริ่มต้นทำงาน ONE-SHOT QUEST แล้ว**\n\n${finalContent}\n\nระบบกำลังเริ่มทำเควสต์และส่งข้อความสถานะสดไปยัง **DM (แชทส่วนตัว)** ของคุณเรียบร้อยแล้ว (หากปิดรับ DM ระบบจะยังคงทำงานต่อไปในเบื้องหลังตามปกติ)`;
    }

    return interaction.editReply({ content: finalContent });
}

module.exports = {
    handleQuestCommand,
    handleQuestButton,
    handleQuestSelect,
    handleQuestModalSubmit,
    buildQuestPanelRow
};
