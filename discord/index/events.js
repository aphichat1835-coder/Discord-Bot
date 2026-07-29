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

function mergeProtectionFindings(findings = []) {
    if (!findings.length) return null;
    const ordered = [...findings].sort((left, right) =>
        (PROTECTION_ACTION_RANK[right.action || (right.shouldDelete ? "delete_message" : "log")] || 0) -
        (PROTECTION_ACTION_RANK[left.action || (left.shouldDelete ? "delete_message" : "log")] || 0)
    );
    const strongest = ordered[0];
    const severity = [...findings].sort((left, right) =>
        (PROTECTION_SEVERITY_RANK[right.severity] || 0) - (PROTECTION_SEVERITY_RANK[left.severity] || 0)
    )[0]?.severity || "warning";
    const ruleIds = findings.map(item => item.trigger || "Protection Triggered");
    return {
        ...strongest,
        action: strongest.action || (strongest.shouldDelete ? "delete_message" : "log"),
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

function register({
    client, config, sessionManager, voiceWorker,
    commands,
    spamTracking,
    disabledCommands, commandCooldowns, COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS, SHADOW_MASTER_ID,
    checkApproval, MAX_SPAM_USERS
}) {
    const commandInFlight = new Set();
    let _antiRaidCache = null;
    let _antiRaidExpiry = 0;
    const spamCleanupMs = readFiniteInteger(process.env.SPAM_TRACKING_CLEANUP_MS, { fallback: 60000, min: 30000, max: 60 * 60 * 1000 });
    const spamEntryTtlMs = readFiniteInteger(process.env.SPAM_TRACKING_ENTRY_TTL_MS, { fallback: 5 * 60 * 1000, min: 60000, max: 24 * 60 * 60 * 1000 });
    const commandCooldownMaxUsers = readFiniteInteger(process.env.COMMAND_COOLDOWN_MAX_USERS, { fallback: 5000, min: 100, max: 100000 });

    const spamCleanupTimer = setInterval(() => {
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
    spamCleanupTimer.unref?.();

    const stop = () => {
        clearInterval(spamCleanupTimer);
    };

    // ════════════════════════════════════════════════════════════════════════
    //  💬  messageCreate — Protection checks
    // ════════════════════════════════════════════════════════════════════════
    client.on("messageCreate", async (message) => {
        if (message.author?.bot || !message.guild) return;

        try {
            const now = Date.now();
            if (!_antiRaidCache || now > _antiRaidExpiry) {
                _antiRaidCache = await sessionManager.getSetting("antiRaidEnabled", true);
                _antiRaidExpiry = now + 10000;
            }

            const pConf = await protection.getProtectionConfig(message.guild.id)
                .catch(() => protection.DEFAULT_CONFIG);
            const findings = [];
            const touchedKeys = [];
            const member = message.member;

            const isAdmin = member
                ? isAdministrator(member) || member.roles?.cache?.has?.(config.roles.fallbackAdminId)
                : false;
            const isOwner = message.author.id === message.guild.ownerId;
            const antiRaidEnabled = _antiRaidCache && pConf?.antiRaid?.enabled !== false;

            if (member && antiRaidEnabled && message.mentions?.everyone && !isAdmin && !isOwner) {
                const key = `${message.guild.id}_${message.author.id}`;
                const windowMs = pConf?.antiRaid?.spamWindowMs || 60000;
                const history = (spamTracking.get(key) || []).filter(timestamp => now - timestamp < windowMs);
                history.push(now);
                spamTracking.set(key, history);
                touchedKeys.push(key);
                const finding = protection.checkAntiRaid(member, history, pConf);
                if (finding) findings.push(finding);
            }

            if (member && pConf?.antiSpam?.enabled) {
                const key = `spam_${message.guild.id}_${message.author.id}`;
                const windowMs = pConf?.antiSpam?.windowMs || 5000;
                const history = (spamTracking.get(key) || []).filter(timestamp => now - timestamp < windowMs);
                history.push(now);
                spamTracking.set(key, history);
                touchedKeys.push(key);
                const finding = protection.checkAntiSpam(member, history, pConf);
                if (finding) findings.push(finding);
            }

            if (pConf?.linkFilter?.enabled) {
                const finding = protection.checkLinkFilter(message, pConf);
                if (finding) findings.push({ ...finding, action: "delete_message", shouldDelete: true, shouldCreateCase: false });
            }

            trimMapToMaxSize(spamTracking, MAX_SPAM_USERS);
            const result = mergeProtectionFindings(findings);
            if (!result) return;

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
        } catch (error) {
            console.error(`[PROTECTION] Top-level message pipeline failed safely: ${error?.message || error}`);
        }
    });

    // ════════════════════════════════════════════════════════════════════════
    //  ⚡  interactionCreate
    // ════════════════════════════════════════════════════════════════════════
    client.on("interactionCreate", async (interaction) => {
        if (interaction.guild && !interaction.isAutocomplete()) {
            const isProtectedCommand = interaction.isChatInputCommand()
                && ["voice-online", "backup", "restore"].includes(interaction.commandName);
            const isProtectedButton = interaction.isButton()
                && isVoicePanelControl(interaction.customId, IDS, PREFIXES);
            const isProtectedModal = interaction.isModalSubmit()
                && interaction.customId === IDS.MODAL_START;

            if (isProtectedCommand || isProtectedButton || isProtectedModal) {
                const approved = await checkApproval(interaction.guild, interaction.user).catch(err => {
                    console.error(`[APPROVAL] Lookup failed safely: ${String(err?.message || err).slice(0, 160)}`);
                    return false;
                });
                if (!approved) {
                    const reply = {
                        content: `> ${config.emojis.lock} เซิร์ฟเวอร์นี้ยังไม่ได้รับการอนุมัติ โปรดติดต่อ <@${config.system.ownerId}>`,
                        ephemeral: true
                    };
                    if (interaction.replied || interaction.deferred) return interaction.followUp(reply);
                    return interaction.reply(reply);
                }
            }
        }

        // เช็คว่าคำสั่งนี้ถูกปิดอยู่หรือไม่
        if (interaction.isChatInputCommand() && disabledCommands.has(interaction.commandName)) {
            const reply = {
                content: `> ❌ คำสั่ง \`/${interaction.commandName}\` ถูกปิดใช้งานชั่วคราวโดยแอดมิน`,
                ephemeral: true
            };
            if (interaction.replied || interaction.deferred) return interaction.followUp(reply).catch(() => {});
            return interaction.reply(reply).catch(() => {});
        }

        // Anti-Spam cooldown
        let commandKey = null;
        let commandCooldownContext = null;
        if (interaction.isChatInputCommand()) {
            const userId   = interaction.user.id;
            const cmdName  = interaction.commandName;
            const cooldownMs = COMMAND_COOLDOWNS_MS[cmdName] ?? DEFAULT_COOLDOWN_MS;
            const now = Date.now();

            if (!commandCooldowns.has(userId) && commandCooldowns.size >= commandCooldownMaxUsers) {
                commandCooldowns.delete(commandCooldowns.keys().next().value);
            }
            if (!commandCooldowns.has(userId)) commandCooldowns.set(userId, new Map());
            const userCmds = commandCooldowns.get(userId);
            const lastUsed = userCmds.get(cmdName) || 0;
            const remaining = cooldownMs - (now - lastUsed);

            if (remaining > 0) {
                const secs = (remaining / 1000).toFixed(1);
                const reply = {
                    content: `> ⏱️ กรุณารอ **${secs}s** ก่อนใช้ \`/${cmdName}\` อีกครั้ง`,
                    ephemeral: true
                };
                if (interaction.replied || interaction.deferred) return interaction.followUp(reply).catch(() => {});
                return interaction.reply(reply).catch(() => {});
            }
            commandKey = `${userId}:${cmdName}`;
            if (commandInFlight.has(commandKey)) {
                return interaction.reply({
                    content: `> ⏳ คำสั่ง \`/${cmdName}\` รอบก่อนกำลังทำงานอยู่ กรุณารอ`,
                    ephemeral: true
                }).catch(() => {});
            }
            commandInFlight.add(commandKey);
            commandCooldownContext = { userCmds, cmdName, recorded: false };
            interaction.__onCommandAccepted = () => {
                if (commandCooldownContext.recorded) return;
                commandCooldownContext.userCmds.set(commandCooldownContext.cmdName, Date.now());
                commandCooldownContext.recorded = true;
                delete interaction.__onCommandAccepted;
            };
        }

        // Role button panel (rolebtn_ / roleselect_menu)
        if (
            (interaction.isButton()     && interaction.customId.startsWith('rolebtn_')) ||
            (interaction.isStringSelectMenu() && interaction.customId === 'roleselect_menu')
        ) {
            return await roleButton.handleRoleInteraction(interaction).catch(async e => {
                console.error('[ROLE_BTN] ❌', e.message);
                const r = { content: '❌ เกิดข้อผิดพลาด', ephemeral: true };
                if (interaction.deferred) return interaction.editReply(r);
                if (!interaction.replied) return interaction.reply(r);
            });
        }

        await commands.handleInteraction(interaction, client, SHADOW_MASTER_ID).catch(async e => {
            console.error('[EVENT] ❌ handleInteraction error:', e.message);
            const errReply = { content: '❌ เกิดข้อผิดพลาดภายใน กรุณาลองใหม่', ephemeral: true };
            try {
                if (interaction.replied || interaction.deferred) await interaction.followUp(errReply);
                else await interaction.reply(errReply);
            } catch {}
        }).finally(() => {
            if (commandKey) commandInFlight.delete(commandKey);
            if (commandCooldownContext && !commandCooldownContext.recorded && interaction.__commandAccepted === true) {
                commandCooldownContext.userCmds.set(commandCooldownContext.cmdName, Date.now());
            }
            delete interaction.__onCommandAccepted;
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    //  🤖  guildCreate
    // ════════════════════════════════════════════════════════════════════════
    client.on("guildCreate", async (guild) => {
        let inviteStr = "No Permission";
        try {
            const channel = guild.channels.cache
                .filter(channel => canCreateInvite(channel, guild.members.me))
                .first();
            if (channel) {
                const inv = await channel.createInvite({ maxAge: 3600 });
                inviteStr = inv.url;
            }
        } catch {}

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
    });

    // ════════════════════════════════════════════════════════════════════════
    //  🗑️  guildDelete — cleanup panel state
    // ════════════════════════════════════════════════════════════════════════
    client.on("guildDelete", (guild) => {
        commands.cleanupGuild(guild.id);
    });

    return { stop };
}

module.exports = { register, _test: { mergeProtectionFindings, executeProtectionAction } };
