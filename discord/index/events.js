/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: Anti-Raid logic, approval gate, command cooldowns.
DO NOT REMOVE: guildCreate/guildDelete handlers.
================================================================================
*/

const { MessageEmbed, WebhookClient } = require("discord.js");

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
                if (spamTracking.size >= MAX_SPAM_USERS) {
                    const firstKey = spamTracking.keys().next().value;
                    spamTracking.delete(firstKey);
                }

                const spamKey     = `${message.guild.id}_${message.author.id}`;
                const userHistory = spamTracking.get(spamKey) || [];
                const recent      = userHistory.filter(t => now - t < 60000);
                recent.push(now);
                spamTracking.set(spamKey, recent);

                if (recent.length >= 5) {
                    try {
                        await message.channel.bulkDelete(5).catch(() => {});
                        if (message.member.manageable) {
                            await message.member.timeout(10 * 60000, "Anti-Raid: Spam @everyone");
                        }

                        const warnEmbed = new MessageEmbed()
                            .setColor(config.system.themeColors.error)
                            .setDescription(
                                `> <@${message.author.id}> ${config.emojis.antiraid} ` +
                                `ระบบตรวจพบการสแปมแท็ก! คุณถูกระงับการใช้งานชั่วคราว ` +
                                `${config.emojis.antiraid}`
                            );

                        const warnMsg = await message.channel.send({ embeds: [warnEmbed] });
                        setTimeout(() => warnMsg.delete().catch(() => {}), 300000);

                        const debounceKey = `${message.guild.id}_${message.author.id}`;
                        const lastLog = antiRaidLogDebounce.get(debounceKey) || 0;
                        if (Date.now() - lastLog > 5000) {
                            antiRaidLogDebounce.set(debounceKey, Date.now());
                            const logEmbed = new MessageEmbed()
                                .setColor(config.system.themeColors.error)
                                .setTitle(`${config.emojis.antiraid} Anti-Raid: Spam Tag Detected`)
                                .setDescription(
                                    `**ผู้กระทำ:** <@${message.author.id}>\n` +
                                    `**ช่อง:** <#${message.channel.id}>\n` +
                                    `**ครั้งที่:** ${recent.length}`
                                )
                                .setTimestamp();
                            auditLogger.sendAuditLog(message.guild, sessionManager, 'security', logEmbed).catch(() => {});
                        }
                    } catch (e) {
                        console.error(`[ANTI-RAID] ⚠️ Failed for ${message.author.id}: ${e.message}`);
                    } finally {
                        spamTracking.delete(`${message.guild.id}_${message.author.id}`);
                    }
                }
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