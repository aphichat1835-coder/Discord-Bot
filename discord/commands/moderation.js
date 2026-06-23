/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups, activeVoiceKicks Sets.
DO NOT REMOVE: finally blocks — they unlock race condition guards.
DO NOT SIMPLIFY: Permission check chain — each check serves a specific purpose.
================================================================================
*/

const { MessageEmbed } = require("discord.js");
const config = require("../config.json");
const sessionManager = require("../sessionManager");
const {
    requireMemberPermission,
    requireBotPermission,
    checkRoleHierarchy,
    safeDefer
} = require("../guards/commandGuards");
const modCaseManager = require("../logging/modCaseManager");
const { LOG_CHANNEL_TYPES, routeAndSendLog } = require("../logging/logCore");
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

// Race Condition Guards
const activeVoiceKicks = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handle(interaction, client, sessionManager, getLogChannel) {
    const cmd = interaction.commandName;

    if (cmd === "voicekickall") return handleVoiceKickAll(interaction, getLogChannel);
    if (cmd === "clear")        return handleClear(interaction);
    if (["ban", "kick", "timeout"].includes(cmd)) return handleModeration(interaction, client);
}

// ════════════════════════════════════════════════════════════════════════════
//  🔇  VOICE KICK ALL
// ════════════════════════════════════════════════════════════════════════════
async function handleVoiceKickAll(interaction, getLogChannel) {
    const vc = interaction.member.voice.channel;
    if (!vc) return interaction.reply({ content: `> ${config.emojis.no_entry} คุณต้องอยู่ในห้องเสียงก่อน!`, ephemeral: true });
    if (!await requireMemberPermission(interaction, "ADMINISTRATOR", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`)) return;
    if (!await requireBotPermission(interaction, "MOVE_MEMBERS", `> ${config.emojis.error} บอทไม่มีสิทธิ์ย้ายสมาชิก`)) return;

    if (activeVoiceKicks.has(interaction.guild.id)) {
        return interaction.reply({ content: `> ${config.emojis.warning} ระบบกำลังดำเนินการอยู่ กรุณารอ`, ephemeral: true });
    }
    activeVoiceKicks.add(interaction.guild.id);
    await safeDefer(interaction);

    try {
        const startTime = Date.now();
        const MAX_DURATION = 14 * 60 * 1000;
        const kicked = [];
        let isTimeoutHit = false;

        const memberSnapshot = Array.from(vc.members.values());
        for (const member of memberSnapshot) {
            await new Promise(resolve => setImmediate(resolve));

            if (Date.now() - startTime > MAX_DURATION) { isTimeoutHit = true; break; }
            if (!member.permissions.has("ADMINISTRATOR")) {
                try {
                    await member.voice.disconnect();
                    kicked.push(`<@${member.id}>`);
                    await new Promise(r => setTimeout(r, 500));
                } catch {}
            }
        }

        const limitMsg = isTimeoutHit ? `\n> ${config.emojis.warning} **หยุดอัตโนมัติ:** เกิน 14 นาที` : "";
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setDescription(
                `> ${config.emojis.success} **จัดการห้องเสียงเรียบร้อย** ${config.emojis.broom}\n\n` +
                `— **เตะสำเร็จ ${kicked.length} คน:**\n` +
                `${kicked.length > 0
                    ? (kicked.length > 50
                        ? kicked.slice(0, 50).join(", ") + `\n... และอีก ${kicked.length - 50} คน`
                        : kicked.join(", "))
                    : "- ไม่มีใครถูกเตะ -"}${limitMsg}`
            );

        const logMap = await sessionManager.getLogChannelMap(interaction.guild.id);
        const logCh = logMap?.voiceChannelId ? interaction.guild.channels.cache.get(logMap.voiceChannelId) : null;
        if (logCh) logCh.send({ embeds: [embed] }).catch(() => {});
        return interaction.editReply({ embeds: [embed] });
    } finally {
        activeVoiceKicks.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🧹  CLEAR
// ════════════════════════════════════════════════════════════════════════════
async function handleClear(interaction) {
    if (!await requireMemberPermission(interaction, "MANAGE_MESSAGES", `> ${config.emojis.no_entry} ไม่มีสิทธิ์ลบข้อความ`)) return;
    if (!await requireBotPermission(interaction, "MANAGE_MESSAGES", `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้`)) return;

    const amt = interaction.options.getInteger("amount");
    if (amt < 1 || amt > 100) {
        return interaction.reply({ content: `> ${config.emojis.warning} กรุณาระบุจำนวน 1-100 เท่านั้น`, ephemeral: true });
    }

    try {
        const deletedMsgs = await interaction.channel.bulkDelete(amt, true);
        if (deletedMsgs.size === 0) {
            return interaction.reply({
                content: `> ${config.emojis.warning} ลบไม่สำเร็จ: ไม่พบข้อความใหม่ (ข้อความเก่ากว่า 14 วันลบแบบรวดเดียวไม่ได้)`,
                ephemeral: true
            });
        }
        sessionManager.getLogChannelMap(interaction.guild.id).then(logMap => {
            const logCh = logMap?.messageChannelId ? interaction.guild.channels.cache.get(logMap.messageChannelId) : null;
            if (logCh) logCh.send({ embeds: [new MessageEmbed()
                .setColor(config.system.themeColors.warning)
                .setDescription(`> ${config.emojis.broom} **/clear ถูกใช้**\n— **โดย:** <@${interaction.user.id}>\n— **ห้อง:** <#${interaction.channel.id}>\n— **ลบ:** ${deletedMsgs.size} ข้อความ`)
                .setTimestamp()
            ] }).catch(() => {});
        }).catch(() => {});
        return interaction.reply({
            content: `> ${config.emojis.success} ลบข้อความสำเร็จ **${deletedMsgs.size}** ข้อความ`,
            ephemeral: true
        });
    } catch (e) {
        if (e.code === 50034) {
            return interaction.reply({ content: `> ${config.emojis.warning} ข้อความบางส่วนเก่าเกิน 14 วัน ลบแบบรวดเดียวไม่ได้`, ephemeral: true });
        }
        if (e.code === 50013) {
            return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์ลบข้อความในช่องนี้`, ephemeral: true });
        }
        if (e.code === 10008) {
            return interaction.reply({ content: `> ${config.emojis.warning} ข้อความบางรายการถูกลบไปแล้ว`, ephemeral: true });
        }
        return interaction.reply({ content: `> ${config.emojis.error} ล้มเหลว: ${e.message}`, ephemeral: true });
    }
}

async function requireModerationPermission(interaction, action) {
    const requiredPermission = requiredModerationPermission(action);
    return requireMemberPermission(
        interaction,
        [requiredPermission, "ADMINISTRATOR"],
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

async function applyBan(interaction, target, reason, dmEmbed) {
    assertBotPermission(interaction, "BAN_MEMBERS");
    const dmSent = await sendModerationDm(target, dmEmbed);
    await target.ban({ reason });
    return dmSent;
}

async function applyKick(interaction, target, reason, dmEmbed) {
    assertBotPermission(interaction, "KICK_MEMBERS");
    const dmSent = await sendModerationDm(target, dmEmbed);
    await target.kick(reason);
    return dmSent;
}

async function applyTimeout(interaction, target, reason, duration, dmEmbed) {
    assertBotPermission(interaction, "MODERATE_MEMBERS");
    await target.timeout(duration.durationMs, reason);
    return sendModerationDm(target, dmEmbed);
}

async function applyModerationAction(interaction, input) {
    const dmEmbed = buildModerationDmEmbed(
        interaction,
        input.target,
        input.action,
        input.reason,
        input.duration.minutes
    );

    if (input.action === "ban") return applyBan(interaction, input.target, input.reason, dmEmbed);
    if (input.action === "kick") return applyKick(interaction, input.target, input.reason, dmEmbed);
    if (input.action === "timeout") return applyTimeout(interaction, input.target, input.reason, input.duration, dmEmbed);
    return false;
}

async function createModerationCase(interaction, input, dmSent) {
    return modCaseManager.createCase(
        sessionManager,
        buildCaseInput(interaction, input.target, input.action, input.reason, input.duration.durationMs, dmSent)
    );
}

async function sendModerationCaseLog(interaction, caseDoc, action) {
    const caseEmbed = modCaseManager.buildModerationCaseEmbed(caseDoc, {
        title: `${config.emojis.mod_icon} Case #${caseDoc.caseNumber} | ${action.toUpperCase()} สำเร็จ`
    });

    await routeAndSendLog({
        guild: interaction.guild,
        sessionManager,
        category: LOG_CHANNEL_TYPES.MODERATION,
        embed: caseEmbed
    });
}

