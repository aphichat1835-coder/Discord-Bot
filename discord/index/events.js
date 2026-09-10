/* eslint-disable complexity -- Discord event routing is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: Anti-Raid logic, approval gate, command cooldowns.
DO NOT REMOVE: guildCreate/guildDelete handlers.
================================================================================
*/

const roleButton  = require('../features/roleButton');
const protection  = require('../features/protection');
const protectionCase = require('../features/protectionCase');
const { IDS, PREFIXES } = require("../commands/customIds");
const { isVoicePanelControl } = require("../guards/commandGuards");
const {
    canBanMember,
    canCreateInvite,
    canDeleteMessage,
    isAdministrator
} = require("../core/discordPermissions");
const { sendWebhookEvent, getDiscordAvatarUrl, getDiscordGuildIconUrl } = require("../core/webhooks");
const { readFiniteInteger } = require("../core/numbers");
const { isConfiguredOwner } = require("../core/env");
const voiceAdmin = require("../features/voiceAdmin");

async function deleteMessageWithLog(message, scope = "message-delete") {
    if (!canDeleteMessage(message)) {
        console.warn(`[PROTECTION] Cannot delete message for ${scope}: missing ManageMessages or message is not deletable`);
        return false;
    }

    try {
        await message.delete();
        return true;
    } catch (err) {
        console.warn(`[PROTECTION] Failed to delete message for ${scope}: ${err.message}`);
        return false;
    }
}

async function deleteRaidEvidenceSafely(message, maxMessages = 5) {
    let deletedCount = 0;
    try {
        const fetched = await message.channel.messages.fetch({ limit: Math.max(maxMessages, 1) }).catch(() => null);
        const ownedMessages = fetched
            ? fetched.filter(m =>
                m.author?.id === message.author.id &&
                !m.author?.bot &&
                !m.webhookId
            ).first(maxMessages)
            : [message];

        const targets = ownedMessages.length > 0 ? ownedMessages : [message];

        for (const target of targets) {
            if (await deleteMessageWithLog(target, "anti-raid")) deletedCount++;
        }
    } catch {
        if (await deleteMessageWithLog(message, "anti-raid-fallback")) deletedCount++;
    }
    return deletedCount;
}

function trimMapToMaxSize(map, maxSize) {
    while (map.size > maxSize) {
        const oldestKey = map.keys().next().value;
        if (!oldestKey) break;
        map.delete(oldestKey);
    }
}

async function deleteProtectionEvidence(message, deleteMode) {
    if (!message) return 0;
    if (deleteMode === "raid") return deleteRaidEvidenceSafely(message, 5);
    if (deleteMode === "single") {
        return await deleteMessageWithLog(message, "protection-pipeline") ? 1 : 0;
    }
    return 0;
}

async function applyProtectionMemberAction(member, result, action) {
    if (action === "timeout") {
        if (!member.manageable) throw new Error("member is not manageable");
        await member.timeout((result.minutes || 10) * 60000, result.reason);
        return { attempted: true, success: true };
    }
    if (action === "ban") {
        if (!canBanMember(member)) throw new Error("missing BanMembers or member is not bannable");
        await member.ban({ reason: result.reason });
        return { attempted: true, success: true };
    }
    if (action === "kick") {
        if (!member.kickable) throw new Error("member is not kickable");
        await member.kick(result.reason);
        return { attempted: true, success: true };
    }
    return { attempted: false, success: true };
}

async function executeProtectionAction({ member, result, message, deleteMode = "none" }) {
    const action = result?.action || "log";
    const output = {
        action,
        attempted: action !== "log",
        success: false,
        reason: result?.reason || null,
        error: null,
        timeoutMs: result?.minutes ? result.minutes * 60000 : null,
        deletedMessages: 0
    };

    try {
        output.deletedMessages = await deleteProtectionEvidence(message, deleteMode);
        Object.assign(output, await applyProtectionMemberAction(member, result, action));
    } catch (err) {
        output.error = err.message;
        console.warn(`[PROTECTION] Action ${action} failed for ${member?.id}: ${err.message}`);
    }

    return output;
}

