const config = require("../config.json");
const sessionManager = require("../sessionManager");
const { requireMemberPermission, checkRoleHierarchy, safeDefer, markCommandAccepted } = require("../guards/commandGuards");
const modCaseManager = require("../logging/modCaseManager");
const { sendAlertWebhook } = require("../core/webhooks");
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
        [requiredModerationPermission(action), "ADMINISTRATOR"],
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
    return target.user.send({ embeds: [embed] }).then(() => true).catch(() => false);
}

function assertBotPermission(interaction, permission) {
    if (!interaction.guild.members.me.permissions.has(permission)) throw new Error("MISSING_PERMS");
}

async function applyBan(interaction, input, dmEmbed) {
    assertBotPermission(interaction, "BAN_MEMBERS");
    const dmSent = await sendModerationDm(input.target, dmEmbed);
    try {
        await input.target.ban({ reason: input.reason });
    } catch (err) {
        err.moderationDmSent = dmSent;
        throw err;
    }
    return dmSent;
}

async function applyKick(interaction, input, dmEmbed) {
    assertBotPermission(interaction, "KICK_MEMBERS");
    const dmSent = await sendModerationDm(input.target, dmEmbed);
    try {
        await input.target.kick(input.reason);
    } catch (err) {
        err.moderationDmSent = dmSent;
        throw err;
    }
    return dmSent;
}

async function applyTimeout(interaction, input, dmEmbed) {
    assertBotPermission(interaction, "MODERATE_MEMBERS");
    await input.target.timeout(input.duration.durationMs, input.reason);
    return sendModerationDm(input.target, dmEmbed);
}

const ACTION_HANDLERS = Object.freeze({
    ban: applyBan,
    kick: applyKick,
    timeout: applyTimeout
});

async function applyModerationAction(interaction, input) {
    const dmEmbed = buildModerationDmEmbed(
        interaction,
        input.target,
        input.action,
        input.reason,
        input.duration.minutes
    );

    if (input.action === "ban") return applyBan(interaction, input, dmEmbed);
    if (input.action === "kick") return applyKick(interaction, input, dmEmbed);
    if (input.action === "timeout") return applyTimeout(interaction, input, dmEmbed);
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
        dmSent = await applyAction(interaction, input);
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
            sendAlertWebhook({ content: `⚠️ [MODERATION CASE] Failed status requires reconciliation | guild=${pendingCase.guildId} | case=${pendingCase.caseNumber}` }).catch(() => {});
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
        sendAlertWebhook({ content: `⚠️ [MODERATION CASE] Completed action remains pending | guild=${pendingCase.guildId} | case=${pendingCase.caseNumber}` }).catch(() => {});
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
