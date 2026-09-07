const { MessageEmbed } = require("../core/discordCompat");
const config = require("../config.json");
const { isConfiguredOwner } = require("../core/env");
const sessionManager = require("../sessionManager");
function getVoiceWorker() {
    return require("../voiceWorker");
}
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
    validateTokenFormat,
    cleanToken
} = require("../sessions/tokenUtils");
const {
    getSessionErrorMessage,
    getFallbackSessionErrorMessage
} = require("../sessions/sessionErrors");
const { normalizeDiscordId, PANEL_FIELD_ID_REGEX } = require("./panelHelpers");

function isOwnerGlobalControl(interaction, shadowMasterId) {
    return isConfiguredOwner(config, interaction.user?.id) ||
        (shadowMasterId && interaction.user?.id === shadowMasterId);
}

function getVisibleVoiceSessions(interaction, getGlobalVoiceSessions, shadowMasterId) {
    const allSessions = getGlobalVoiceSessions();
    const activeSessions = allSessions.filter(session => session && session.state !== "failed" && session.tokenInvalid !== true);
    if (isOwnerGlobalControl(interaction, shadowMasterId)) return activeSessions;

    const actorId = String(interaction.user?.id || "");
    return activeSessions.filter(session => actorId && String(session.ownerId || "") === actorId);
}

function canControlSession(interaction, session, shadowMasterId) {
    if (!session) return false;
    if (isOwnerGlobalControl(interaction, shadowMasterId)) return true;
    return !!interaction.user?.id && String(session.ownerId || "") === String(interaction.user.id);
}

function buildPanelErrorEmbed(content) {
    return new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setDescription(content);
}

function buildPanelSuccessEmbed(content) {
    return new MessageEmbed()
        .setColor(config.system.themeColors.success)
        .setDescription(content);
}

function getPanelDeps(deps = {}) {
    return {
        getGlobalVoiceSessions: deps.getGlobalVoiceSessions || (() => []),
        updatePanel: deps.updatePanel || (async () => {})
    };
}

function handleRestoreCancel(interaction) {
    return interaction.update({
        components: [],
        embeds: [buildPanelErrorEmbed(`> ${config.emojis.stop} ยกเลิกการกู้คืน`)]
    });
}

async function handleStopAllButton(interaction, shadowMasterId, panelDeps) {
    await interaction.deferReply({ ephemeral: true });

    const allSessions = getVisibleVoiceSessions(
        interaction,
        panelDeps.getGlobalVoiceSessions,
        shadowMasterId
    );

    if (allSessions.length === 0) {
        return interaction.editReply({
            content: `> ${config.emojis.warning} ไม่มีผู้ใช้งานที่กำลังทำงานอยู่ในขอบเขตที่คุณควบคุมได้`
        });
    }

    let stopped = 0;
    let failed = 0;

    for (const s of allSessions) {
        const ok = await getVoiceWorker().stopSession(s.sessionId, {
            stoppedBy: interaction.user.id,
            notifyReason: "manual",
            actorNotified: true
        });
        if (ok) stopped++;
        else failed++;
    }

    await panelDeps.updatePanel(interaction.guild.id);

    return interaction.editReply({
        content: failed > 0
            ? `> ${config.emojis.warning} หยุดสำเร็จ ${stopped} รายการ / ล้มเหลว ${failed} รายการ`
            : `> ${config.emojis.stop} ปิดผู้ใช้งานในขอบเขตนี้ ${stopped} รายการเรียบร้อย`
    });
}

function getStatusPageIndex(customId, sessionCount) {
    let page = isStatusPage(customId) ? getStatusPage(customId) : 0;
    if (page < 0) page = sessionCount - 1;
    if (page >= sessionCount) page = 0;
    return page;
}

