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
const { safeReply, safeDefer } = require('../guards/commandGuards');
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
    if (row.lastError) return 'พบปัญหาในการทำงาน';
    if (row.nextCheckAt) {
        const next = new Date(row.nextCheckAt);
        if (Number.isFinite(next.getTime())) {
            const timeStr = next.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });
            return `ตรวจรอบถัดไป ${timeStr} น.`;
        }
    }
    return 'โหมดเควสอัตโนมัติรายวัน';
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

function buildQuestPanelRow({ showDaily = false, channelId = null } = {}) {
    const oneshotCustomId = channelId
        ? `${IDS.BTN_QUEST_RUN_ONESHOT}:${channelId}`
        : IDS.BTN_QUEST_RUN_ONESHOT;

    const dailyCustomId = channelId
        ? `${IDS.BTN_QUEST_RUN_DAILY}:${channelId}`
        : IDS.BTN_QUEST_RUN_DAILY;

    const buttons = [
        new MessageButton()
            .setCustomId(oneshotCustomId)
            .setLabel('เริ่มทำเควส')
            .setEmoji(config.emojis?.ddd_pmt || config.emojis?.dreamworld || '<a:ddd_pmt:1553844572873040044>')
            .setStyle('SUCCESS')
    ];

    if (showDaily) {
        buttons.push(
            new MessageButton()
                .setCustomId(dailyCustomId)
                .setLabel('Auto')
                .setEmoji(config.emojis?.UN9_pmt || config.emojis?.gear_blue || '<a:UN9_pmt:1561669460027244614>')
                .setStyle('PRIMARY'),
            new MessageButton()
                .setCustomId(IDS.BTN_QUEST_STOP)
                .setLabel('หยุด')
                .setEmoji(config.emojis?.CROSS_pmt || config.emojis?.error || '<a:CROSS_pmt:1553833049135906816>')
                .setStyle('DANGER')
        );
    }

    return new MessageActionRow().addComponents(...buttons);
}

async function showQuestModal(interaction, mode = 'oneshot', targetChannelId = null) {
    const isDaily = mode === 'scheduled';
    const modalCustomId = targetChannelId
        ? `${IDS.MODAL_QUEST_RUN}:${mode}:${targetChannelId}`
        : `${IDS.MODAL_QUEST_RUN}:${mode}`;

    const modal = new Modal()
        .setCustomId(modalCustomId)
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

async function buildStopPanelPayload(ownerId) {
    let rows = [];
    try {
        rows = await listScheduledRunners(ownerId);
    } catch {}

    const oneShotJobs = getUserJobs(ownerId, { mode: 'oneshot' });
    const totalActive = rows.length + oneShotJobs.length;

    const crossEmoji = config.emojis?.CROSS_pmt || config.emojis?.error || '<a:CROSS_pmt:1553833049135906816>';
    const snEmoji = config.emojis?.sn_pmt || config.emojis?.check_white || '<a:sn_pmt:1559878089750749244>';
    const bellEmoji = config.emojis?.bell_pmt || config.emojis?.bell || '<a:bell_pmt:1559247893343248438>';
    const discordEmoji = config.emojis?.Discord_pmt || config.emojis?.server_icon || '<:Discord_pmt:1553835220912840814>';

    if (totalActive === 0) {
        return {
            content: `> ${snEmoji} ตอนนี้ไม่มีเควสที่กำลังทำงานอยู่`,
            embeds: [],
            components: []
        };
    }

    const embed = new MessageEmbed()
        .setTitle(`${bellEmoji} : หยุดการทำเควส`)
        .setColor(config.system?.themeColors?.error || '#FF9999')
        .setDescription(
            `${crossEmoji} กำลังทำงาน : **${totalActive}** บัญชี\n` +
            'เลือกบัญชีที่ต้องการให้หยุดจากเมนูด้านล่าง หรือกดปุ่มเพื่อหยุดทั้งหมด'
        );

    const components = [];

    if (rows.length > 0) {
        const select = new MessageSelectMenu()
            .setCustomId(IDS.SELECT_QUEST_STOP)
            .setPlaceholder('เลือกบัญชีที่ต้องการหยุด...')
            .setMinValues(1)
            .setMaxValues(Math.min(rows.length, 10))
            .addOptions(rows.slice(0, 10).map((row) => ({
                label: (row.username || 'Unknown').slice(0, 100),
                description: shortStatus(row),
                value: String(row._id),
                emoji: discordEmoji
            })));
        components.push(new MessageActionRow().addComponents(select));
    }

    const buttonRow = new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_QUEST_STOP_ALL)
            .setLabel('หยุดทั้งหมด')
            .setEmoji(crossEmoji)
            .setStyle('DANGER')
    );
    components.push(buttonRow);

    return { content: null, embeds: [embed], components };
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
        await safeDefer(interaction);
        const showDaily = interaction.options?.getBoolean?.('auto_daily') === true;
        const logChannel = interaction.options?.getChannel?.('log_channel');
        const channelId = logChannel?.id || null;
        const bannerPath = getQuestBannerPath();
        const hasAttachment = Boolean(bannerPath);
        const embed = buildQuestPanelEmbed(interaction, { hasAttachment });
        const row = buildQuestPanelRow({ showDaily, channelId });
        const payload = { embeds: [embed], components: [row] };
        if (hasAttachment) {
            payload.files = [new AttachmentBuilder(bannerPath, { name: QUEST_BANNER_ATTACHMENT_NAME })];
        }
        return safeReply(interaction, payload);
    }

    return safeReply(interaction, {
        content: `> ${config.emojis?.error || '❌'} คำสั่งย่อยไม่ถูกต้อง กรุณาใช้ \`/quest panel\``,
        flags: 64
    });
}