function protectionActionMode(config = {}) {
    return String(config.actionMode || config.mode || process.env.PROTECTION_ACTION_MODE || "audit_only").toLowerCase();
}

function canEnforceProtection(config = {}) {
    return protectionActionMode(config) === "action" || protectionActionMode(config) === "enforce";
}

function buildAuditOnlyProtectionResult(result = {}) {
    return {
        action: result.action || (result.shouldDelete ? "delete_message" : "log"),
        attempted: false,
        success: true,
        reason: result.reason || "audit-only protection mode",
        error: null,
        timeoutMs: result.minutes ? result.minutes * 60000 : null,
        deletedMessages: 0
    };
}

async function recordProtectionResult({ guild, sessionManager, result, member, message, actionResult }) {
    const event = protectionCase.buildProtectionEvent({
        guildId: guild.id,
        userId: member?.id || message?.author?.id,
        channelId: message?.channel?.id || null,
        trigger: result?.trigger || "Protection Triggered",
        reason: result?.reason || "ระบบป้องกันตรวจพบพฤติกรรมเสี่ยง",
        severity: result?.severity || "danger",
        evidence: result?.evidence || [],
        actionResult,
        metadata: result?.metadata || {},
        sourceIconUrl: getDiscordGuildIconUrl(guild),
        thumbnailUrl: getDiscordAvatarUrl(member?.user || message?.author)
    });

    try {
        return await protectionCase.recordProtectionResult({
            sessionManager,
            event,
            createCase: result?.shouldCreateCase !== false
        });
    } catch {
        console.error(`[PROTECTION] ModCase persistence failed safely for guild=${guild.id}`);
        if (actionResult?.attempted === true && actionResult?.success === true) {
            sendWebhookEvent({
                severity: "ERROR",
                category: "DATA",
                code: "protection.case.persistence_failed",
                state: "OPEN",
                title: "ผลการป้องกันกับ ModCase ไม่ตรงกัน",
                description: "Discord ดำเนินการลงโทษสำเร็จ แต่ระบบบันทึก ModCase ไม่สำเร็จ",
                impact: "ประวัติการดูแลสมาชิกอาจไม่มีรายการของการดำเนินการครั้งนี้",
                action: "ตรวจ Runtime Log และสร้างหรือแก้ ModCase ให้ตรงกับการดำเนินการจริง",
                context: { "Guild ID": guild.id },
                sourceIconUrl: getDiscordGuildIconUrl(guild),
                thumbnailUrl: getDiscordAvatarUrl(member?.user || message?.author),
                dedupeKey: `protection-case-persistence:${guild.id}`,
                dedupeMs: 5 * 60 * 1000
            }).catch(() => {});
        }
        return null;
    }
}

const PROTECTION_ACTION_RANK = Object.freeze({ log: 0, delete_message: 1, timeout: 2, kick: 3, ban: 4 });
const PROTECTION_SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, danger: 2, critical: 3 });

function mergeProtectionMetadata(findings) {
    const metadata = {};
    for (const item of findings) {
        if (item.metadata && typeof item.metadata === "object") Object.assign(metadata, item.metadata);
    }
    return metadata;
}

function resolveProtectionDeleteMode(findings) {
    if (findings.some(item => item.trigger?.includes("Anti-Raid"))) return "raid";
    if (findings.some(item => item.shouldDelete)) return "single";
    return "none";
}

function resolveFindingAction(item) {
    return item?.action || (item?.shouldDelete ? "delete_message" : "log");
}

function resolveStrongestFinding(findings) {
    const ordered = [...findings].sort((left, right) =>
        (PROTECTION_ACTION_RANK[resolveFindingAction(right)] || 0) -
        (PROTECTION_ACTION_RANK[resolveFindingAction(left)] || 0)
    );
    return ordered[0];
}

