const { PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const { requireMemberPermission, checkRoleHierarchy, safeDefer, markCommandAccepted } = require("../guards/commandGuards");
const modCaseManager = require("../logging/modCaseManager");
const { sendWebhookEvent, getDiscordAvatarUrl, getDiscordGuildIconUrl } = require("../core/webhooks");
const {
    requiredModerationPermission,
    readModerationInput,
    parseTimeoutDuration,
    buildCaseInput,
    buildModerationReplyEmbed,
    moderationErrorReply
} = require("./moderationHelpers");

const VALIDATION_STOP = Symbol("VALIDATION_STOP");

async function requireModerationPermission(interaction, _action) {
    return requireMemberPermission(
        interaction,
        PermissionFlagsBits.Administrator,
        `> ${config.emojis?.no_entry || "⛔"} คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`
    );
}

function rejectMissingTarget(interaction, target) {
    if (target) return null;
    return interaction.reply({ content: `> ${config.emojis?.error || "❌"} ไม่พบสมาชิกเป้าหมายในเซิร์ฟเวอร์`, ephemeral: true });
}

function rejectHierarchy(interaction, client, target) {
    const hierarchy = checkRoleHierarchy({ interaction, target, client, config });
    if (hierarchy.ok) return null;
    return interaction.reply({ content: hierarchy.content, ephemeral: true });
}

function rejectUnmanageableTarget(interaction, target, action) {
    // Discord exposes a separate capability for bans. A member can be
    // bannable even when it is not manageable for role/nickname changes, so
    // do not use `manageable` as the ban decision.
    if (action === "ban") {
        if (target.bannable === true) return null;
        return interaction.reply({ content: `> ${config.emojis?.error || "❌"} บอทไม่สามารถแบนสมาชิกท่านนี้ได้`, ephemeral: true });
    }

    if (target.manageable) return null;
    return interaction.reply({ content: `> ${config.emojis?.error || "❌"} บอทไม่มีสิทธิ์จัดการสมาชิกท่านนี้`, ephemeral: true });
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

function assertBotPermission(interaction, permission) {
    if (!interaction.guild.members.me.permissions.has(permission)) throw new Error("MISSING_PERMS");
}

async function applyRemovalAction(action) {
    await action();
}

async function applyBan(interaction, input, pendingCase) {
    assertBotPermission(interaction, PermissionFlagsBits.BanMembers);
    const options = { reason: input.reason };
    if (typeof input.deleteMessageSeconds === "number" && input.deleteMessageSeconds > 0) {
        options.deleteMessageSeconds = input.deleteMessageSeconds;
    }
    return applyRemovalAction(() => input.target.ban(options));
}

async function applyKick(interaction, input, pendingCase) {
    assertBotPermission(interaction, PermissionFlagsBits.KickMembers);
    return applyRemovalAction(() => input.target.kick(input.reason));
}

async function applyTimeout(interaction, input, pendingCase) {
    assertBotPermission(interaction, PermissionFlagsBits.ModerateMembers);
    if (input.duration?.isUntimeout || input.duration?.durationMs === null || input.duration?.durationMs === 0) {
        await input.target.timeout(null, input.reason);
    } else {
        await input.target.timeout(input.duration.durationMs, input.reason);
    }
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

async function createModerationCase(interaction, input, status = "pending") {
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
    const pendingCase = await createCase(interaction, input, "pending");
    try {
        await applyAction(interaction, input, pendingCase);
    } catch (err) {
        const failedMetadata = {
            actionApplied: false,
            failureCode: String(err?.code || "action_failed").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)
        };
        const failedCase = await updateStatus(pendingCase.guildId, pendingCase.caseNumber, "failed", {
            ...failedMetadata
        }).catch(() => null);
        if (!failedCase) {
            sendWebhookEvent({
                severity: "ERROR",
                category: "DATABASE",
                code: "moderation.case.failure_state_missing",
                state: "OPEN",
                title: "MODCASE FAILURE STATE MISSING",
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
        { actionApplied: true }
    ).catch(() => null);
    const caseDoc = completedCase || { ...pendingCase, metadata: { ...pendingCase.metadata, actionApplied: true } };
    if (!completedCase) {
        sendWebhookEvent({
            severity: "ERROR",
            category: "DATABASE",
            code: "moderation.case.completion_state_missing",
            state: "OPEN",
            title: "MODCASE COMPLETION STATE MISSING",
            description: "Discord ดำเนินการสำเร็จ แต่ระบบไม่สามารถเปลี่ยน ModCase เป็นสถานะเสร็จสิ้นได้",
            impact: "ประวัติ Moderation แสดงสถานะไม่ตรงกับการดำเนินการจริง",
            action: "ตรวจ ModCase และเปลี่ยนสถานะเป็นเสร็จสิ้น",
            context: {
                "Guild ID": pendingCase.guildId,
                "หมายเลขเคส": pendingCase.caseNumber
            },
            sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
            thumbnailUrl: getDiscordAvatarUrl(input.target?.user),
            dedupeKey: `moderation-case-completed:${pendingCase.guildId}:${pendingCase.caseNumber}`,
            dedupeMs: 15 * 60 * 1000
        }).catch(() => {});
    }
    return { caseDoc, caseCompleted: Boolean(completedCase) };
}

function successReply(interaction, input, result) {
    const replyEmbed = buildModerationReplyEmbed(
        interaction,
        input.target,
        input.action,
        input.reason,
        result.caseDoc.caseNumber,
        {
            duration: input.duration,
            isUntimeout: input.duration?.isUntimeout,
            deleteMessageSeconds: input.deleteMessageSeconds
        }
    );
    return interaction.editReply({
        content: result.caseCompleted
            ? null
            : `> ${config.emojis?.warning || "⚠️"} ดำเนินการกับสมาชิกเรียบร้อย แต่บันทึกประวัติไม่สมบูรณ์`,
        embeds: [replyEmbed]
    });
}

function failureReply(interaction, err) {
    sessionManager.systemMetrics.increment("errors");
    sendWebhookEvent({
        target: "ALERT",
        severity: "ERROR",
        category: "MODERATION",
        code: "moderation.execution_failed",
        state: "OPEN",
        title: "ACTION FAILED",
        description: `เกิดข้อผิดพลาดขณะดำเนินการ moderation: ${err.message || err}`,
        fields: [
            { name: "สถานะ", value: "OPEN" },
            { name: "ผลกระทบ", value: "ไม่สามารถลงโทษสมาชิกเป้าหมายได้ตามที่ผู้ใช้ร้องขอ" },
            { name: "สิ่งที่ควรทำ", value: "ตรวจสอบสิทธิ์ของบอทและตำแหน่ง Role ของบอท" },
            { name: "เซิร์ฟเวอร์", value: `${interaction.guild?.name || "N/A"} (\`${interaction.guild?.id || "N/A"}\`)` },
            { name: "รหัสข้อผิดพลาด", value: String(err.code || err.name || "unknown") }
        ],
        sourceIconUrl: getDiscordGuildIconUrl(interaction.guild)
    }).catch(() => {});
    return interaction.editReply({ content: moderationErrorReply(err) });
}

function resolveModerationLoadingText(input) {
    if (input.action === "ban") return `${config.emojis?.loading || "⏳"} กำลังแบนสมาชิก...`;
    if (input.action === "kick") return `${config.emojis?.loading || "⏳"} กำลังเตะสมาชิก...`;
    if (input.action === "timeout") {
        return input.duration?.isUntimeout || input.duration?.minutes === 0
            ? `${config.emojis?.loading || "⏳"} กำลังปลด Timeout...`
            : `${config.emojis?.loading || "⏳"} กำลังตั้ง Timeout...`;
    }
    return `${config.emojis?.loading || "⏳"} กำลังดำเนินการ...`;
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
    const loadingText = resolveModerationLoadingText(input);
    if (loadingText) {
        await interaction.editReply({ content: loadingText }).catch(() => {});
    }
    try {
        const result = await performModeration(interaction, input);
        sendWebhookEvent({
            target: "LOG",
            severity: "SUCCESS",
            category: "MODERATION",
            code: `moderation.${input.action}`,
            title: `MEMBER ${input.action.toUpperCase()}`,
            description: `ดำเนินการคำสั่ง ${input.action} สำเร็จ`,
            fields: [
                { name: "ผู้ดำเนินการ", value: `${interaction.user.tag} (\`${interaction.user.id}\`)` },
                { name: "เซิร์ฟเวอร์", value: `${interaction.guild.name} (\`${interaction.guild.id}\`)` },
                { name: "เป้าหมาย", value: `${input.target?.user?.tag || input.target?.id || "N/A"} (\`${input.target?.id || "N/A"}\`)` },
                { name: "การกระทำ", value: input.action },
                { name: "ผลลัพธ์", value: `สำเร็จ (Case #${result.caseDoc?.caseNumber || "N/A"})` },
                input.reason ? { name: "รายละเอียด", value: input.reason } : null
            ].filter(Boolean),
            sourceIconUrl: getDiscordGuildIconUrl(interaction.guild),
            thumbnailUrl: getDiscordAvatarUrl(input.target?.user)
        }).catch(() => {});
        return successReply(interaction, input, result);
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
