/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: Anti-Raid logic, approval gate, command cooldowns.
DO NOT REMOVE: guildCreate/guildDelete handlers.
================================================================================
*/

const { MessageEmbed, WebhookClient } = require("discord.js");
const roleButton  = require('../features/roleButton');
const protection  = require('../features/protection');

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
        const antiRaidEnabled = _antiRaidCache;

        if (antiRaidEnabled && message.mentions.everyone) {
            const isAdmin = message.member.permissions.has("ADMINISTRATOR")
                || message.member.roles.cache.has(config.roles.fallbackAdminId);
            const isOwner = message.author.id === message.guild.ownerId;

            if (!isAdmin && !isOwner) {
                if (spamTracking.size >= MAX_SPAM_USERS) spamTracking.delete(spamTracking.keys().next().value);

                const spamKey = `${message.guild.id}_${message.author.id}`;
                const history = (spamTracking.get(spamKey) || []).filter(t => Date.now() - t < 60000);
                history.push(Date.now());
                spamTracking.set(spamKey, history);

                const pConf  = await protection.getProtectionConfig(message.guild.id).catch(() => protection.DEFAULT_CONFIG);
                const result = protection.checkAntiRaid(message.member, history, pConf);

                if (result) {
                    try {
                        await message.channel.bulkDelete(5).catch(() => {});
                        if (result.action === 'timeout' && message.member.manageable) {
                            await message.member.timeout((result.minutes || 10) * 60000, result.reason);
                        } else if (result.action === 'ban' && message.guild.members.me.permissions.has('BAN_MEMBERS')) {
                            await message.member.ban({ reason: result.reason });
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
        if (antiRaidEnabled) {
            const spamKey  = `spam_${message.guild.id}_${message.author.id}`;
            const spamHist = (spamTracking.get(spamKey) || []).filter(t => Date.now() - t < 5000);
            spamHist.push(Date.now());
            spamTracking.set(spamKey, spamHist);

            const pConf      = await protection.getProtectionConfig(message.guild.id).catch(() => protection.DEFAULT_CONFIG);
            const spamResult = protection.checkAntiSpam(message.member, spamHist, pConf);
            if (spamResult) {
                try {
                    await message.delete().catch(() => {});
                    if (spamResult.action === 'timeout' && message.member.manageable) {
                        await message.member.timeout(spamResult.minutes * 60000, spamResult.reason);
                    } else if (spamResult.action === 'kick' && message.member.kickable) {
                        await message.member.kick(spamResult.reason);
                    } else if (spamResult.action === 'ban') {
                        await message.member.ban({ reason: spamResult.reason });
                    }
                    spamTracking.delete(spamKey);
                } catch (e) { console.error(`[ANTI-SPAM] ⚠️ ${e.message}`); }
            }

            // ── Link Filter ──
            const pConfLink  = pConf;
            const linkResult = protection.checkLinkFilter(message, pConfLink);
            if (linkResult) {
                message.delete().catch(() => {});
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
                && (
                    ["btn_start", "btn_status", "btn_stop_all"].includes(interaction.customId)
                    || interaction.customId.startsWith("status_stop_")
                    || interaction.customId.startsWith("status_page_")
                );

            if (isProtectedCommand || isProtectedButton) {
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
        if (process.env.ALERT_WEBHOOK_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
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
                await wh.send({
                    content: `🤖 **บอทถูกเชิญเข้าเซิร์ฟเวอร์ใหม่!**\n` +
                             `**ชื่อ:** ${guild.name}\n` +
                             `**คน:** ${guild.memberCount}\n` +
                             `**ลิงก์:** ${inviteStr}`
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }
    });

    // ════════════════════════════════════════════════════════════════════════
    //  🗑️  guildDelete — cleanup panel state
    // ════════════════════════════════════════════════════════════════════════
    client.on("guildDelete", (guild) => {
        commands.cleanupGuild(guild.id);
    });
}

module.exports = { register };