function resolveHighestSeverity(findings) {
    const ordered = [...findings].sort((left, right) =>
        (PROTECTION_SEVERITY_RANK[right.severity] || 0) - (PROTECTION_SEVERITY_RANK[left.severity] || 0)
    );
    return ordered[0]?.severity || "warning";
}

function mergeProtectionFindings(findings = []) {
    if (!findings.length) return null;
    const strongest = resolveStrongestFinding(findings);
    const severity = resolveHighestSeverity(findings);
    const ruleIds = findings.map(item => item.trigger || "Protection Triggered");
    return {
        ...strongest,
        action: resolveFindingAction(strongest),
        severity,
        trigger: ruleIds.join(" + "),
        reason: findings.map(item => item.reason).filter(Boolean).join(" | ").slice(0, 480),
        evidence: [...new Set(findings.flatMap(item => item.evidence || []))].slice(0, 20),
        shouldCreateCase: findings.some(item => item.shouldCreateCase !== false),
        metadata: {
            ...mergeProtectionMetadata(findings),
            ruleIds
        },
        deleteMode: resolveProtectionDeleteMode(findings)
    };
}


async function applyProtectionEnforcementAndNotice({ message, member, pConf, result, findings, sessionManager, touchedKeys, spamTracking }) {
    const actionResult = canEnforceProtection(pConf)
        ? await executeProtectionAction({
            member,
            result,
            message,
            deleteMode: result.deleteMode
        })
        : buildAuditOnlyProtectionResult(result);

    await recordProtectionResult({
        guild: message.guild,
        sessionManager,
        result,
        member,
        message,
        actionResult
    });

    for (const key of touchedKeys) spamTracking.delete(key);

    if (
        canEnforceProtection(pConf) &&
        findings.some(finding => finding.shouldDelete) &&
        actionResult.deletedMessages > 0
    ) {
        const notice = await message.channel.send({
            content: `> 🔗 <@${message.author.id}> ข้อความถูกบล็อกโดยระบบ`,
            allowedMentions: { parse: [] }
        }).catch(() => null);
        if (notice) {
            const timer = setTimeout(() => notice.delete().catch(() => {}), 5000);
            timer.unref?.();
        }
    }
}

function recordSpamTimestamp(spamTracking, key, now, windowMs) {
    const history = (spamTracking.get(key) || []).filter(timestamp => now - timestamp < windowMs);
    history.push(now);
    spamTracking.set(key, history);
    return history;
}

function checkMessageAntiRaid({ message, member, pConf, spamTracking, now, antiRaidEnabled, isAdmin, isOwner }) {
    if (!member || !antiRaidEnabled || !message.mentions?.everyone || isAdmin || isOwner) {
        return null;
    }
    const key = `${message.guild.id}_${message.author.id}`;
    const windowMs = pConf?.antiRaid?.spamWindowMs || 60000;
    const history = recordSpamTimestamp(spamTracking, key, now, windowMs);
    const finding = protection.checkAntiRaid(member, history, pConf);
    return { key, finding };
}

function checkMessageAntiSpam({ message, member, pConf, spamTracking, now }) {
    if (!member || !pConf?.antiSpam?.enabled) {
        return null;
    }
    const key = `spam_${message.guild.id}_${message.author.id}`;
    const windowMs = pConf?.antiSpam?.windowMs || 5000;
    const history = recordSpamTimestamp(spamTracking, key, now, windowMs);
    const finding = protection.checkAntiSpam(member, history, pConf);
    return { key, finding };
}

function checkMessageLinkFilter(message, pConf) {
    if (!pConf?.linkFilter?.enabled) return null;
    const finding = protection.checkLinkFilter(message, pConf);
    return finding ? { ...finding, action: "delete_message", shouldDelete: true, shouldCreateCase: false } : null;
}

