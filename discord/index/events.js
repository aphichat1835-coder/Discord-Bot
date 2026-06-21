/* eslint-disable complexity -- Discord event routing is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: Anti-Raid logic, approval gate, command cooldowns.
DO NOT REMOVE: guildCreate/guildDelete handlers.
================================================================================
*/

const { MessageEmbed } = require("discord.js");
const roleButton  = require('../features/roleButton');
const protection  = require('../features/protection');
const { IDS, PREFIXES } = require("../commands/customIds");
const { isVoicePanelControl } = require("../guards/commandGuards");
const { sendLogWebhook } = require("../core/webhooks");

function getGuildBotMember(guild) {
    return guild?.members?.me || guild?.me || guild?.members?.cache?.get(guild?.client?.user?.id);
}

function canDeleteMessage(message) {
    const botMember = getGuildBotMember(message.guild);
    const perms = message.channel?.permissionsFor?.(botMember);
    return message.deletable === true && perms?.has?.("MANAGE_MESSAGES");
}

async function deleteMessageWithLog(message, scope = "message-delete") {
    if (!canDeleteMessage(message)) {
        console.warn(`[PROTECTION] Cannot delete message for ${scope}: missing MANAGE_MESSAGES or message is not deletable`);
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

function canBanMember(member) {
    const botMember = getGuildBotMember(member?.guild);
    return !!(
        botMember?.permissions?.has?.("BAN_MEMBERS") &&
        member?.bannable === true
    );
}

async function deleteRaidEvidenceSafely(message, maxMessages = 5) {
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
            await deleteMessageWithLog(target, "anti-raid");
        }
    } catch {
        await deleteMessageWithLog(message, "anti-raid-fallback");
    }
}

function trimMapToMaxSize(map, maxSize) {
    while (map.size > maxSize) {
        const oldestKey = map.keys().next().value;
        if (!oldestKey) break;
        map.delete(oldestKey);
    }
}