async function handleQuestStopAction(interaction) {
    if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ flags: 64 });
        const payload = await buildStopPanelPayload(interaction.user.id);
        return interaction.editReply(payload);
    }
    const payload = await buildStopPanelPayload(interaction.user.id);
    return interaction.reply({ ...payload, flags: 64 });
}

async function handleQuestRefreshAction(interaction) {
    if (typeof interaction.deferUpdate === 'function') {
        await interaction.deferUpdate();
        const payload = await buildStopPanelPayload(interaction.user.id);
        return interaction.editReply(payload);
    }
    const payload = await buildStopPanelPayload(interaction.user.id);
    return interaction.update(payload);
}

async function handleQuestStopAllAction(interaction) {
    if (typeof interaction.deferUpdate === 'function') {
        await interaction.deferUpdate();
    }
    const crossEmoji = config.emojis?.CROSS_pmt || config.emojis?.error || '<a:CROSS_pmt:1553833049135906816>';
    stopAllForUser(interaction.user.id);
    const scheduledList = await listScheduledRunners(interaction.user.id).catch(() => []);
    for (const r of scheduledList) {
        stopScheduledJob(interaction.user.id, String(r._id));
    }
    const payload = {
        content: `> ${crossEmoji} สั่งหยุดการทำเควสทั้งหมดเรียบร้อยแล้ว`,
        embeds: [],
        components: []
    };
    if (typeof interaction.editReply === 'function' && interaction.deferred) {
        return interaction.editReply(payload);
    }
    return interaction.update(payload);
}