function collectMessageProtectionFindings({
    message,
    member,
    pConf,
    spamTracking,
    now,
    antiRaidEnabled,
    config
}) {
    const findings = [];
    const touchedKeys = [];
    const isAdmin = member
        ? isAdministrator(member) || member.roles?.cache?.has?.(config.roles.fallbackAdminId)
        : false;
    const isOwner = message.author.id === message.guild.ownerId;

    const raidResult = checkMessageAntiRaid({ message, member, pConf, spamTracking, now, antiRaidEnabled, isAdmin, isOwner });
    if (raidResult) {
        touchedKeys.push(raidResult.key);
        if (raidResult.finding) findings.push(raidResult.finding);
    }

    const spamResult = checkMessageAntiSpam({ message, member, pConf, spamTracking, now });
    if (spamResult) {
        touchedKeys.push(spamResult.key);
        if (spamResult.finding) findings.push(spamResult.finding);
    }

    const linkFinding = checkMessageLinkFilter(message, pConf);
    if (linkFinding) findings.push(linkFinding);

    return { findings, touchedKeys };
}

async function runMessageProtectionPipeline({
    message,
    sessionManager,
    spamTracking,
    config,
    antiRaidState,
    MAX_SPAM_USERS
}) {
    const now = Date.now();
    if (!antiRaidState.cache || now > antiRaidState.expiry) {
        antiRaidState.cache = await sessionManager.getSetting("antiRaidEnabled", true);
        antiRaidState.expiry = now + 10000;
    }

    const pConf = await protection.getProtectionConfig(message.guild.id)
        .catch(() => protection.DEFAULT_CONFIG);
    const member = message.member;
    const { findings, touchedKeys } = collectMessageProtectionFindings({
        message,
        member,
        pConf,
        spamTracking,
        now,
        antiRaidEnabled: antiRaidState.cache && pConf?.antiRaid?.enabled !== false,
        config
    });

    trimMapToMaxSize(spamTracking, MAX_SPAM_USERS);
    const result = mergeProtectionFindings(findings);
    if (!result) return;

    await applyProtectionEnforcementAndNotice({
        message,
        member,
        pConf,
        result,
        findings,
        sessionManager,
        touchedKeys,
        spamTracking
    });
}

