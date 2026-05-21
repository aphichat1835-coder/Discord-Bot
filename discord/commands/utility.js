/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups Sets — race condition guards.
DO NOT REMOVE: finally blocks — they MUST unlock Sets after every operation.
DO NOT SIMPLIFY: Restore loop — delay + setImmediate required (เฟส 19+21).
DO NOT REMOVE: /whitelist command — required for เฟส 3 /say system.
================================================================================
*/

const { MessageEmbed, MessageActionRow, MessageButton, WebhookClient } = require("discord.js");
const crypto = require("crypto");
const config = require("../config.json");
const sessionManager = require("../sessionManager");

// Race Condition Guards
const activeRestores = new Set();
const activeBackups  = new Set();

// เฟส 3: /say usage tracking (2 ครั้งขึ้นไป → เช็ค whitelist)
const sayUsageTracking = new Map();

async function handle(interaction, client, sessionManager, getLogChannel) {
    const cmd = interaction.commandName;
    if (cmd === "say")        return handleSay(interaction, sessionManager);
    if (cmd === "announce")   return handleAnnounce(interaction);
    if (cmd === "steal")      return handleSteal(interaction);
    if (cmd === "backup")     return handleBackup(interaction);
    if (cmd === "restore")    return handleRestore(interaction);
    if (cmd === "setup-log")  return handleSetupLog(interaction, sessionManager);
    if (cmd === "whitelist")  return handleWhitelist(interaction, sessionManager);
}

// ════════════════════════════════════════════════════════════════════════════
//  📢  SAY (เฟส 3 — Dynamic Rate-Limit + Whitelist)
// ════════════════════════════════════════════════════════════════════════════
async function handleSay(interaction, sessionManager) {
    const msg = interaction.options.getString("message");
    const userId = interaction.user.id;
    const now = Date.now();

    const history = (sayUsageTracking.get(userId) || []).filter(t => now - t < 60000);
    history.push(now);
    sayUsageTracking.set(userId, history);

    if (history.length === 1) {
        if (!interaction.member.permissions.has("MANAGE_MESSAGES")) {
            return interaction.reply({
                content: `> ${config.emojis.no_entry} ต้องมีสิทธิ์ Manage Messages เพื่อใช้คำสั่งนี้`,
                ephemeral: true
            });
        }
        await interaction.channel.send(msg);
        return interaction.reply({ content: `> ${config.emojis.success} ส่งเรียบร้อย`, ephemeral: true });
    }

    const isAdmin = interaction.member.permissions.has("MANAGE_MESSAGES") ||
                    interaction.member.permissions.has("ADMINISTRATOR");

    if (!isAdmin) {
        const whitelisted = await sessionManager.isWhitelisted(userId);
        if (!whitelisted) {
            if (process.env.WEBHOOK_LOG_URL) {
                try {
                    const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                    wh.send({
                        content: `${config.emojis.alert} **[COMMAND ABUSE]** /say spam attempt\n` +
                                 `**User:** <@${userId}> (\`${interaction.user.tag}\`)\n` +
                                 `**Server:** ${interaction.guild.name} (\`${interaction.guild.id}\`)\n` +
                                 `**Count:** ${history.length} ครั้งใน 60s\n` +
                                 `**Message:** ${msg.substring(0, 200)}`
                    }).catch(() => {});
                    wh.destroy();
                } catch (e) {}
            }
            return interaction.reply({
                content: `> ${config.emojis.no_entry} คุณไม่มีสิทธิ์ใช้คำสั่งนี้บ่อยขนาดนี้ กรุณาติดต่อแอดมิน`,
                ephemeral: true
            });
        }
    }

    await interaction.channel.send(msg);
    return interaction.reply({ content: `> ${config.emojis.success} ส่งเรียบร้อย`, ephemeral: true });
}