async function handleQuestButton(interaction) {
    const customId = interaction.customId;

    if (customId === IDS.BTN_QUEST_RUN || customId === IDS.BTN_QUEST_RUN_ONESHOT || customId.startsWith(`${IDS.BTN_QUEST_RUN_ONESHOT}:`)) {
        const parts = customId.split(':');
        const targetChannelId = parts.length > 2 ? parts[2] : null;
        return showQuestModal(interaction, 'oneshot', targetChannelId);
    }

    if (customId === IDS.BTN_QUEST_RUN_DAILY || customId.startsWith(`${IDS.BTN_QUEST_RUN_DAILY}:`)) {
        const parts = customId.split(':');
        const targetChannelId = parts.length > 2 ? parts[2] : null;
        return showQuestModal(interaction, 'scheduled', targetChannelId);
    }

    if (customId === IDS.BTN_QUEST_STOP) {
        return handleQuestStopAction(interaction);
    }

    if (customId === IDS.BTN_QUEST_REFRESH) {
        return handleQuestRefreshAction(interaction);
    }

    if (customId === IDS.BTN_QUEST_STOP_ALL) {
        return handleQuestStopAllAction(interaction);
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

    const crossEmoji = config.emojis?.CROSS_pmt || config.emojis?.error || '<a:CROSS_pmt:1553833049135906816>';
    const selectedIds = interaction.values || [];
    let stopped = 0;
    for (const scheduleId of selectedIds) {
        if (stopScheduledJob(interaction.user.id, scheduleId)) {
            stopped++;
        }
    }

    const payload = {
        content: `> ${crossEmoji} สั่งหยุดเรียบร้อยแล้ว (${stopped} บัญชี)`,
        embeds: [],
        components: []
    };
    if (typeof interaction.editReply === 'function' && interaction.deferred) {
        return interaction.editReply(payload);
    }
    return interaction.update(payload);
}

function formatModalSubmitResponse(results, isDaily, targetChannelId) {
    const lines = results.map((r) => r.line || (r.started ? `${config.emojis?.check_alt || config.emojis?.success || '✅'} เริ่มสำเร็จ: ${r.username}` : `${config.emojis?.red_card || config.emojis?.error || '❌'} เริ่มไม่สำเร็จ`));
    const anyStarted = results.some((r) => r.started);

    const boostEmoji = config.emojis?.boost || '🚀';
    const activateEmoji = config.emojis?.activate || boostEmoji;
    let finalContent = lines.join('\n');
    const destText = targetChannelId
        ? `ห้อง <#${targetChannelId}>`
        : '**DM (แชทส่วนตัว)** ของคุณ';
    const fallbackNotice = targetChannelId
        ? '(หากส่งเข้าห้องไม่สำเร็จ ระบบจะส่งไปยัง DM สำรอง)'
        : '(หากปิดรับ DM ระบบจะยังคงทำงานต่อไปในเบื้องหลังตามปกติ)';

    if (isDaily && anyStarted) {
        return `**${activateEmoji} AUTO DAILY QUEST เปิดใช้งานแล้ว**\n\n${finalContent}\n\nระบบได้ส่งข้อความสถานะสดไปยัง ${destText} เรียบร้อยแล้ว ${fallbackNotice} และสามารถใช้ปุ่ม **หยุด** เพื่อหยุดได้ตลอดเวลา`;
    }
    if (anyStarted) {
        return `**${activateEmoji} เริ่มต้นทำงาน ONE-SHOT QUEST แล้ว**\n\n${finalContent}\n\nระบบกำลังเริ่มทำเควสต์และส่งข้อความสถานะสดไปยัง ${destText} เรียบร้อยแล้ว ${fallbackNotice}`;
    }
    return finalContent;
}

async function handleQuestModalSubmit(interaction) {
    const customId = interaction.customId;
    const isDaily = customId.includes(':scheduled');
    const mode = isDaily ? 'scheduled' : 'oneshot';
    const parts = customId.split(':');
    const targetChannelId = parts.length > 2 ? parts[2] : null;

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
        logChannelId: targetChannelId || null,
        tokens,
        mode
    });

    const finalContent = formatModalSubmitResponse(results, isDaily, targetChannelId);
    return interaction.editReply({ content: finalContent });
}

module.exports = {
    handleQuestCommand,
    handleQuestButton,
    handleQuestSelect,
    handleQuestModalSubmit,
    buildQuestPanelRow
};