async function checkProtectedCommandAccess(interaction, config, shadowMasterId) {
    if (!interaction.guild || interaction.isAutocomplete() || !interaction.isChatInputCommand()) {
        return { allowed: true };
    }
    const protectedCommands = ["voice-online", "backup", "restore", "setup-verify"];
    if (!protectedCommands.includes(interaction.commandName)) {
        return { allowed: true };
    }
    const isOwner = isConfiguredOwner(config, interaction.user.id)
        || interaction.user.id === shadowMasterId
        || interaction.user.id === config.system?.ownerId;
    if (isOwner) return { allowed: true };

    const reply = {
        content: `> 🔒 คำสั่งนี้สงวนสิทธิ์เฉพาะ **เจ้าของบอท (Bot Owner)** เท่านั้น`,
        ephemeral: true
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
    return { allowed: false };
}

async function checkDisabledCommand(interaction, disabledCommands) {
    if (!interaction.isChatInputCommand() || !disabledCommands.has(interaction.commandName)) {
        return { allowed: true };
    }
    const reply = {
        content: `> ❌ คำสั่ง \`/${interaction.commandName}\` ถูกปิดใช้งานชั่วคราวโดยแอดมิน`,
        ephemeral: true
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
    return { allowed: false };
}

function getOrCreateUserCooldownMap(commandCooldowns, userId, maxUsers) {
    if (!commandCooldowns.has(userId) && commandCooldowns.size >= maxUsers) {
        commandCooldowns.delete(commandCooldowns.keys().next().value);
    }
    if (!commandCooldowns.has(userId)) commandCooldowns.set(userId, new Map());
    return commandCooldowns.get(userId);
}

function resolveCooldownKeys(interaction, cmdName, userId) {
    const isChannelScoped = cmdName === "clear";
    const channelId = interaction.channelId || interaction.channel?.id || "";
    const cooldownKey = isChannelScoped && channelId ? `${cmdName}:${channelId}` : cmdName;
    const commandKey = isChannelScoped && channelId ? `${userId}:${cmdName}:${channelId}` : `${userId}:${cmdName}`;
    return { isChannelScoped, cooldownKey, commandKey };
}

async function respondCooldownExceeded(interaction, cmdName, remaining) {
    const secs = (remaining / 1000).toFixed(1);
    const reply = {
        content: `> ⏱️ กรุณารอ **${secs}s** ก่อนใช้ \`/${cmdName}\` อีกครั้ง`,
        ephemeral: true
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
}

async function respondCommandInFlight(interaction, cmdName, isChannelScoped) {
    await interaction.reply({
        content: isChannelScoped
            ? `> ⏳ คำสั่ง \`/${cmdName}\` ในห้องนี้รอบก่อนกำลังทำงานอยู่ กรุณารอ`
            : `> ⏳ คำสั่ง \`/${cmdName}\` รอบก่อนกำลังทำงานอยู่ กรุณารอ`,
        ephemeral: true
    }).catch(() => {});
}

async function handleCommandCooldownAndInFlight({
    interaction,
    commandCooldowns,
    COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS,
    commandCooldownMaxUsers,
    commandInFlight
}) {
    if (!interaction.isChatInputCommand()) return { allowed: true };

    const userId = interaction.user.id;
    const cmdName = interaction.commandName;
    const cooldownMs = COMMAND_COOLDOWNS_MS[cmdName] ?? DEFAULT_COOLDOWN_MS;
    const now = Date.now();

    const userCmds = getOrCreateUserCooldownMap(commandCooldowns, userId, commandCooldownMaxUsers);
    const { isChannelScoped, cooldownKey, commandKey } = resolveCooldownKeys(interaction, cmdName, userId);
    const lastUsed = userCmds.get(cooldownKey) || 0;
    const remaining = cooldownMs - (now - lastUsed);

    if (remaining > 0) {
        await respondCooldownExceeded(interaction, cmdName, remaining);
        return { allowed: false };
    }
    if (commandInFlight.has(commandKey)) {
        await respondCommandInFlight(interaction, cmdName, isChannelScoped);
        return { allowed: false };
    }
    commandInFlight.add(commandKey);
    const commandCooldownContext = { userCmds, cooldownKey, recorded: false };
    interaction.__onCommandAccepted = () => {
        if (commandCooldownContext.recorded) return;
        commandCooldownContext.userCmds.set(commandCooldownContext.cooldownKey, Date.now());
        commandCooldownContext.recorded = true;
        delete interaction.__onCommandAccepted;
    };
    return { allowed: true, commandKey, commandCooldownContext };
}

function setupSpamCleanupTimer(spamTracking, MAX_SPAM_USERS, spamEntryTtlMs, spamCleanupMs) {
    const timer = setInterval(() => {
        const cutoff = Date.now() - spamEntryTtlMs;
        for (const [key, history] of spamTracking.entries()) {
            const next = Array.isArray(history) ? history.filter(ts => Number(ts) >= cutoff) : [];
            if (next.length) spamTracking.set(key, next);
            else spamTracking.delete(key);
        }

        while (spamTracking.size > MAX_SPAM_USERS) {
            spamTracking.delete(spamTracking.keys().next().value);
        }
    }, spamCleanupMs);
    timer.unref?.();
    return timer;
}

function attachVoiceAdminListeners(client) {
    const onVoiceStateUpdate = (oldState, newState) => voiceAdmin.handleVoiceStateUpdate(oldState, newState, client);
    const onAuditLogEntry = (entry, guild) => voiceAdmin.handleAuditLogEntry(entry, guild, client);
    const onGuildMemberUpdate = (oldMember, member) => voiceAdmin.handleMemberUpdate(oldMember, member);
    const onGuildMemberRemove = member => voiceAdmin.handleMemberRemove(member);

    client.on("voiceStateUpdate", onVoiceStateUpdate);
    client.on("guildAuditLogEntryCreate", onAuditLogEntry);
    client.on("guildMemberUpdate", onGuildMemberUpdate);
    client.on("guildMemberRemove", onGuildMemberRemove);

    return () => {
        client.off("voiceStateUpdate", onVoiceStateUpdate);
        client.off("guildAuditLogEntryCreate", onAuditLogEntry);
        client.off("guildMemberUpdate", onGuildMemberUpdate);
        client.off("guildMemberRemove", onGuildMemberRemove);
    };
}

async function handleMessageCreateEvent({ message, commands, sessionManager, spamTracking, config, antiRaidState, MAX_SPAM_USERS }) {
    if (message.author?.bot || !message.guild) return;

    const secretCommandHandled = await commands.handleMessage(message).catch(error => {
        console.error(`[VOICE_ADMIN] Secret command failed safely: ${String(error?.message || error).slice(0, 160)}`);
        return false;
    });
    if (secretCommandHandled) return;

    try {
        await runMessageProtectionPipeline({
            message,
            sessionManager,
            spamTracking,
            config,
            antiRaidState,
            MAX_SPAM_USERS
        });
    } catch (error) {
        console.error(`[PROTECTION] Top-level message pipeline failed safely: ${error?.message || error}`);
    }
}

function isRoleButtonInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith('rolebtn_')) return true;
    if (interaction.isStringSelectMenu() && interaction.customId === 'roleselect_menu') return true;
    return false;
}

async function handleRoleButtonInteractionSafe(interaction) {
    return await roleButton.handleRoleInteraction(interaction).catch(async e => {
        console.error('[ROLE_BTN] ❌', e.message);
        const r = { content: '❌ เกิดข้อผิดพลาด', ephemeral: true };
        if (interaction.deferred) return interaction.editReply(r);
        if (!interaction.replied) return interaction.reply(r);
    });
}

function finalizeCommandInteraction({ commandKey, commandInFlight, commandCooldownContext, interaction }) {
    if (commandKey) commandInFlight.delete(commandKey);
    if (commandCooldownContext && !commandCooldownContext.recorded && interaction.__commandAccepted === true) {
        commandCooldownContext.userCmds.set(commandCooldownContext.cooldownKey, Date.now());
    }
    delete interaction.__onCommandAccepted;
}

async function replyInteractionError(interaction) {
    const errReply = { content: '❌ เกิดข้อผิดพลาดภายใน กรุณาลองใหม่', ephemeral: true };
    try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(errReply);
        else await interaction.reply(errReply);
    } catch {}
}

