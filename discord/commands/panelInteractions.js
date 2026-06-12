const { MessageEmbed, WebhookClient } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const voiceWorker = require("../voiceWorker");
const utility = require("./utility");
const verification = require("./verification");
const {
    IDS,
    isVerifyButton,
    isRestoreConfirm,
    isStatusPage,
    getStatusPage,
    isStatusStop,
    getStatusStopSessionId
} = require("./customIds");
const {
    buildStartModal,
    buildVoiceStatusEmbed,
    buildVoiceStatusControls
} = require("./panelViews");
const {
    getVoiceAccountLabel,
    getVoiceChannelLabel
} = require("../sessions/voiceLabels");
const {
    decodeTokenOwnerIdSafe,
    validateTokenFormat
} = require("../sessions/tokenUtils");
const {
    getSessionErrorMessage,
    getFallbackSessionErrorMessage
} = require("../sessions/sessionErrors");

async function handleButton(interaction, client, shadowMasterId, deps = {}) {
    const { customId } = interaction;
    const getGlobalVoiceSessions = deps.getGlobalVoiceSessions || (() => []);
    const updatePanel = deps.updatePanel || (async () => {});

    if (isVerifyButton(customId)) {
        return await verification.handleVerifyButton(interaction);
    }

    if (isRestoreConfirm(customId)) {
        return await utility.handleRestoreConfirm(interaction, sessionManager);
    }

    if (customId === IDS.BTN_RESTORE_CANCEL) {
        return interaction.update({
            components: [],
            embeds: [
                new MessageEmbed()
                    .setColor(config.system.themeColors.error)
                    .setDescription(`> ${config.emojis.stop} ยกเลิกการกู้คืน`)
            ]
        });
    }

    if (customId === IDS.BTN_START) {
        return interaction.showModal(buildStartModal());
    }

    if (customId === IDS.BTN_STOP_ALL) {
        await interaction.deferReply({ ephemeral: true });

        const allSessions = getGlobalVoiceSessions();

        if (allSessions.length === 0) {
            return interaction.editReply({
                content: `> ${config.emojis.warning} ไม่มีผู้ใช้งานที่กำลังทำงานอยู่ในระบบ`
            });
        }

        let stopped = 0;
        let failed = 0;

        for (const s of allSessions) {
            const ok = await voiceWorker.stopSession(s.sessionId, { stoppedBy: interaction.user.id });
            if (ok) stopped++;
            else failed++;
        }

        await updatePanel(interaction.guild.id);

        return interaction.editReply({
            content: failed > 0
                ? `> ${config.emojis.warning} หยุดสำเร็จ ${stopped} รายการ / ล้มเหลว ${failed} รายการ`
                : `> ${config.emojis.stop} ปิดผู้ใช้งานทั้งหมดในระบบ ${stopped} รายการเรียบร้อย`
        });
    }

    if (customId === IDS.BTN_STATUS || isStatusPage(customId)) {
        const allSessions = getGlobalVoiceSessions();

        if (allSessions.length === 0) {
            const msg = {
                content: `> ${config.emojis.warning} ไม่มีผู้ใช้งานที่ออนอยู่ในระบบ`,
                ephemeral: true
            };

            if (isStatusPage(customId)) {
                return interaction.update({ content: msg.content, embeds: [], components: [] });
            }

            return interaction.reply(msg);
        }

        let page = 0;

        if (isStatusPage(customId)) {
            page = getStatusPage(customId);
        }

        if (page < 0) page = allSessions.length - 1;
        if (page >= allSessions.length) page = 0;

        const current = allSessions[page];
        const embed = buildVoiceStatusEmbed(current, page, allSessions.length);
        const row = buildVoiceStatusControls(current, page);

        if (isStatusPage(customId)) {
            return interaction.update({ embeds: [embed], components: [row] });
        }

        return interaction.reply({
            embeds: [embed],
            components: [row],
            ephemeral: true
        });
    }

    if (isStatusStop(customId)) {
        await interaction.deferUpdate();

        const sId = getStatusStopSessionId(customId);
        const targetSession = sessionManager.getSession(sId);

        if (!targetSession) {
            return interaction.editReply({
                embeds: [
                    new MessageEmbed()
                        .setColor(config.system.themeColors.error)
                        .setDescription(`> ${config.emojis.no_entry} ไม่พบรายการนี้`)
                ],
                components: []
            });
        }

        const stopped = await voiceWorker.stopSession(sId, { stoppedBy: interaction.user.id });
        if (!stopped) {
            return interaction.editReply({
                embeds: [
                    new MessageEmbed()
                        .setColor(config.system.themeColors.error)
                        .setDescription(`> ${config.emojis.warning} หยุดรายการนี้ไม่สำเร็จ กรุณาตรวจสอบ Dashboard`)
                ],
                components: []
            });
        }

        await updatePanel(interaction.guild.id);

        const allSessions = getGlobalVoiceSessions();

        if (allSessions.length === 0) {
            return interaction.editReply({
                embeds: [
                    new MessageEmbed()
                        .setColor(config.system.themeColors.success)
                        .setDescription(`> ${config.emojis.success} ลบผู้ใช้งานสำเร็จ (ไม่มีรายการเหลือ)`)
                ],
                components: []
            });
        }

        const current = allSessions[0];
        const embed = buildVoiceStatusEmbed(current, 0, allSessions.length);
        const row = buildVoiceStatusControls(current, 0);

        return interaction.editReply({ embeds: [embed], components: [row] });
    }
}