// ════════════════════════════════════════════════════════════════════════════
//  📣  ANNOUNCE (เฟส 4 — content field นอก Embed)
// ════════════════════════════════════════════════════════════════════════════
async function handleAnnounce(interaction) {
    if (!interaction.member.permissions.has("MANAGE_MESSAGES")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ใช้งาน`, ephemeral: true });
    }

    const title   = interaction.options.getString("title");
    const msgStr  = interaction.options.getString("message");
    const content = interaction.options.getString("content") || null;

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setTitle(`${config.emojis.announce_icon} ${title}`)
        .setDescription(msgStr)
        .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() })
        .setTimestamp();

    await interaction.channel.send({ content: content || undefined, embeds: [embed] });
    return interaction.reply({ content: `> ${config.emojis.success} ประกาศสำเร็จ`, ephemeral: true });
}

// ════════════════════════════════════════════════════════════════════════════
//  😀  STEAL (เฟส 11 — Pre-check โควตา + delay กัน API ceiling)
// ════════════════════════════════════════════════════════════════════════════
async function handleSteal(interaction) {
    if (!interaction.member.permissions.has("MANAGE_EMOJIS_AND_STICKERS")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์จัดการอิโมจิ`, ephemeral: true });
    }
    if (!interaction.guild.members.me.permissions.has("MANAGE_EMOJIS_AND_STICKERS")) {
        return interaction.reply({ content: `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการอิโมจิ`, ephemeral: true });
    }

    const text = interaction.options.getString("emojis");
    const regex = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;
    const matches = [...text.matchAll(regex)];

    if (matches.length === 0) {
        return interaction.reply({ content: `> ${config.emojis.warning} ไม่พบอิโมจิ Custom ในข้อความที่ระบุ`, ephemeral: true });
    }
    if (matches.length > 50) {
        return interaction.reply({
            content: `> ${config.emojis.error} ไม่สามารถดึงเกิน 50 ตัวในครั้งเดียว`,
            ephemeral: true
        });
    }

    const emojiManager = interaction.guild.emojis;
    const currentCount  = emojiManager.cache.size;
    const maxEmojis     = interaction.guild.premiumTier === 2 ? 150 :
                          interaction.guild.premiumTier === 3 ? 250 : 100;

    if (currentCount >= maxEmojis) {
        return interaction.reply({
            content: `> ${config.emojis.error} **เซิร์ฟเวอร์อิโมจิเต็มแล้ว!** (${currentCount}/${maxEmojis}) ลบอิโมจิเก่าออกก่อน`,
            ephemeral: true
        });
    }

    const available = maxEmojis - currentCount;
    const toSteal   = Math.min(matches.length, available);

    await interaction.deferReply();
    let added  = 0;
    let failed = 0;

    for (let i = 0; i < toSteal; i++) {
        const match = matches[i];
        const isAnimated = match[1] === "a";
        const name = match[2];
        const id   = match[3];
        const url  = `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? 'gif' : 'png'}`;

        try {
            await interaction.guild.emojis.create(url, name);
            added++;
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            failed++;
        }

        if (added % 10 === 0 && added > 0) {
            await interaction.editReply({
                embeds: [new MessageEmbed()
                    .setColor(config.system.themeColors.warning)
                    .setDescription(`> ${config.emojis.loading} **กำลังดึงอิโมจิ...** ${added}/${toSteal}`)]
            }).catch(() => {});
        }
    }

    const skipped = matches.length - toSteal;
    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.success)
        .setDescription(
            `> ${config.emojis.success} **นำเข้าอิโมจิสำเร็จ:** ${added} ตัว` +
            (failed  > 0 ? `\n> ${config.emojis.error} **ล้มเหลว:** ${failed} ตัว` : '') +
            (skipped > 0 ? `\n> ${config.emojis.warning} **ข้ามเพราะโควตาเต็ม:** ${skipped} ตัว` : '')
        );
    return interaction.editReply({ embeds: [embed] });
}