async function dispatchCommandInteraction({ interaction, commands, client, SHADOW_MASTER_ID, commandKey, commandCooldownContext, commandInFlight }) {
    await commands.handleInteraction(interaction, client, SHADOW_MASTER_ID).catch(async e => {
        console.error('[EVENT] ❌ handleInteraction error:', e.message);
        await replyInteractionError(interaction);
    }).finally(() => {
        finalizeCommandInteraction({ commandKey, commandInFlight, commandCooldownContext, interaction });
    });
}

async function handleInteractionCreateEvent({
    interaction,
    config,
    SHADOW_MASTER_ID,
    disabledCommands,
    commandCooldowns,
    COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS,
    commandCooldownMaxUsers,
    commandInFlight,
    commands,
    client
}) {
    const auth = await checkProtectedCommandAccess(interaction, config, SHADOW_MASTER_ID);
    if (!auth.allowed) return;

    const disabled = await checkDisabledCommand(interaction, disabledCommands);
    if (!disabled.allowed) return;

    const cooldownRes = await handleCommandCooldownAndInFlight({
        interaction,
        commandCooldowns,
        COMMAND_COOLDOWNS_MS,
        DEFAULT_COOLDOWN_MS,
        commandCooldownMaxUsers,
        commandInFlight
    });
    if (!cooldownRes.allowed) return;

    if (isRoleButtonInteraction(interaction)) {
        return await handleRoleButtonInteractionSafe(interaction);
    }

    await dispatchCommandInteraction({
        interaction,
        commands,
        client,
        SHADOW_MASTER_ID,
        commandKey: cooldownRes.commandKey,
        commandCooldownContext: cooldownRes.commandCooldownContext,
        commandInFlight
    });
}