async function handleModal(interaction, client, deps = {}) {
    if (interaction.customId !== IDS.MODAL_START) return;

    const getLogChannel = deps.getLogChannel || (async () => null);
    const updatePanel = deps.updatePanel || (async () => {});

    await interaction.deferReply({ ephemeral: true });

    const token = interaction.fields.getTextInputValue(IDS.FIELD_TOKEN).trim();
    const serverId = interaction.fields.getTextInputValue(IDS.FIELD_SERVER_ID).trim();
    const voiceId = interaction.fields.getTextInputValue(IDS.FIELD_VOICE_ID).trim();

    if (!/^\d{17,19}$/.test(serverId)) {
        return interaction.editReply({
            content: `> ${config.emojis.error} ไอดีเซิร์ฟเวอร์ไม่ถูกต้อง (ต้องเป็นตัวเลข 17-19 หลัก)`
        });
    }

    if (!/^\d{17,19}$/.test(voiceId)) {
        return interaction.editReply({
            content: `> ${config.emojis.error} ไอดีช่องเสียงไม่ถูกต้อง (ต้องเป็นตัวเลข 17-19 หลัก)`
        });
    }

    if (!validateTokenFormat(token)) {
        return interaction.editReply({
            content: `> ${config.emojis.error} รูปแบบ Token ไม่ถูกต้อง`
        });
    }

    try {
        const tokenUserId = decodeTokenOwnerIdSafe(token);

        if (tokenUserId && tokenUserId !== interaction.user.id) {
            console.warn(
                `[SECURITY] ⚠️ Token owner mismatch: tokenUser=${tokenUserId}, user=${interaction.user.id} (${interaction.user.tag})`
            );

            if (process.env.ALERT_WEBHOOK_URL) {
                const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });

                wh.send({
                    content:
                        `⚠️ **[TOKEN MISMATCH]** Token owner ≠ interaction user!\n` +
                        `**Token User ID:** \`${tokenUserId}\`\n` +
                        `**Used By:** <@${interaction.user.id}> (\`${interaction.user.tag}\`)\n` +
                        `**Guild:** ${interaction.guild?.name} (\`${interaction.guild?.id}\`)`
                }).catch(() => {}).finally(() => wh.destroy());
            }
        } else if (!tokenUserId) {
            console.warn(
                `[SECURITY] ⚠️ Token owner could not be decoded safely. user=${interaction.user.id} (${interaction.user.tag})`
            );
        }
    } catch {
        console.warn(
            `[SECURITY] ⚠️ Token owner decode failed safely. user=${interaction.user.id} (${interaction.user.tag})`
        );
    }

    const targetGuild = client.guilds.cache.get(serverId);
    const guildName = targetGuild ? targetGuild.name : "เซิร์ฟเวอร์ไม่ทราบชื่อ";

    let sessionId = null;

    try {
        await voiceWorker.repairFailedStopSessionForTokenGuild?.(token, serverId);

        sessionId = await sessionManager.createSession(
            token,
            serverId,
            voiceId,
            guildName,
            interaction.user.id,
            interaction.user.displayAvatarURL({ dynamic: true }),
            interaction.user.tag
        );

        await voiceWorker.startSession(sessionId, token);
        await updatePanel(interaction.guild.id);

        const startedSession = sessionManager.getSession(sessionId);
        const accountLabel = getVoiceAccountLabel(startedSession);
        const voiceLabel = getVoiceChannelLabel(startedSession);

        const logCh = await getLogChannel(interaction.guild);

        if (logCh) {
            logCh.send({
                embeds: [
                    new MessageEmbed()
                        .setColor(config.system.themeColors.success)
                        .setDescription(
                            `> ${config.emojis.success} **เริ่มการทำงานผู้ใช้งานใหม่!**\n` +
                            `— **โดย:** <@${interaction.user.id}>\n` +
                            `— **บัญชีที่ออน:** \`${accountLabel}\`\n` +
                            `— **เซิร์ฟเวอร์:** \`${startedSession?.serverName || guildName}\`\n` +
                            `— **ช่องเสียง:** ${voiceLabel}`
                        )
                ]
            }).catch(() => {});
        }

        return interaction.editReply({
            content:
                `> ${config.emojis.success} เริ่มระบบสำเร็จ! ผู้ใช้งานเข้าห้องเสียงเรียบร้อย\n` +
                `> บัญชีที่ออน: **${accountLabel}**\n` +
                `> ช่องเสียง: ${voiceLabel}`
        });

    } catch (err) {
        if (sessionId) {
            const removed = await sessionManager.deleteSession(sessionId).catch(() => false);
            if (!removed) {
                await sessionManager.markSessionFailed?.(
                    sessionId,
                    "start_cleanup_failed",
                    interaction.user.id,
                    "session delete failed after start error"
                ).catch(() => {});
            }
        }

        sessionManager.systemMetrics.increment("errors");

        return interaction.editReply({
            content: getSessionErrorMessage(err.message, config) || getFallbackSessionErrorMessage(config)
        });
    }
}

module.exports = {
    handleButton,
    handleModal
};
