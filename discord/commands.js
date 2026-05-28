/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
This file is the ROUTER only — do NOT add command logic here.
Command logic lives in: commands/moderation.js, information.js, utility.js, verification.js
DO NOT REMOVE: panelMessages, restorePanels, cleanupGuild exports.
DO NOT REMOVE: handleMessage — used by index.js messageCreate event.
================================================================================
*/

const { MessageEmbed, MessageActionRow, MessageButton, Modal, TextInputComponent } = require("discord.js");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");

const moderation   = require("./commands/moderation");
const information  = require("./commands/information");
const utility      = require("./commands/utility");
const verification = require("./commands/verification"); // ✨ NEW

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: STATE
// ════════════════════════════════════════════════════════════════════════════
const panelMessages = new Map();
const CB = "```";

// ════════════════════════════════════════════════════════════════════════════
//  📋  REGION 2: SLASH COMMANDS REGISTRY
// ════════════════════════════════════════════════════════════════════════════
const slashCommandsData = [
    { name: "panel",      description: "เรียกแผงควบคุมระบบออนช่องเสียง" },
    { name: "help",       description: "แสดงคู่มือการใช้งานระบบ Enterprise" },
    { name: "stats",      description: "ดูสถิติการทำงานของระบบ" },
    { name: "serverinfo", description: "แสดงข้อมูลรายละเอียดของเซิร์ฟเวอร์แบบเจาะลึก" },
    { name: "setup-log",  description: "ติดตั้งระบบ Audit Log (ยศ/หมวดหมู่/ห้อง Log)" },
    { name: "ping",       description: "ตรวจสอบ Latency และสถานะระบบ" },
    {
        name: "userinfo", description: "แสดงข้อมูลโปรไฟล์ของสมาชิก",
        options: [{ type: 6, name: "member", description: "สมาชิกที่ต้องการดูข้อมูล", required: false }]
    },
    {
        name: "clear", description: "ลบข้อความในช่องปัจจุบัน (สูงสุด 100 ข้อความ)",
        options: [{ type: 4, name: "amount", description: "จำนวนข้อความ (1-100)", required: true }]
    },
    {
        name: "say", description: "ส่งข้อความในนามระบบ",
        options: [{ type: 3, name: "message", description: "ข้อความที่ต้องการส่ง", required: true }]
    },
    {
        name: "announce", description: "ส่งข้อความประกาศแบบ Embed",
        options: [
            { type: 3, name: "title",   description: "หัวข้อประกาศ",  required: true },
            { type: 3, name: "message", description: "เนื้อหาประกาศ", required: true },
            { type: 3, name: "content", description: "ข้อความดิบนอก Embed (เช่น @everyone)", required: false }
        ]
    },
    {
        name: "steal", description: "ดึงอิโมจิเข้าเซิร์ฟเวอร์ (สูงสุด 50 ตัว)",
        options: [{ type: 3, name: "emojis", description: "วางอิโมจิที่ต้องการดึง", required: true }]
    },
    { name: "backup",  description: "บันทึกโครงสร้างเซิร์ฟเวอร์ (เฉพาะเจ้าของ)" },
    {
        name: "restore", description: "กู้คืนโครงสร้างเซิร์ฟเวอร์",
        options: [{ type: 3, name: "server_id", description: "ไอดีเซิร์ฟเวอร์ต้นทาง", required: true }]
    },
    { name: "voicekickall", description: "เตะทุกคนในห้องเสียงที่คุณอยู่ (ยกเว้นผู้ดูแล)" },
    {
        name: "ban", description: "แบนสมาชิก พร้อม DM แจ้งเตือน",
        options: [
            { type: 6, name: "target", description: "เป้าหมาย", required: true },
            { type: 3, name: "reason", description: "เหตุผล",   required: false }
        ]
    },
    {
        name: "kick", description: "เตะสมาชิก พร้อม DM แจ้งเตือน",
        options: [
            { type: 6, name: "target", description: "เป้าหมาย", required: true },
            { type: 3, name: "reason", description: "เหตุผล",   required: false }
        ]
    },
    {
        name: "timeout", description: "ระงับสมาชิกชั่วคราว พร้อม DM แจ้งเตือน",
        options: [
            { type: 6, name: "target",  description: "เป้าหมาย",           required: true },
            { type: 4, name: "minutes", description: "จำนวนนาที (1-40000)", required: true },
            { type: 3, name: "reason",  description: "เหตุผล",              required: false }
        ]
    },
    {
        name: "whitelist", description: "จัดการ Whitelist /say (เฉพาะ Admin)",
        options: [
            { type: 3, name: "action",  description: "add / remove / list", required: true },
            { type: 3, name: "user_id", description: "Discord User ID",     required: false }
        ]
    },
    // ✨ NEW: setup-verify
    {
        name: "setup-verify",
        description: "ติดตั้งแผงยืนยันตัวตน / รับยศในห้องที่เลือก",
        options: [
            { type: 7, name: "channel",     description: "ห้องที่จะส่งแผงยืนยัน",          required: true  },
            { type: 8, name: "role",         description: "ยศที่จะให้เมื่อยืนยันสำเร็จ",     required: true  },
            { type: 5, name: "verify_type",  description: "false=กดรับยศเลย | true=OAuth2", required: false },
            { type: 3, name: "title",        description: "ชื่อ Embed",                      required: false },
            { type: 3, name: "description",  description: "คำอธิบาย Embed",                 required: false },
            { type: 3, name: "color",        description: "สี Hex เช่น #5865F2",            required: false },
            { type: 3, name: "image",        description: "URL รูปภาพหลัก",                 required: false },
            { type: 3, name: "thumbnail",    description: "URL Thumbnail",                  required: false },
            { type: 3, name: "footer",       description: "ข้อความ Footer",                 required: false },
            { type: 5, name: "timestamp",    description: "แสดงเวลา?",                       required: false },
            { type: 3, name: "url",          description: "URL ของ Title",                  required: false },
        ]
    }
];