// ════════════════════════════════════════════════════════════════════════════
//  💾  BACKUP
// ════════════════════════════════════════════════════════════════════════════
async function handleBackup(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId &&
        interaction.user.id !== config.system.ownerId) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} คำสั่งนี้สงวนไว้สำหรับ **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`,
            ephemeral: true
        });
    }

    if (activeBackups.has(interaction.guild.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} ระบบกำลังสำรองข้อมูลอยู่ โปรดรอ`,
            ephemeral: true
        });
    }
    activeBackups.add(interaction.guild.id);
    await interaction.deferReply();

    try {
        const existing = await sessionManager.SnapshotModel.findOne({ guildId: interaction.guild.id });
        if (existing && interaction.user.id !== config.system.ownerId) {
            const hoursPassed = (Date.now() - existing.createdAt) / 3600000;
            if (hoursPassed < 24) {
                return interaction.editReply({
                    content: `> ${config.emojis.warning} บันทึกไปแล้วเมื่อ <t:${Math.floor(existing.createdAt / 1000)}:R> โปรดรอให้ครบ 24 ชั่วโมง`
                });
            }
            await sessionManager.SnapshotModel.deleteOne({ guildId: interaction.guild.id });
        }

        const data = {
            roles: interaction.guild.roles.cache.map(r => ({
                id: r.id, name: r.name, color: r.color,
                permissions: r.permissions.bitfield.toString()
            })),
            channels: interaction.guild.channels.cache.map(c => ({
                name: c.name, type: c.type, parentId: c.parentId,
                permissionOverwrites: c.permissionOverwrites.cache.map(o => ({
                    id: o.id, type: o.type,
                    allow: o.allow.bitfield.toString(),
                    deny: o.deny.bitfield.toString()
                }))
            }))
        };

        await sessionManager.SnapshotModel.create({
            snapshotId: crypto.randomUUID(),
            guildId: interaction.guild.id,
            Backup_Owner_ID: interaction.user.id,
            data,
            createdAt: Date.now()
        });

        if (process.env.WEBHOOK_LOG_URL) {
            try {
                const wh = new WebhookClient({ url: process.env.WEBHOOK_LOG_URL });
                wh.send({
                    content: `${config.emojis.backup_icon} **[BACKUP]** Guild: ${interaction.guild.name}\nBy: ${interaction.user.tag}\nRoles: ${data.roles.length} | Channels: ${data.channels.length}`
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }

        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.success)
            .setDescription(
                `> ${config.emojis.backup_icon} **บันทึกโครงสร้างสำเร็จ!**\n` +
                `— **ผู้บันทึก:** <@${interaction.user.id}>\n` +
                `— **ยศ:** ${data.roles.length} ยศ\n` +
                `— **ห้อง:** ${data.channels.length} ห้อง`
            );
        return interaction.editReply({ embeds: [embed] });
    } finally {
        activeBackups.delete(interaction.guild.id);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  RESTORE
// ════════════════════════════════════════════════════════════════════════════
async function handleRestore(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId &&
        interaction.user.id !== config.system.ownerId) {
        return interaction.reply({
            content: `> ${config.emojis.no_entry} คุณต้องเป็น **เจ้าของเซิร์ฟเวอร์** เท่านั้น!`,
            ephemeral: true
        });
    }
    if (!interaction.guild.members.me.permissions.has("ADMINISTRATOR")) {
        return interaction.reply({
            content: `> ${config.emojis.error} บอทต้องมีสิทธิ์ **Administrator** เพื่อกู้คืน!`,
            ephemeral: true
        });
    }

    const targetId = interaction.options.getString("server_id");
    await interaction.deferReply();

    const backup = await sessionManager.SnapshotModel.findOne({ guildId: targetId });
    if (!backup) {
        return interaction.editReply({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup ของไอดีนี้` });
    }
    if (backup.Backup_Owner_ID !== interaction.user.id && interaction.user.id !== config.system.ownerId) {
        return interaction.editReply({
            content: `> ${config.emojis.lock} **ปฏิเสธ!** กุญแจผู้บันทึกไม่ตรงกัน`
        });
    }

    const embed = new MessageEmbed()
        .setColor(config.system.themeColors.error)
        .setTitle(`${config.emojis.warning} ยืนยันการกู้คืนเซิร์ฟเวอร์`)
        .setDescription(
            `${config.emojis.folder} **ข้อมูล Backup:**\n` +
            `— บันทึกโดย: <@${backup.Backup_Owner_ID}>\n` +
            `— เวลา: <t:${Math.floor(backup.createdAt / 1000)}:F>\n` +
            `— ข้อมูล: ${backup.data.roles.length} ยศ, ${backup.data.channels.length} ห้อง\n\n` +
            `*กระบวนการนี้จะสร้างสิ่งที่หายไปกลับมา*`
        );

    const row = new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(`btn_restore_confirm_${backup.snapshotId}`)
            .setLabel("ยืนยันกู้คืน").setStyle("SUCCESS"),
        new MessageButton()
            .setCustomId("btn_restore_cancel")
            .setLabel("ยกเลิก").setStyle("DANGER")
    );
    return interaction.editReply({ embeds: [embed], components: [row] });
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅  RESTORE CONFIRM (Button Handler — ถูกเรียกจาก commands.js Router)
// ════════════════════════════════════════════════════════════════════════════
async function handleRestoreConfirm(interaction, sessionManager) {
    if (activeRestores.has(interaction.guild.id)) {
        return interaction.reply({
            content: `> ${config.emojis.warning} กำลังกู้คืนอยู่ โปรดรอ`,
            ephemeral: true
        });
    }
    activeRestores.add(interaction.guild.id);

    await interaction.update({
        components: [],
        embeds: [new MessageEmbed()
            .setColor(config.system.themeColors.warning)
            .setDescription(`> ${config.emojis.signal} **กำลังกู้คืน กรุณารอสักครู่...**`)]
    });

    const snapshotId = interaction.customId.replace("btn_restore_confirm_", "");

    (async () => {
        try {
            const backup = await sessionManager.SnapshotModel.findOne({ snapshotId });
            if (!backup?.data) {
                return interaction.followUp({ content: `> ${config.emojis.error} ไม่พบข้อมูล Backup`, ephemeral: true }).catch(() => {});
            }

            const guild = interaction.guild;
            const { roles, channels } = backup.data;
            const oldGuildId = backup.guildId;
            const roleIdMap  = new Map();
            let restoredRoles    = 0;
            let restoredChannels = 0;
            const startTime      = Date.now();
            const MAX_DUR        = 14 * 60 * 1000;
            let timeoutHit       = false;

            if (Array.isArray(roles)) {
                for (const rData of roles) {
                    await new Promise(resolve => setImmediate(resolve));

                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }
                    if (rData.name === config.roles.adminName || rData.name === config.roles.userName) continue;

                    let existingRole = guild.roles.cache.find(r => r.name === rData.name);
                    if (rData.name === "@everyone") existingRole = guild.roles.everyone;

                    if (!existingRole) {
                        try {
                            existingRole = await guild.roles.create({
                                name: rData.name,
                                color: rData.color,
                                permissions: BigInt(rData.permissions),
                                reason: "Enterprise Restore"
                            });
                            restoredRoles++;
                            await new Promise(r => setTimeout(r, 600));
                        } catch (e) {
                            console.error("[RESTORE] Role error:", e.message);
                        }
                    }
                    if (existingRole && rData.id) roleIdMap.set(rData.id, existingRole.id);
                }
            }

            if (Array.isArray(channels)) {
                for (const cData of channels) {
                    await new Promise(resolve => setImmediate(resolve));

                    if (Date.now() - startTime > MAX_DUR) { timeoutHit = true; break; }
                    const exists = guild.channels.cache.find(c => c.name === cData.name && c.type === cData.type);
                    if (!exists) {
                        try {
                            const validTypes = ["GUILD_TEXT","GUILD_VOICE","GUILD_CATEGORY","GUILD_NEWS","GUILD_STAGE_VOICE"];
                            if (validTypes.includes(cData.type)) {
                                let mappedOverwrites = [];
                                if (Array.isArray(cData.permissionOverwrites)) {
                                    for (const ow of cData.permissionOverwrites) {
                                        let targetId = roleIdMap.get(ow.id);
                                        if (ow.id === oldGuildId) targetId = guild.id;
                                        if (targetId) {
                                            mappedOverwrites.push({
                                                id: targetId,
                                                allow: BigInt(ow.allow),
                                                deny:  BigInt(ow.deny)
                                            });
                                        }
                                    }
                                }
                                await guild.channels.create(cData.name, {
                                    type: cData.type,
                                    permissionOverwrites: mappedOverwrites,
                                    reason: "Enterprise Restore"
                                });
                                restoredChannels++;
                                await new Promise(r => setTimeout(r, 600));
                            }
                        } catch (e) {
                            console.error("[RESTORE] Channel error:", e.message);
                        }
                    }
                }
            }

            const timeMsg = timeoutHit ? `\n> ${config.emojis.warning} หยุดอัตโนมัติ: เกิน 14 นาที` : "";
            await interaction.followUp({
                content: `> ${config.emojis.success} **กู้คืนสำเร็จ!**\n— ยศ: ${restoredRoles} ยศ\n— ห้อง: ${restoredChannels} ห้อง${timeMsg}`,
                ephemeral: true
            }).catch(() => {});

        } catch (err) {
            console.error("[RESTORE] Error:", err.message);
            await interaction.followUp({
                content: `> ${config.emojis.error} เกิดข้อผิดพลาด: ${err.message}`,
                ephemeral: true
            }).catch(() => {});
        } finally {
            activeRestores.delete(interaction.guild.id);
        }
    })();
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  SETUP-LOG
// ════════════════════════════════════════════════════════════════════════════
async function handleSetupLog(interaction, sessionManager) {
    if (!interaction.member.permissions.has("ADMINISTRATOR")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ต้องเป็น Administrator`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const categories = ['message', 'member', 'voice', 'server', 'security'];
    const created = [];

    for (const cat of categories) {
        try {
            const existing = await sessionManager.getLogChannelMap(interaction.guild.id);
            const key = `${cat}ChannelId`;
            if (existing && existing[key]) {
                created.push(`${config.emojis.warning} \`${cat}\` — มีอยู่แล้ว`);
                continue;
            }

            const ch = await interaction.guild.channels.create(`log-${cat}`, {
                type: 'GUILD_TEXT',
                topic: `Enterprise Audit Log — ${cat}`,
                reason: 'Enterprise /setup-log'
            });

            await sessionManager.setLogChannelMap(interaction.guild.id, cat, ch.id);
            created.push(`${config.emojis.success} \`${cat}\` → <#${ch.id}>`);
        } catch (e) {
            created.push(`${config.emojis.error} \`${cat}\` — ล้มเหลว: ${e.message}`);
        }
    }

    return interaction.editReply({
        content: `${config.emojis.settings_icon} **ติดตั้ง Audit Log เรียบร้อย:**\n${created.join('\n')}`
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  📋  WHITELIST
// ════════════════════════════════════════════════════════════════════════════
async function handleWhitelist(interaction, sessionManager) {
    if (!interaction.member.permissions.has("ADMINISTRATOR")) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ต้องเป็น Administrator`, ephemeral: true });
    }

    const action = interaction.options.getString("action");
    const target = interaction.options.getUser("user");

    if (!target) {
        return interaction.reply({ content: `> ${config.emojis.no_entry} ระบุ user ด้วย`, ephemeral: true });
    }

    if (action === "add") {
        await sessionManager.addWhitelist(target.id);
        return interaction.reply({
            content: `> ${config.emojis.success} เพิ่ม <@${target.id}> เข้า Whitelist แล้ว`,
            ephemeral: true
        });
    } else if (action === "remove") {
        await sessionManager.removeWhitelist(target.id);
        return interaction.reply({
            content: `> ${config.emojis.success} ลบ <@${target.id}> ออกจาก Whitelist แล้ว`,
            ephemeral: true
        });
    } else {
        return interaction.reply({ content: `> ${config.emojis.warning} action ต้องเป็น add หรือ remove`, ephemeral: true });
    }
}

module.exports = { handle, handleRestoreConfirm };