async function resolveGuildInviteString(guild) {
    try {
        const channel = guild.channels.cache
            .filter(ch => canCreateInvite(ch, guild.members.me))
            .first();
        if (channel) {
            const inv = await channel.createInvite({ maxAge: 3600 });
            return inv.url;
        }
    } catch {}
    return "No Permission";
}

async function handleGuildCreateEvent(guild) {
    voiceAdmin.handleGuildCreate(guild.id);
    const inviteStr = await resolveGuildInviteString(guild);

    sendWebhookEvent({
        target: "LOG",
        severity: "INFO",
        category: "GUILD",
        code: "guild.joined",
        title: "บอทเข้าร่วมเซิร์ฟเวอร์ใหม่",
        context: {
            "เซิร์ฟเวอร์": guild.name,
            "Guild ID": guild.id,
            "จำนวนสมาชิก": guild.memberCount,
            "ลิงก์เชิญชั่วคราว": inviteStr
        },
        sourceIconUrl: getDiscordGuildIconUrl(guild)
    }).catch(() => {});
}

function register({
    client, config, sessionManager, voiceWorker,
    commands,
    spamTracking,
    disabledCommands, commandCooldowns, COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS, SHADOW_MASTER_ID,
    checkApproval, MAX_SPAM_USERS
}) {
    const commandInFlight = new Set();
    const spamCleanupMs = readFiniteInteger(process.env.SPAM_TRACKING_CLEANUP_MS, { fallback: 60000, min: 30000, max: 60 * 60 * 1000 });
    const spamEntryTtlMs = readFiniteInteger(process.env.SPAM_TRACKING_ENTRY_TTL_MS, { fallback: 5 * 60 * 1000, min: 60000, max: 24 * 60 * 60 * 1000 });
    const commandCooldownMaxUsers = readFiniteInteger(process.env.COMMAND_COOLDOWN_MAX_USERS, { fallback: 5000, min: 100, max: 100000 });

    const spamCleanupTimer = setupSpamCleanupTimer(spamTracking, MAX_SPAM_USERS, spamEntryTtlMs, spamCleanupMs);
    const detachVoiceAdmin = attachVoiceAdminListeners(client);

    const stop = async () => {
        clearInterval(spamCleanupTimer);
        detachVoiceAdmin();
        await voiceAdmin.stop();
    };

    const antiRaidState = { cache: null, expiry: 0 };
    client.on("messageCreate", message => handleMessageCreateEvent({
        message, commands, sessionManager, spamTracking, config, antiRaidState, MAX_SPAM_USERS
    }));

    client.on("interactionCreate", interaction => handleInteractionCreateEvent({
        interaction, config, SHADOW_MASTER_ID, disabledCommands, commandCooldowns,
        COMMAND_COOLDOWNS_MS, DEFAULT_COOLDOWN_MS, commandCooldownMaxUsers,
        commandInFlight, commands, client
    }));

    client.on("guildCreate", handleGuildCreateEvent);
    client.on("guildDelete", guild => commands.cleanupGuild(guild.id));

    return { stop };
}

module.exports = {
    register,
    _test: {
        mergeProtectionFindings,
        executeProtectionAction,
        collectMessageProtectionFindings,
        checkProtectedCommandAccess,
        checkDisabledCommand
    }
};
