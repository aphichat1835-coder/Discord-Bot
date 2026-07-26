const { PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const { requireMemberPermission, checkRoleHierarchy, safeDefer, markCommandAccepted } = require("../guards/commandGuards");
const modCaseManager = require("../logging/modCaseManager");
const { sendWebhookEvent, getDiscordAvatarUrl, getDiscordGuildIconUrl } = require("../core/webhooks");
const dmService = require("../dm");
const {
    requiredModerationPermission,
    readModerationInput,
    parseTimeoutDuration,
    buildModerationDmEmbed,
    buildCaseInput,
    buildModerationReplyEmbed,
    moderationErrorReply
} = require("./moderationHelpers");

const VALIDATION_STOP = Symbol("VALIDATION_STOP");

async function requireModerationPermission(interaction, action) {
    return requireMemberPermission(
        interaction,
        [requiredModerationPermission(action), PermissionFlagsBits.Administrator],
        `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งานคำสั่งนี้!`,
        { mode: "any" }
    );
}

function rejectMissingTarget(interaction, target) {
    if (target) return null;
    return interaction.reply({ content: `> ${config.emojis.error} ไม่พบสมาชิกเป้าหมายในเซิร์ฟเวอร์`, ephemeral: true });
}

function rejectHierarchy(interaction, client, target) {
    const hierarchy = checkRoleHierarchy({ interaction, target, client, config });
    if (hierarchy.ok) return null;
    return interaction.reply({ content: hierarchy.content, ephemeral: true });
}

function rejectUnmanageableTarget(interaction, target, action) {
    if (target.manageable || action === "ban") return null;
    return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการสมาชิกท่านนี้`, ephemeral: true });
}

function rejectInvalidDuration(interaction, duration) {
    if (duration.ok) return null;
    return interaction.reply({ content: duration.content, ephemeral: true });
}

async function validateModerationRequest(interaction, client, input) {
    if (!await requireModerationPermission(interaction, input.action)) return VALIDATION_STOP;
    return rejectMissingTarget(interaction, input.target)
        || rejectHierarchy(interaction, client, input.target)
        || rejectUnmanageableTarget(interaction, input.target, input.action)
        || rejectInvalidDuration(interaction, input.duration);
}

async function sendModerationDm(target, embed) {
    return target.user.send({
        embeds: [embed],
        allowedMentions: { parse: [], repliedUser: false }
    }).catch(() => null);
}

function assertBotPermission(interaction, permission) {
    if (!interaction.guild.members.me.permissions.has(permission)) throw new Error("MISSING_PERMS");
}

async function queueFinalModerationDm(interaction, input, caseNumber, state, endsAt = null) {
    const embed = buildModerationDmEmbed(
        interaction,
        input.target,
        input.action,
        input.reason,
        input.duration.minutes,
        { state, caseNumber, endsAt }
    );
    return dmService.send({
        eventKey: `moderation:${interaction.guild.id}:${caseNumber}:${state}`,
        recipientId: input.target.id,
        category: "moderation",
        priority: state === "failed" ? "normal" : "high",
        payload: { embeds: [embed] }
    });
}

async function finishPendingModerationDm(message, finalEmbed, fallback) {
    if (message) {
        const edited = await message.edit({ embeds: [finalEmbed], allowedMentions: { parse: [] } }).catch(() => null);
        if (edited) return { status: "sent", message: edited };
    }
    return fallback();
}

async function applyRemovalAction(interaction, input, pendingCase, action) {
    const pendingEmbed = buildModerationDmEmbed(
        interaction, input.target, input.action, input.reason, input.duration.minutes,
        { state: "pending", caseNumber: pendingCase.caseNumber }
    );
    const pendingMessage = await sendModerationDm(input.target, pendingEmbed);
    try {
        await action();
    } catch (err) {
        const failedEmbed = buildModerationDmEmbed(
            interaction, input.target, input.action, input.reason, input.duration.minutes,
            { state: "failed", caseNumber: pendingCase.caseNumber }
        );
        await finishPendingModerationDm(
            pendingMessage,
            failedEmbed,
            () => queueFinalModerationDm(interaction, input, pendingCase.caseNumber, "failed")
        );
        err.moderationDmSent = Boolean(pendingMessage);
        throw err;
    }
    const finalEmbed = buildModerationDmEmbed(
        interaction, input.target, input.action, input.reason, input.duration.minutes,
        { state: "succeeded", caseNumber: pendingCase.caseNumber }
    );
    const result = await finishPendingModerationDm(
        pendingMessage,
        finalEmbed,
        () => queueFinalModerationDm(interaction, input, pendingCase.caseNumber, "succeeded")
    );
    return result?.status === "sent";
}

async function applyBan(interaction, input, pendingCase) {
    assertBotPermission(interaction, PermissionFlagsBits.BanMembers);
    return applyRemovalAction(
        interaction,
        input,
        pendingCase,
        () => input.target.ban({ reason: input.reason })
    );
}

async function applyKick(interaction, input, pendingCase) {
    assertBotPermission(interaction, PermissionFlagsBits.KickMembers);
    return applyRemovalAction(interaction, input, pendingCase, () => input.target.kick(input.reason));
}

async function applyTimeout(interaction, input, pendingCase) {
    assertBotPermission(interaction, PermissionFlagsBits.ModerateMembers);
    await input.target.timeout(input.duration.durationMs, input.reason);
    const result = await queueFinalModerationDm(
        interaction,
        input,
        pendingCase.caseNumber,
        "succeeded",
        Date.now() + input.duration.durationMs
    );
    return result?.status === "sent";
}

const ACTION_HANDLERS = Object.freeze({
    ban: applyBan,
    kick: applyKick,
    timeout: applyTimeout
});

async function applyModerationAction(interaction, input, pendingCase) {
    if (input.action === "ban") return applyBan(interaction, input, pendingCase);
    if (input.action === "kick") return applyKick(interaction, input, pendingCase);
    if (input.action === "timeout") return applyTimeout(interaction, input, pendingCase);
    return false;
}

async function createModerationCase(interaction, input, dmSent, status = "pending") {
    return modCaseManager.createCase(
        sessionManager,
        { ...buildCaseInput(interaction, input.target, input.action, input.reason, input.duration.durationMs), status }
    );
}

async function performModeration(interaction, input, deps = {}) {
    const createCase = deps.createCase || createModerationCase;
    const applyAction = deps.applyAction || applyModerationAction;
    const updateStatus = deps.updateStatus || ((guildId, caseNumber, status, metadata) =>
        modCaseManager.updateCaseStatus(sessionManager, guildId, caseNumber, status, metadata));
    const pendingCase = await createCase(interaction, input, false, "pending");
    let dmSent = false;
    try {
        dmSent = await applyAction(interaction, input, pendingCase);
    } catch (err) {
        const failedMetadata = {
            actionApplied: false,
            failureCode: String(err?.code || "action_failed").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)
        };
        if (typeof err?.moderationDmSent === "boolean") failedMetadata.dmSent = err.moderationDmSent;
        const failedCase = await updateStatus(pendingCase.guildId, pendingCase.caseNumber, "failed", {
            ...failedMetadata
        }).catch(() => null);
        if (!failedCase) {
            sendWebhookEvent({
                severity: "ERROR",
                category: "DATA",
                code: "moderation.case.failure_state_missing",
                state: "OPEN",
                title: "บันทึกสถานะ ModCase ที่ไม่สำเร็จไม่ได้",
                description: "การลงโทษไม่สำเร็จ และระบบไม่สามารถเปลี่ยน ModCase เป็นสถานะไม่สำเร็จได้",
                impact: "สถานะในฐานข้อมูลอาจยังแสดงว่ารอดำเนินการ",
                action: "ตรวจ ModCase และแก้สถานะให้ตรงกับผลจาก Discord",
                context: {
                    "Guild ID": pendingCase.guildId,
                    "หมายเลขเคส": pendingCase.caseNumber,
                    "รหัสข้อผิดพลาด": failedMetadata.failureCode
                },
                sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
                thumbnailUrl: getDiscordAvatarUrl(input.target?.user),
                dedupeKey: `moderation-case-failed:${pendingCase.guildId}:${pendingCase.caseNumber}`,
                dedupeMs: 15 * 60 * 1000
            }).catch(() => {});
        }
        throw err;
    }
    const completedCase = await updateStatus(
        pendingCase.guildId,
        pendingCase.caseNumber,
        "completed",
        { actionApplied: true, dmSent }
    ).catch(() => null);
    const caseDoc = completedCase || { ...pendingCase, metadata: { ...pendingCase.metadata, actionApplied: true, dmSent } };
    if (!completedCase) {
        sendWebhookEvent({
            severity: "ERROR",
            category: "DATA",
            code: "moderation.case.completion_state_missing",
            state: "OPEN",
            title: "ดำเนินการลงโทษแล้ว แต่ ModCase ยังไม่ปิด",
            description: "Discord ดำเนินการสำเร็จ แต่ระบบไม่สามารถเปลี่ยน ModCase เป็นสถานะเสร็จสิ้นได้",
            impact: "ประวัติ Moderation แสดงสถานะไม่ตรงกับการดำเนินการจริง",
            action: "ตรวจ ModCase และเปลี่ยนสถานะเป็นเสร็จสิ้น",
            context: {
                "Guild ID": pendingCase.guildId,
                "หมายเลขเคส": pendingCase.caseNumber,
                "ส่ง DM สำเร็จ": dmSent
            },
            sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
            thumbnailUrl: getDiscordAvatarUrl(input.target?.user),
            dedupeKey: `moderation-case-completed:${pendingCase.guildId}:${pendingCase.caseNumber}`,
            dedupeMs: 15 * 60 * 1000
        }).catch(() => {});
    }
    return { dmSent, caseDoc, caseCompleted: Boolean(completedCase) };
}

function successReply(interaction, input, result) {
    const replyEmbed = buildModerationReplyEmbed(
        interaction,
        input.target,
        input.action,
        input.reason,
        result.dmSent,
        result.caseDoc.caseNumber
    );
    return interaction.editReply({
        content: result.caseCompleted
            ? undefined
            : `> ${config.emojis.warning} ดำเนินการกับสมาชิกแล้ว แต่ฐานข้อมูลยังคง Case #${result.caseDoc.caseNumber} เป็น pending เพื่อให้ตรวจสอบภายหลัง`,
        embeds: [replyEmbed]
    });
}