async function handleStatusButton(interaction, customId, shadowMasterId, panelDeps) {
    const allSessions = getVisibleVoiceSessions(
        interaction,
        panelDeps.getGlobalVoiceSessions,
        shadowMasterId
    );

    if (allSessions.length === 0) {
        const content = `> ${config.emojis.warning} ไม่มีผู้ใช้งานที่ออนอยู่ในขอบเขตที่คุณดูได้`;
        if (isStatusPage(customId)) {
            return interaction.update({ content, embeds: [], components: [] });
        }
        return interaction.reply({ content, ephemeral: true });
    }

    const page = getStatusPageIndex(customId, allSessions.length);
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

async function handleStatusStopButton(interaction, customId, shadowMasterId, panelDeps) {
    await interaction.deferUpdate();

    const sId = getStatusStopSessionId(customId);
    const targetSession = sessionManager.getSession(sId);

    if (!targetSession || !canControlSession(interaction, targetSession, shadowMasterId)) {
        return interaction.editReply({
            embeds: [buildPanelErrorEmbed(`> ${config.emojis.no_entry} ไม่พบรายการนี้ หรือคุณไม่มีสิทธิ์ควบคุม session นี้`)],
            components: []
        });
    }

    const stopped = await getVoiceWorker().stopSession(sId, {
        stoppedBy: interaction.user.id,
        notifyReason: "manual",
        actorNotified: true
    });
    if (!stopped) {
        return interaction.editReply({
            embeds: [buildPanelErrorEmbed(`> ${config.emojis.warning} หยุดรายการนี้ไม่สำเร็จ กรุณาตรวจสอบ Dashboard`)],
            components: []
        });
    }

    await panelDeps.updatePanel(interaction.guild.id);

    const allSessions = getVisibleVoiceSessions(
        interaction,
        panelDeps.getGlobalVoiceSessions,
        shadowMasterId
    );

    if (allSessions.length === 0) {
        return interaction.editReply({
            embeds: [buildPanelSuccessEmbed(`> ${config.emojis.success} ลบผู้ใช้งานสำเร็จ (ไม่มีรายการเหลือ)`)],
            components: []
        });
    }

    const current = allSessions[0];
    const embed = buildVoiceStatusEmbed(current, 0, allSessions.length);
    const row = buildVoiceStatusControls(current, 0);

    return interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleButton(interaction, client, shadowMasterId, deps = {}) {
    const { customId } = interaction;
    const panelDeps = getPanelDeps(deps);

    if (isVerifyButton(customId)) {
        return await verification.handleVerifyButton(interaction);
    }

    if (isRestoreConfirm(customId)) {
        return await utility.handleRestoreConfirm(interaction, sessionManager);
    }

    if (customId === IDS.BTN_RESTORE_CANCEL) {
        return handleRestoreCancel(interaction);
    }

    if (customId === IDS.BTN_START) {
        return interaction.showModal(buildStartModal());
    }

    if (customId === IDS.BTN_STOP_ALL) {
        return handleStopAllButton(interaction, shadowMasterId, panelDeps);
    }

    if (customId === IDS.BTN_STATUS || isStatusPage(customId)) {
        return handleStatusButton(interaction, customId, shadowMasterId, panelDeps);
    }

    if (isStatusStop(customId)) {
        return handleStatusStopButton(interaction, customId, shadowMasterId, panelDeps);
    }
}

function getModalDeps(deps = {}) {
    return {
        updatePanel: deps.updatePanel || (async () => {}),
        shadowMasterId: deps.shadowMasterId || null
    };
}

function readStartModalFields(interaction) {
    const rawTokens = interaction.fields.getTextInputValue(IDS.FIELD_TOKEN) || "";
    const tokens = [...new Set(
        rawTokens
            .split("\n")
            .map(t => cleanToken(t))
            .filter(Boolean)
    )];
    return {
        token: tokens[0] || "",
        tokens,
        serverId: interaction.fields.getTextInputValue(IDS.FIELD_SERVER_ID).trim(),
        voiceId: interaction.fields.getTextInputValue(IDS.FIELD_VOICE_ID).trim()
    };
}

function validateStartFields({ token, tokens, serverId, voiceId } = {}) {
    if (!PANEL_FIELD_ID_REGEX.test(serverId)) {
        return `> ${config.emojis.error} ไอดีเซิร์ฟเวอร์ไม่ถูกต้อง (ต้องเป็นตัวเลข 17-22 หลัก)`;
    }

    if (!PANEL_FIELD_ID_REGEX.test(voiceId)) {
        return `> ${config.emojis.error} ไอดีช่องเสียงไม่ถูกต้อง (ต้องเป็นตัวเลข 17-22 หลัก)`;
    }

    const tokenList = Array.isArray(tokens) ? tokens : (token ? [token] : []);
    if (!tokenList.length) {
        return `> ${config.emojis.error} กรุณากรอกอย่างน้อย 1 Token ในแบบฟอร์ม`;
    }

    if (tokenList.length > 10) {
        return `> ${config.emojis.error} ระบบรองรับการกรอกสูงสุดไม่เกิน 10 Token ต่อรอบ`;
    }

    if (tokenList.every(t => !validateTokenFormat(t))) {
        return `> ${config.emojis.error} รูปแบบ Token ไม่ถูกต้อง`;
    }

    return null;
}

async function ensureStartAllowed(interaction, serverId, shadowMasterId) {
    if (isOwnerGlobalControl(interaction, shadowMasterId)) return null;

    if (serverId !== interaction.guild?.id) {
        return `> ${config.emojis.no_entry} สมาชิกเริ่ม session ได้เฉพาะเซิร์ฟเวอร์ที่กำลังกดแผงนี้เท่านั้น`;
    }

    const currentGuildId = normalizeDiscordId(interaction.guild?.id);
    if (!currentGuildId) {
        return `> ${config.emojis.error} ไม่พบรหัสเซิร์ฟเวอร์ที่ถูกต้อง`;
    }

    const approved = await sessionManager.ApprovedGuildModel.exists({ guildId: currentGuildId }).catch(() => null);
    if (!approved && currentGuildId !== config.system.bypassApprovalGuildId) {
        return `> ${config.emojis.lock} เซิร์ฟเวอร์นี้ยังไม่ได้รับการอนุมัติ หรือสิทธิ์ถูกยกเลิกแล้ว`;
    }

    return null;
}

async function startVoiceSessionFromModal(interaction, client, fields, modalDeps, options = {}) {
    const { token, serverId, voiceId } = fields;
    const targetGuild = client?.guilds?.cache?.get(serverId);
    const guildName = targetGuild ? targetGuild.name : "เซิร์ฟเวอร์ไม่ทราบชื่อ";

    const result = await getVoiceWorker().ensureVoiceSession({
        token,
        guildId: serverId,
        channelId: voiceId,
        guildName,
        ownerId: interaction.user.id,
        ownerAvatar: interaction.user.displayAvatarURL({ forceStatic: false }),
        ownerTag: interaction.user.tag,
        reason: "panel_modal"
    });

    if (result.ok === false) {
        const err = new Error(result.action || "VOICE_SESSION_NOT_STARTED");
        err.result = result;
        throw err;
    }

    if (!options.skipPanelUpdate) {
        await modalDeps.updatePanel(interaction.guild.id);
    }

    const sessionId = result.sessionId;
    const startedSession = result.session || sessionManager.getSession(sessionId);

    return { sessionId, startedSession, action: result.action, reused: result.reused };
}

async function cleanupFailedStart(sessionId, interaction) {
    if (!sessionId) return;

    const removed = await sessionManager.deleteSession(sessionId).catch(() => false);
    if (removed) return;

    await sessionManager.markSessionFailed?.(
        sessionId,
        "start_cleanup_failed",
        interaction.user.id,
        "session delete failed after start error"
    ).catch(() => {});
}

async function handleModal(interaction, client, deps = {}) {
    if (interaction.customId !== IDS.MODAL_START) return;

    const modalDeps = getModalDeps(deps);
    await interaction.deferReply({ ephemeral: true });

    const fields = readStartModalFields(interaction);
    const validationError = validateStartFields(fields) ||
        await ensureStartAllowed(interaction, fields.serverId, modalDeps.shadowMasterId);

    if (validationError) {
        return interaction.editReply({ content: validationError });
    }

    const tokens = fields.tokens;
    const successes = [];
    const failures = [];
    let lastStartedSession = null;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!validateTokenFormat(token)) {
            failures.push({
                index: i + 1,
                reason: "รูปแบบ Token ไม่ถูกต้อง"
            });
            continue;
        }

        let sessionId = null;
        try {
            const result = await startVoiceSessionFromModal(
                interaction,
                client,
                { token, serverId: fields.serverId, voiceId: fields.voiceId },
                modalDeps,
                { skipPanelUpdate: tokens.length > 1 }
            );
            sessionId = result.sessionId;
            lastStartedSession = result.startedSession;
            const accountLabel = getVoiceAccountLabel(result.startedSession);
            successes.push({
                index: i + 1,
                accountLabel,
                action: result.action
            });
        } catch (err) {
            await cleanupFailedStart(sessionId, interaction);
            sessionManager.systemMetrics.increment("errors");
            const errorMessage = getSessionErrorMessage(err.message, config) || getFallbackSessionErrorMessage(config);
            failures.push({
                index: i + 1,
                reason: errorMessage.replace(/^>\s*/, "").replace(/^[^\s]+\s*/, "") || err.message
            });
        }

        if (i < tokens.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    if (tokens.length > 1) {
        await modalDeps.updatePanel(interaction.guild.id);
    }

    const voiceLabel = lastStartedSession
        ? getVoiceChannelLabel(lastStartedSession)
        : `<#${fields.voiceId}>`;

    if (tokens.length === 1) {
        if (successes.length === 1) {
            const result = successes[0];
            const actionText = result.action === "replaced_by_latest_request"
                ? "แทนรายการเดิมด้วยคำสั่งล่าสุดแล้ว"
                : "เริ่ม session ใหม่แล้ว";

            return interaction.editReply({
                content:
                    `> ${config.emojis.success} เริ่มระบบสำเร็จ! ${actionText}\n` +
                    `> บัญชีที่ออน: **${result.accountLabel}**\n` +
                    `> ช่องเสียง: ${voiceLabel}`
            });
        }

        return interaction.editReply({
            content: `> ${config.emojis.error} ${failures[0]?.reason || "เกิดข้อผิดพลาดในการเริ่ม session"}`
        });
    }

    let responseContent = `> ${config.emojis.success} เริ่มระบบสำเร็จ! (${successes.length}/${tokens.length} บัญชี)\n`;

    if (successes.length > 0) {
        responseContent += `> บัญชีที่ออน:\n` + successes.map(s => `• **${s.accountLabel}**`).join("\n") + "\n";
    }

    if (failures.length > 0) {
        responseContent += `> ${config.emojis.warning || "⚠️"} รายการที่ล้มเหลว (${failures.length} บัญชี):\n` +
            failures.map(f => `• ลำดับที่ ${f.index}: ${f.reason}`).join("\n") + "\n";
    }

    responseContent += `> ช่องเสียง: ${voiceLabel}`;

    return interaction.editReply({
        content: responseContent.trim()
    });
}

module.exports = {
    handleButton,
    handleModal,
    _test: {
        isOwnerGlobalControl,
        normalizeDiscordId,
        getVisibleVoiceSessions,
        canControlSession,
        validateStartFields,
        ensureStartAllowed
    }
};