function register({
    client, config, sessionManager, voiceWorker,
    commands, auditLogger,
    spamTracking, antiRaidLogDebounce,
    disabledCommands, commandCooldowns, COMMAND_COOLDOWNS_MS,
    DEFAULT_COOLDOWN_MS, SHADOW_MASTER_ID,
    checkApproval, MAX_SPAM_USERS
}) {
    let _antiRaidCache = null;
    let _antiRaidExpiry = 0;
    const spamCleanupMs = Math.max(30000, Number(process.env.SPAM_TRACKING_CLEANUP_MS || 60000) || 60000);
    const spamEntryTtlMs = Math.max(60000, Number(process.env.SPAM_TRACKING_ENTRY_TTL_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
    const commandCooldownMaxUsers = Math.max(100, Number(process.env.COMMAND_COOLDOWN_MAX_USERS || 5000) || 5000);
    const antiRaidDebounceMaxKeys = Math.max(100, Number(process.env.ANTI_RAID_DEBOUNCE_MAX_KEYS || 5000) || 5000);

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

    // ════════════════════════════════════════════════════════════════════════
    //  💬  messageCreate — Anti-Raid
    // ════════════════════════════════════════════════════════════════════════
    client.on("messageCreate", async (message) => {
        if (message.author.bot || !message.guild) return;

        const now = Date.now();
        if (!_antiRaidCache || now > _antiRaidExpiry) {
            _antiRaidCache  = await sessionManager.getSetting('antiRaidEnabled', true);
            _antiRaidExpiry = now + 10000;
        }
        const globalAntiRaidEnabled = _antiRaidCache;
        const pConf = await protection.getProtectionConfig(message.guild.id).catch(() => protection.DEFAULT_CONFIG);
        const antiRaidEnabled = globalAntiRaidEnabled && pConf?.antiRaid?.enabled !== false;

        if (antiRaidEnabled && message.mentions.everyone) {
            const isAdmin = message.member.permissions.has("ADMINISTRATOR")
                || message.member.roles.cache.has(config.roles.fallbackAdminId);
            const isOwner = message.author.id === message.guild.ownerId;

            if (!isAdmin && !isOwner) {
                if (spamTracking.size >= MAX_SPAM_USERS) spamTracking.delete(spamTracking.keys().next().value);

                const spamKey = `${message.guild.id}_${message.author.id}`;
                const raidWindowMs = pConf?.antiRaid?.spamWindowMs || 60000;
                const history = (spamTracking.get(spamKey) || []).filter(t => Date.now() - t < raidWindowMs);
                history.push(Date.now());
                spamTracking.set(spamKey, history);

                const result = protection.checkAntiRaid(message.member, history, pConf);

                if (result) {
                    try {
                        await deleteRaidEvidenceSafely(message, 5);
                        if (result.action === 'timeout' && message.member.manageable) {
                            await message.member.timeout((result.minutes || 10) * 60000, result.reason);
                        } else if (result.action === 'ban' && canBanMember(message.member)) {
                            await message.member.ban({ reason: result.reason });
                        } else if (result.action === 'ban') {
                            console.warn(`[PROTECTION] Cannot ban anti-raid member ${message.author.id}: missing BAN_MEMBERS or member is not bannable`);
                        } else if (result.action === 'kick' && message.member.kickable) {
                            await message.member.kick(result.reason);
                        }

                        const alertEmbed = protection.buildProtectionAlert('raid', {
                            'ผู้กระทำ': `<@${message.author.id}>`,
                            'ห้อง':     `<#${message.channel.id}>`,
                            'ครั้งที่':  `${history.length}`,
                            'การดำเนินการ': result.action.toUpperCase()
                        });

                        const debounceKey = `${message.guild.id}_${message.author.id}`;
                        if (Date.now() - (antiRaidLogDebounce.get(debounceKey) || 0) > 5000) {
                            antiRaidLogDebounce.set(debounceKey, Date.now());
                            trimMapToMaxSize(antiRaidLogDebounce, antiRaidDebounceMaxKeys);
                            auditLogger.sendAuditLog(message.guild, sessionManager, 'security', alertEmbed).catch(() => {});
                        }
                    } catch (e) {
                        console.error(`[PROTECTION] ⚠️ ${e.message}`);
                    } finally {
                        spamTracking.delete(spamKey);
                    }
                }
            }
        }

        // ── Anti-Spam (ข้อความธรรมดา) ──
        if (pConf?.antiSpam?.enabled) {
            const spamKey  = `spam_${message.guild.id}_${message.author.id}`;
            const spamWindowMs = pConf?.antiSpam?.windowMs || 5000;
            const spamHist = (spamTracking.get(spamKey) || []).filter(t => Date.now() - t < spamWindowMs);
            spamHist.push(Date.now());
            spamTracking.set(spamKey, spamHist);
            trimMapToMaxSize(spamTracking, MAX_SPAM_USERS);

            const spamResult = protection.checkAntiSpam(message.member, spamHist, pConf);
            if (spamResult) {
                try {
                    await deleteMessageWithLog(message, "anti-spam");
                    if (spamResult.action === 'timeout' && message.member.manageable) {
                        await message.member.timeout(spamResult.minutes * 60000, spamResult.reason);
                    } else if (spamResult.action === 'kick' && message.member.kickable) {
                        await message.member.kick(spamResult.reason);
                    } else if (spamResult.action === 'ban' && canBanMember(message.member)) {
                        await message.member.ban({ reason: spamResult.reason });
                    } else if (spamResult.action === 'ban') {
                        console.warn(`[ANTI-SPAM] Cannot ban member ${message.author.id}: missing BAN_MEMBERS or member is not bannable`);
                    }

                    const alertEmbed = protection.buildProtectionAlert('spam', {
                        'ผู้กระทำ': `<@${message.author.id}>`,
                        'ห้อง': `<#${message.channel.id}>`,
                        'จำนวนข้อความ': `${spamHist.length}`,
                        'การดำเนินการ': spamResult.action.toUpperCase()
                    });
                    auditLogger.sendAuditLog(message.guild, sessionManager, 'security', alertEmbed).catch(() => {});
                    spamTracking.delete(spamKey);
                } catch (e) { console.error(`[ANTI-SPAM] ⚠️ ${e.message}`); }
            }

        }

        // ── Link Filter ──
        if (pConf?.linkFilter?.enabled) {
            const linkResult = protection.checkLinkFilter(message, pConf);
            if (linkResult) {
                const deleted = await deleteMessageWithLog(message, "link-filter");
                const alertEmbed = protection.buildProtectionAlert('link', {
                    'ผู้กระทำ': `<@${message.author.id}>`,
                    'ห้อง': `<#${message.channel.id}>`,
                    'เหตุผล': linkResult.reason,
                    'ลบข้อความ': deleted ? 'สำเร็จ' : 'ไม่สำเร็จ'
                });
                auditLogger.sendAuditLog(message.guild, sessionManager, 'security', alertEmbed).catch(() => {});
                message.channel.send({
                    content: `> 🔗 <@${message.author.id}> ลิงก์ถูกบล็อกโดยระบบ`
                }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
            }
        }

    });

    // ════════════════════════════════════════════════════════════════════════
    //  ⚡  interactionCreate
    // ════════════════════════════════════════════════════════════════════════
    client.on("interactionCreate", async (interaction) => {
        if (interaction.guild && !interaction.isAutocomplete()) {
            const isProtectedCommand = interaction.isCommand()
                && ["panel", "backup", "restore"].includes(interaction.commandName);
            const isProtectedButton = interaction.isButton()
                && isVoicePanelControl(interaction.customId, IDS, PREFIXES);
            const isProtectedModal = interaction.isModalSubmit()
                && interaction.customId === IDS.MODAL_START;

            if (isProtectedCommand || isProtectedButton || isProtectedModal) {
                const approved = await checkApproval(interaction.guild, interaction.user);
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
        if (interaction.isCommand() && disabledCommands.has(interaction.commandName)) {
            const reply = {
                content: `> ❌ คำสั่ง \`/${interaction.commandName}\` ถูกปิดใช้งานชั่วคราวโดยแอดมิน`,
                ephemeral: true
            };
            if (interaction.replied || interaction.deferred) return interaction.followUp(reply).catch(() => {});
            return interaction.reply(reply).catch(() => {});
        }

        // Anti-Spam cooldown
        if (interaction.isCommand()) {
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
            userCmds.set(cmdName, now);
        }

        // Role button panel (rolebtn_ / roleselect_menu)
        if (
            (interaction.isButton()     && interaction.customId.startsWith('rolebtn_')) ||
            (interaction.isSelectMenu() && interaction.customId === 'roleselect_menu')
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
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    //  🤖  guildCreate
    // ════════════════════════════════════════════════════════════════════════
    client.on("guildCreate", async (guild) => {
        let inviteStr = "No Permission";
        try {
            const channel = guild.channels.cache
                .filter(c => c.isText() && c.permissionsFor(guild.members.me).has("CREATE_INSTANT_INVITE"))
                .first();
            if (channel) {
                const inv = await channel.createInvite({ maxAge: 3600 });
                inviteStr = inv.url;
            }
        } catch (e) {}

        sendLogWebhook({
            content: `🤖 **บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่!**\n` +
                     `**ชื่อ:** ${guild.name}\n` +
                     `**คน:** ${guild.memberCount}\n` +
                     `**ลิงก์:** ${inviteStr}`
        }).catch(() => {});
    });

    // ════════════════════════════════════════════════════════════════════════
    //  🗑️  guildDelete — cleanup panel state
    // ════════════════════════════════════════════════════════════════════════
    client.on("guildDelete", (guild) => {
        commands.cleanupGuild(guild.id);
    });
}

module.exports = { register };