async function performModeration(interaction, input) {
    const dmSent = await applyModerationAction(interaction, input);
    const caseDoc = await createModerationCase(interaction, input, dmSent);
    await sendModerationCaseLog(interaction, caseDoc, input.action);
    return { dmSent, caseDoc };
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
    return interaction.editReply({ embeds: [replyEmbed] });
}

function failureReply(interaction, err) {
    sessionManager.systemMetrics.increment("errors");
    return interaction.editReply({ content: moderationErrorReply(err) });
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚖️  BAN / KICK / TIMEOUT + CASE LOGGING
// ════════════════════════════════════════════════════════════════════════════
async function handleModeration(interaction, client) {
    const baseInput = readModerationInput(interaction);
    const input = { ...baseInput, duration: parseTimeoutDuration(interaction, baseInput.action) };
    const rejection = await validateModerationRequest(interaction, client, input);
    if (rejection === VALIDATION_STOP) return;
    if (rejection) return rejection;

    await safeDefer(interaction);
    try {
        return successReply(interaction, input, await performModeration(interaction, input));
    } catch (err) {
        return failureReply(interaction, err);
    }
}

function getRuntimeDiagnostics() {
    return {
        activeVoiceKicks: activeVoiceKicks.size
    };
}

module.exports = { handle, getRuntimeDiagnostics };