function failureReply(interaction, err) {
    sessionManager.systemMetrics.increment("errors");
    return interaction.editReply({ content: moderationErrorReply(err) });
}

function readFullModerationInput(interaction) {
    const baseInput = readModerationInput(interaction);
    return { ...baseInput, duration: parseTimeoutDuration(interaction, baseInput.action) };
}

async function handleModerationCommand(interaction, client) {
    const input = readFullModerationInput(interaction);
    const rejection = await validateModerationRequest(interaction, client, input);
    if (rejection === VALIDATION_STOP) return null;
    if (rejection) return rejection;

    markCommandAccepted(interaction);
    if (!await safeDefer(interaction)) return null;
    try {
        return successReply(interaction, input, await performModeration(interaction, input));
    } catch (err) {
        return failureReply(interaction, err);
    }
}

module.exports = {
    VALIDATION_STOP,
    requireModerationPermission,
    rejectMissingTarget,
    rejectHierarchy,
    rejectUnmanageableTarget,
    rejectInvalidDuration,
    validateModerationRequest,
    sendModerationDm,
    queueFinalModerationDm,
    finishPendingModerationDm,
    assertBotPermission,
    applyBan,
    applyKick,
    applyTimeout,
    ACTION_HANDLERS,
    applyModerationAction,
    createModerationCase,
    performModeration,
    successReply,
    failureReply,
    readFullModerationInput,
    handleModerationCommand
};