// ════════════════════════════════════════════════════════════════════════════
//  🔧  REGION 3: SHARED HELPERS
// ════════════════════════════════════════════════════════════════════════════
function sendDM(user, embed) {
    if (!user || user.bot) return;
    user.send({ embeds: [embed] }).catch(() => {});
}

async function getLogChannel(guild, type = 'member') {
    try {
        const map = await sessionManager.getLogChannelMap(guild.id);
        const channelId = map?.[`${type}ChannelId`];
        if (channelId) {
            const ch = guild.channels.cache.get(channelId);
            if (ch) return ch;
        }
    } catch (_) {}
    return guild.channels.cache.find(c => c.name === config.channels.logName && c.isText()) || null;
}

function getPanelMessages() { return panelMessages; }

async function cleanupGuild(guildId) {
    panelMessages.delete(guildId);
    await sessionManager.PanelStateModel.deleteOne({ guildId }).catch(e =>
        console.error(`[PANEL] ❌ cleanupGuild DB delete failed for ${guildId}: ${e.message}`)
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  🖥️  REGION 4: PANEL UPDATE
// ════════════════════════════════════════════════════════════════════════════
async function updatePanel(guildId) {
    if (!guildId) return;
    const panelMsg = panelMessages.get(guildId);
    if (!panelMsg) return;

    try {
        const guild = panelMsg.guild;
        const total = Array.from(sessionManager.getAllSessions().values())
            .filter(s => s.serverId === guild.id).length;

        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.primary)
            .setTitle(`${config.emojis.universe} : Phomueangtai ระบบออนช่องเสียง`)
            .setDescription(
                `ระบบออนช่องเสียงอัตโนมัติ ${config.emojis.dreamworld}\n\n` +
                `ออนไลน์ฟรีครบ 24. ${config.emojis.dreamworld}\n\n` +
                `ตั้งค่าควบคุมผ่านปุ่มแผงควบคุมด้านล่าง ${config.emojis.dreamworld}\n\n` +
                `*Developed by <@${config.system.ownerId}>*`
            )
            .setImage(config.system.bannerUrl || null);

        const row = new MessageActionRow().addComponents(
            new MessageButton().setCustomId("btn_start").setLabel("เริ่มการทำงาน").setEmoji(config.emojis.signal).setStyle("SUCCESS"),
            new MessageButton().setCustomId("btn_status").setLabel("สถานะ & จัดการ").setEmoji(config.emojis.ping).setStyle("PRIMARY"),
            new MessageButton().setCustomId("btn_stop_all").setLabel("หยุดทั้งหมด").setEmoji(config.emojis.stop).setStyle("DANGER")
        );

        await panelMsg.edit({ embeds: [embed], components: [row] });
        await sessionManager.savePanelState(guild.id, panelMsg.channel.id, panelMsg.id);
    } catch (err) {
        console.error("[PANEL] ❌ updatePanel error:", err.message);
    }
}

async function restorePanels(client) {
    try {
        const states = await sessionManager.PanelStateModel.find({});
        for (const state of states) {
            try {
                const guild = client.guilds.cache.get(state.guildId);
                if (!guild) { await sessionManager.PanelStateModel.deleteOne({ guildId: state.guildId }).catch(() => {}); continue; }
                const channel = guild.channels.cache.get(state.channelId);
                if (!channel) { await sessionManager.PanelStateModel.deleteOne({ guildId: state.guildId }).catch(() => {}); continue; }
                const msg = await channel.messages.fetch(state.messageId).catch(() => null);
                if (!msg) { await sessionManager.PanelStateModel.deleteOne({ guildId: state.guildId }).catch(() => {}); console.log(`[PANEL] 🗑️ Stale panel state removed for guild: ${state.guildId}`); continue; }
                panelMessages.set(state.guildId, msg);
                await updatePanel(state.guildId);
                console.log(`[PANEL] ♻️ Restored panel for guild: ${state.guildId}`);
            } catch (e) {
                console.error(`[PANEL] ❌ Failed to restore panel for ${state.guildId}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error("[PANEL] ❌ restorePanels error:", e.message);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💬  REGION 5: MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleMessage(message) {
    if (message.author.bot) return;
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡  REGION 6: INTERACTION ROUTER
// ════════════════════════════════════════════════════════════════════════════
async function handleInteraction(interaction, client, shadowMasterId) {
    try {
        sessionManager.systemMetrics.increment('requests');

        if (interaction.isCommand()) {
            const cmd = interaction.commandName;

            // ── Information Commands ──
            if (["userinfo", "serverinfo", "stats", "help", "ping"].includes(cmd)) {
                return await information.handle(interaction, client, sessionManager);
            }

            // ── Moderation Commands ──
            if (["ban", "kick", "timeout", "clear", "voicekickall"].includes(cmd)) {
                return await moderation.handle(interaction, client, sessionManager, getLogChannel);
            }

            // ── Utility Commands ──
            if (["say", "announce", "steal", "backup", "restore", "setup-log", "whitelist"].includes(cmd)) {
                return await utility.handle(interaction, client, sessionManager, getLogChannel);
            }

            // ── Verification Command ✨ NEW ──
            if (cmd === "setup-verify") {
                return await verification.handle(interaction, client);
            }

            // ── Panel Command ──
            if (cmd === "panel") {
                if (!interaction.member.permissions.has("ADMINISTRATOR")) {
                    return interaction.reply({ content: `> ${config.emojis.no_entry} ไม่มีสิทธิ์ผู้ดูแลระบบ`, ephemeral: true });
                }
                const embed = new MessageEmbed()
                    .setColor(config.system.themeColors.primary)
                    .setTitle(`${config.emojis.universe} : Phomueangtai ระบบออนช่องเสียง`)
                    .setDescription(
                        `ระบบออนช่องเสียงอัตโนมัติ ${config.emojis.dreamworld}\n\n` +
                        `ออนไลน์ฟรีครบ 24. ${config.emojis.dreamworld}\n\n` +
                        `ตั้งค่าควบคุมผ่านปุ่มแผงควบคุมด้านล่าง ${config.emojis.dreamworld}\n\n` +
                        `*Developed by <@${config.system.ownerId}>*`
                    )
                    .setImage(config.system.bannerUrl || null);

                const row = new MessageActionRow().addComponents(
                    new MessageButton().setCustomId("btn_start").setLabel("เริ่มการทำงาน").setEmoji("1505544070012080278").setStyle("SUCCESS"),
                    new MessageButton().setCustomId("btn_status").setLabel("สถานะ & จัดการ").setEmoji("1505544054493020241").setStyle("PRIMARY"),
                    new MessageButton().setCustomId("btn_stop_all").setLabel("หยุดทั้งหมด").setEmoji("1505544059056427079").setStyle("DANGER")
                );

                const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
                panelMessages.set(interaction.guild.id, msg);
                await updatePanel(interaction.guild.id);
                return;
            }
        }

        // ── Button Handlers ──
        if (interaction.isButton()) {
            return await handleButton(interaction, client, shadowMasterId);
        }

        // ── Modal Handlers ──
        if (interaction.isModalSubmit()) {
            return await handleModal(interaction, client);
        }

    } catch (err) {
        console.error(`[SLASH] ❌ Error in /${interaction.commandName || 'interaction'}:`, err.message);
        sessionManager.systemMetrics.increment('errors');
        const reply = { content: `> ${config.emojis.warning} เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง`, ephemeral: true };
        if (interaction.deferred) return interaction.editReply(reply).catch(() => {});
        if (!interaction.replied) return interaction.reply(reply).catch(() => {});
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔘  REGION 7: BUTTON HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleButton(interaction, client, shadowMasterId) {
    const { customId } = interaction;

    // ── Verify Role / OAuth2 Buttons ✨ NEW ──
    if (customId.startsWith("verify_role_") || customId.startsWith("verify_oauth_")) {
        return await verification.handleVerifyButton(interaction);
    }

    // Restore Confirm
    if (customId.startsWith("btn_restore_confirm_")) {
        return await utility.handleRestoreConfirm(interaction, sessionManager);
    }

    // Restore Cancel
    if (customId === "btn_restore_cancel") {
        return interaction.update({
            components: [],
            embeds: [new MessageEmbed().setColor(config.system.themeColors.error).setDescription(`> ${config.emojis.stop} ยกเลิกการกู้คืน`)]
        });
    }

    // Start Button → Modal
    if (customId === "btn_start") {
        const modal = new Modal().setCustomId("modal_start").setTitle("ออนช่องเสียง");
        modal.addComponents(
            new MessageActionRow().addComponents(
                new TextInputComponent().setCustomId("token").setLabel("🔑 Token บัญชี").setStyle("SHORT").setRequired(true)
            ),
            new MessageActionRow().addComponents(
                new TextInputComponent().setCustomId("server_id").setLabel(`${config.emojis.server_icon} ไอดีเซิร์ฟเวอร์`).setStyle("SHORT").setRequired(true)
            ),
            new MessageActionRow().addComponents(
                new TextInputComponent().setCustomId("voice_id").setLabel(`${config.emojis.voice_ch} ไอดีช่องเสียง`).setStyle("SHORT").setRequired(true)
            )
        );
        return interaction.showModal(modal);
    }

    // Stop All
    if (customId === "btn_stop_all") {
        await interaction.deferReply({ ephemeral: true });
        const allSessions = Array.from(sessionManager.getAllSessions().values());
        const userSessions = allSessions.filter(s =>
            s.serverId === interaction.guild.id && s.ownerId === interaction.user.id
        );
        if (userSessions.length === 0) {
            return interaction.editReply({ content: `> ${config.emojis.warning} คุณไม่มีผู้ใช้งานที่กำลังทำงานอยู่` });
        }
        for (const s of userSessions) await voiceWorker.stopSession(s.sessionId);
        await updatePanel(interaction.guild.id);
        return interaction.editReply({ content: `> ${config.emojis.stop} ปิดผู้ใช้งานของคุณทั้งหมด ${userSessions.length} รายการเรียบร้อย` });
    }

    // Status / Pagination
    if (customId === "btn_status" || customId.startsWith("status_page_")) {
        const allSessions = Array.from(sessionManager.getAllSessions().values());
        const userSessions = allSessions.filter(s =>
            s.serverId === interaction.guild.id && s.ownerId === interaction.user.id
        );
        if (userSessions.length === 0) {
            const msg = { content: `> ${config.emojis.warning} คุณไม่มีผู้ใช้งานที่ออนอยู่ในเซิร์ฟเวอร์นี้`, ephemeral: true };
            return interaction.replied || interaction.deferred ? interaction.editReply(msg) : interaction.reply(msg);
        }

        let page = 0;
        if (customId.startsWith("status_page_")) {
            page = parseInt(customId.split("_")[2]) || 0;
        }
        if (page < 0) page = userSessions.length - 1;
        if (page >= userSessions.length) page = 0;

        const current = userSessions[page];
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.primary)
            .setAuthor({ name: current.ownerTag || "Unknown", iconURL: current.ownerAvatar || "https://cdn.discordapp.com/embed/avatars/0.png" })
            .setDescription(
                `— **เซิร์ฟเวอร์:** ${CB}${current.serverName}${CB}\n` +
                `— **ห้องเสียง:** <#${current.voiceId}>\n` +
                `— **Token (ท้าย):** ${CB}${current.tokenTail}${CB}\n` +
                `— **สถานะ:** ${(() => { const st = current.connection?.state?.status; if (!st || st === 'destroyed' || st === 'disconnected') return `${config.emojis.status_offline} ไม่ได้เชื่อมต่อ`; if (st === 'ready') return `${config.emojis.status_online} เชื่อมต่ออยู่`; return `${config.emojis.signal} กำลังเชื่อมต่อ`; })()}\n` +
                `— **ออนเมื่อ:** <t:${Math.floor(current.startedAt / 1000)}:R>`
            )
            .setFooter({ text: `รายการของคุณ ${page + 1} / ${userSessions.length}` });

        const row = new MessageActionRow().addComponents(
            new MessageButton().setCustomId(`status_page_${page - 1}`).setEmoji(config.emojis.page_prev).setStyle("SECONDARY"),
            new MessageButton().setCustomId(`status_stop_${current.sessionId}`).setLabel("หยุดออนตัวนี้").setEmoji(config.emojis.status_offline).setStyle("DANGER"),
            new MessageButton().setCustomId(`status_page_${page + 1}`).setEmoji(config.emojis.page_next).setStyle("SECONDARY")
        );

        if (interaction.replied || interaction.deferred) {
            return interaction.update({ embeds: [embed], components: [row] });
        }
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    // Status Stop
    if (customId.startsWith("status_stop_")) {
        await interaction.deferUpdate();
        const sId = customId.replace("status_stop_", "");
        const targetSession = sessionManager.getSession(sId);
        if (!targetSession || targetSession.ownerId !== interaction.user.id) {
            return interaction.editReply({
                embeds: [new MessageEmbed().setColor(config.system.themeColors.error)
                    .setDescription(`> ${config.emojis.no_entry} คุณไม่มีสิทธิ์หยุดรายการนี้`)],
                components: []
            });
        }
        await voiceWorker.stopSession(sId);
        await updatePanel(interaction.guild.id);

        const allSessions = Array.from(sessionManager.getAllSessions().values());
        const userSessions = allSessions.filter(s =>
            s.serverId === interaction.guild.id && s.ownerId === interaction.user.id
        );
        if (userSessions.length === 0) {
            return interaction.editReply({
                embeds: [new MessageEmbed().setColor(config.system.themeColors.success).setDescription(`> ${config.emojis.success} ลบผู้ใช้งานสำเร็จ (ไม่มีรายการเหลือ)`)],
                components: []
            });
        }
        const current = userSessions[0];
        const embed = new MessageEmbed()
            .setColor(config.system.themeColors.primary)
            .setAuthor({ name: current.ownerTag || "Unknown", iconURL: current.ownerAvatar || "https://cdn.discordapp.com/embed/avatars/0.png" })
            .setDescription(`— **เซิร์ฟเวอร์:** \`${current.serverName}\`\n— **ห้องเสียง:** <#${current.voiceId}>`)
            .setFooter({ text: `รายการของคุณ 1 / ${userSessions.length}` });
        const row = new MessageActionRow().addComponents(
            new MessageButton().setCustomId(`status_page_-1`).setEmoji(config.emojis.page_prev).setStyle("SECONDARY"),
            new MessageButton().setCustomId(`status_stop_${current.sessionId}`).setLabel("หยุดออนตัวนี้").setEmoji(config.emojis.status_offline).setStyle("DANGER"),
            new MessageButton().setCustomId(`status_page_1`).setEmoji(config.emojis.page_next).setStyle("SECONDARY")
        );
        return interaction.editReply({ embeds: [embed], components: [row] });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📝  REGION 8: MODAL HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleModal(interaction, client) {
    if (interaction.customId === "modal_start") {
        await interaction.deferReply({ ephemeral: true });
        const token    = interaction.fields.getTextInputValue("token").trim();
        const serverId = interaction.fields.getTextInputValue("server_id").trim();
        const voiceId  = interaction.fields.getTextInputValue("voice_id").trim();

        if (!/^\d{17,19}$/.test(serverId)) {
            return interaction.editReply({ content: `> ${config.emojis.error} ไอดีเซิร์ฟเวอร์ไม่ถูกต้อง (ต้องเป็นตัวเลข 17-19 หลัก)` });
        }
        if (!/^\d{17,19}$/.test(voiceId)) {
            return interaction.editReply({ content: `> ${config.emojis.error} ไอดีช่องเสียงไม่ถูกต้อง (ต้องเป็นตัวเลข 17-19 หลัก)` });
        }

        try {
            const tokenUserId = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
            if (tokenUserId && tokenUserId !== interaction.user.id) {
                console.warn(`[SECURITY] ⚠️ Token owner mismatch: token=${tokenUserId}, user=${interaction.user.id} (${interaction.user.tag})`);
                if (process.env.ALERT_WEBHOOK_URL) {
                    const { WebhookClient: WC } = require("discord.js");
                    const wh = new WC({ url: process.env.ALERT_WEBHOOK_URL });
                    wh.send({
                        content: `⚠️ **[TOKEN MISMATCH]** Token owner ≠ interaction user!\n` +
                                 `**Token User ID:** \`${tokenUserId}\`\n` +
                                 `**Used By:** <@${interaction.user.id}> (\`${interaction.user.tag}\`)\n` +
                                 `**Guild:** ${interaction.guild?.name} (\`${interaction.guild?.id}\`)`
                    }).catch(() => {});
                    wh.destroy();
                }
            }
        } catch (_) {}

        const targetGuild = client.guilds.cache.get(serverId);
        const guildName   = targetGuild ? targetGuild.name : "เซิร์ฟเวอร์ไม่ทราบชื่อ";

        const TOKEN_PATTERN = /^[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}$/;
        if (!TOKEN_PATTERN.test(token)) {
            return interaction.editReply({ content: `> ${config.emojis.error} รูปแบบ Token ไม่ถูกต้อง` });
        }

        let sessionId = null;
        try {
            sessionId = await sessionManager.createSession(
                token, serverId, voiceId, guildName,
                interaction.user.id,
                interaction.user.displayAvatarURL({ dynamic: true }),
                interaction.user.tag
            );
            await voiceWorker.startSession(sessionId, token);
            await updatePanel(interaction.guild.id);

            const logCh = await getLogChannel(interaction.guild);
            if (logCh) {
                logCh.send({ embeds: [
                    new MessageEmbed()
                        .setColor(config.system.themeColors.success)
                        .setDescription(`> ${config.emojis.success} **เริ่มการทำงานผู้ใช้งานใหม่!**\n— **โดย:** <@${interaction.user.id}>\n— **เซิร์ฟเวอร์:** \`${guildName}\`\n— **ห้อง ID:** \`${voiceId}\``)
                ]}).catch(() => {});
            }
            return interaction.editReply({ content: `> ${config.emojis.success} เริ่มระบบสำเร็จ! ผู้ใช้งานเข้าห้องเสียงเรียบร้อย` });

        } catch (err) {
            if (sessionId) await sessionManager.deleteSession(sessionId).catch(() => {});
            sessionManager.systemMetrics.increment('errors');
            const errMap = {
                "INVALID_TOKEN_FORMAT": `> ${config.emojis.error} รูปแบบ Token ไม่ถูกต้อง`,
                "ALREADY_ACTIVE":       `> ${config.emojis.warning} Token นี้กำลังทำงานอยู่แล้ว`,
                "SYSTEM_LIMIT":         `> ${config.emojis.error} ระบบเต็ม! (เกินขีดจำกัด ${config.limits.maxSessions} เซสชัน)`,
                "LOGIN_TIMEOUT":        `> ${config.emojis.warning} เชื่อมต่อล่าช้า โปรดลองใหม่`,
                "TOKEN_INVALID":        `> ${config.emojis.error} Token ไม่ถูกต้อง หรือหมดอายุ`,
                "GUILD_NOT_FOUND":      `> ${config.emojis.error} บอทเข้าถึงเซิร์ฟเวอร์ไม่ได้`,
                "CHANNEL_NOT_FOUND":    `> ${config.emojis.error} ไม่พบห้องเสียง หรือไม่มีสิทธิ์เข้าห้อง`,
                "SYSTEM_SHUTTING_DOWN": `> ${config.emojis.warning} ระบบกำลังปิดตัว โปรดรอสักครู่`,
            };
            return interaction.editReply({ content: errMap[err.message] ?? `> ${config.emojis.warning} เกิดข้อผิดพลาด: ${err.message}` });
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 9: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    slashCommandsData,
    handleMessage,
    handleInteraction,
    updatePanel,
    restorePanels,
    cleanupGuild,
    getPanelMessages
};
