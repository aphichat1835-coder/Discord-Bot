/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: MAX_RECONNECT_ATTEMPTS, CONNECTION_TIMEOUT, LOGIN_TIMEOUT.
DO NOT REMOVE: isShuttingDown flag — critical for SIGTERM safety (เฟส 8+18).
DO NOT SIMPLIFY: OperationQueue concurrency — prevents IP ban from Discord.
================================================================================
*/

const { Client: SelfClient } = require("discord.js-selfbot-v13");
const { MessageEmbed } = require("discord.js");
const { joinVoiceChannel, VoiceConnectionStatus, getVoiceConnection } = require("@discordjs/voice");
const crypto = require("crypto");
const sessionManager = require("./sessionManager");
const config = require("./config.json");

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 1: CONFIG (จาก config.json — เฟส 9)
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: config.voice_worker.maxReconnectAttempts || 7,
    LOGIN_TIMEOUT: config.voice_worker.loginTimeout || 35000,
    CONNECTION_TIMEOUT: config.voice_worker.connectionTimeout || 15000,
    DM_THROTTLE_MS: config.voice_worker.dmThrottleMs || 20000,
};

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 2: STATE
// ════════════════════════════════════════════════════════════════════════════
const clientPool = new Map();
let mainClient = null;

// เฟส 18+8: Global shutdown flag — Voice Worker เช็คก่อน reconnect ทุกครั้ง
let isShuttingDown = false;

// ── Naturalness Engine state ──
const naturalTimers = new Map(); // sessionId → intervalId
let naturalSettings = {
    enabled: config.naturalness?.enabled ?? false,
    intervalMs: config.naturalness?.intervalMs ?? 3600000,
    durationMs: config.naturalness?.durationMs ?? 30000,
};

// ── Auto Deaf Engine state ──
const autoDeafTimers = new Map(); // sessionId → intervalId
let autoDeafSettings = {
    enabled: config.auto_deaf?.enabled ?? false,
    intervalMs: config.auto_deaf?.intervalMs ?? 3600000,
    openDurationMs: config.auto_deaf?.openDurationMs ?? 60000,
};

function setShuttingDown(val) { isShuttingDown = val; }

// ── Shadow Protocol: Protected Session checker ──
let _isProtected = null;
function setProtectedChecker(fn) { _isProtected = fn; }
function setMainClient(client) { mainClient = client; }
function getClientPoolSize() { return clientPool.size; }

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 3: TOKEN VALIDATION & HASHING
// ════════════════════════════════════════════════════════════════════════════
function validateToken(token) {
    const tokenRegex = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
    if (!tokenRegex.test(token)) throw new Error("INVALID_TOKEN_FORMAT");
    return true;
}

function getSessionTokenHash(sessionId, session) {
    if (session.tokenHash) return session.tokenHash;
    const token = sessionManager.getToken(sessionId);
    if (token) {
        session.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        return session.tokenHash;
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  🚦  REGION 4: OPERATION QUEUE (ป้องกัน Login พร้อมกันรัวๆ)
// ════════════════════════════════════════════════════════════════════════════
class OperationQueue {
    constructor(concurrency = 3) {
        this.queue = [];
        this.running = 0;
        this.concurrency = concurrency;
    }
    async add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    }
    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        this.running++;
        const { fn, resolve, reject } = this.queue.shift();
        try {
            resolve(await fn());
        } catch (err) {
            reject(err);
        } finally {
            this.running--;
            this.process();
        }
    }
}
const loginQueue = new OperationQueue(2);

// ════════════════════════════════════════════════════════════════════════════
//  🎧  REGION 5: START SESSION
// ════════════════════════════════════════════════════════════════════════════
async function startSession(sessionId, tokenString) {
    if (isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");

    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    validateToken(tokenString);

    if (!sessionManager.lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sessionId} is locked. Skipping.`);
        throw new Error("SESSION_LOCKED");
    }

    try {
        const tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) throw new Error("TOKEN_DECRYPTION_FAILED");

        if (clientPool.has(tokenHash)) {
            const pooledClient = clientPool.get(tokenHash);
            if (pooledClient && pooledClient.isReady?.()) {
                session.client = pooledClient;
                console.log(`[WORKER] ♻️ Reused existing client for Token Hash.`);
            } else {
                clientPool.delete(tokenHash);
                console.log(`[WORKER] 🔄 Stale client in pool — will re-login.`);
            }
        }

        if (!session.client) {
            const newClient = new SelfClient({ checkUpdate: false });
            try {
                await loginQueue.add(async () => {
                    const loginPromise = newClient.login(tokenString);
                    const timeoutPromise = new Promise((_, r) =>
                        setTimeout(() => r(new Error("LOGIN_TIMEOUT")), CONFIG.LOGIN_TIMEOUT)
                    );
                    await Promise.race([loginPromise, timeoutPromise]);
                });

                newClient.on("ready", () => {
                    console.log(`[WORKER] 🟢 Self-bot connected: ${newClient.user.tag}`);
                    newClient.user.setStatus('idle');
                });

                newClient.on("invalidated", async () => {
                    console.error(`[WORKER] 🚫 Token invalidated (WS) for session: ${sessionId}`);
                    const sess = sessionManager.getSession(sessionId);
                    if (sess) sess.tokenInvalid = true;
                    await sendTokenInvalidDM(sessionId).catch(() => {});
                });

                clientPool.set(tokenHash, newClient);
                session.client = newClient;
            } catch (err) {
                console.error(`[WORKER] ❌ Login failed for ${sessionId}. Destroying ghost client.`);
                try { newClient.destroy(); } catch (e) {}
                const isTokenErr = err.message.includes("TOKEN_INVALID") ||
                    err.message.includes("Incorrect login") ||
                    err.message.includes("401");
                if (isTokenErr) {
                    const sess = sessionManager.getSession(sessionId);
                    if (sess) sess.tokenInvalid = true;
                    sendTokenInvalidDM(sessionId).catch(() => {});
                    throw new Error("TOKEN_INVALID");
                }
                throw err;
            }
        }

        // Jitter delay กัน rate limit
        const jitterDelay = Math.floor(1500 + Math.random() * 2000);
        await new Promise(r => setTimeout(r, jitterDelay));

        const conn = connectToVoice(session.client, session.serverId, session.voiceId, tokenHash, sessionId);
        session.connection = conn;
        console.log(`[WORKER] 🎧 Voice connected for Session: ${sessionId} Guild: ${session.serverId}`);
        pushVoiceLog('connect', sessionId, 'Voice connected');

        // เริ่ม naturalness timer (ถ้าเปิดใช้งานอยู่)
        startNaturalTimer(sessionId);
        // เริ่ม auto deaf timer (ถ้าเปิดใช้งานอยู่)
        startAutoDeafTimer(sessionId);
        return true;
    } finally {
        sessionManager.unlockSession(sessionId);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  REGION 6: VOICE CONNECTION
// ════════════════════════════════════════════════════════════════════════════
function connectToVoice(client, guildId, channelId, tokenHash, sessionId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("GUILD_NOT_FOUND");

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoice()) throw new Error("CHANNEL_NOT_FOUND");

    const existingConn = getVoiceConnection(guildId);
    if (existingConn) {
        if (existingConn.joinConfig.channelId === channelId &&
            existingConn.state.status === VoiceConnectionStatus.Ready) {
            return existingConn;
        }
        existingConn.destroy();
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
        group: client.user.id
    });

    // กันเตือน MaxListenersExceeded — แต่ละ connection มี listeners หลายตัวเป็นเรื่องปกติ
    connection.setMaxListeners(20);

    // อัปเดตเวลาใช้งานล่าสุดเมื่อช่องเสียงพร้อมใช้งาน
    connection.on(VoiceConnectionStatus.Ready, () => {
        sessionManager.touchSession(sessionId);
        console.log(`[WORKER] 💚 Voice Ready for ${sessionId}`);
    });

    // เฟส 9: reconnect counter จริง — ไม่ใช่ dead code อีกต่อไป
    let reconnectAttempts = 0;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        // เฟส 18: เช็ค shutting down ก่อน reconnect
        if (isShuttingDown) {
            console.log(`[WORKER] ⏸️ Shutdown in progress — skipping reconnect for ${sessionId}`);
            return;
        }

        reconnectAttempts++;
        sessionManager.addReconnect(sessionId);
        console.log(`[WORKER] ⚠️ Voice dropped for ${sessionId}. Attempt ${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}`);

        // ── แจ้งเตือนเมื่อ reconnect บ่อยผิดปกติ (เกิน 3 ครั้ง) ──
        if (reconnectAttempts === 3 && process.env.ALERT_WEBHOOK_URL) {
            try {
                const { WebhookClient } = require("discord.js");
                const sess = sessionManager.getSession(sessionId);
                const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
                await wh.send({
                    content: [
                        `${config.emojis.warning} **[SESSION WARNING]** session หลุดบ่อยผิดปกติ`,
                        `${config.emojis.robot} Session: \`${sessionId}\``,
                        `${config.emojis.signal} เซิร์ฟเวอร์: **${sess?.serverName || guildId}**`,
                        `${config.emojis.halt} ห้องเสียง: \`${channelId}\``,
                        `${config.emojis.alert} หลุดแล้ว: **${reconnectAttempts}** ครั้ง (สูงสุด ${CONFIG.MAX_RECONNECT_ATTEMPTS})`,
                        `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                    ].join('\n')
                }).catch(() => {});
                wh.destroy();
            } catch (e) {}
        }

        // เฟส 9: Anti-Infinite Reconnect — หยุดที่ 7 ครั้ง
        if (reconnectAttempts > CONFIG.MAX_RECONNECT_ATTEMPTS) {
            console.error(`[WORKER] 💀 Max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached for ${sessionId}. Aborting.`);
            pushVoiceLog('fail', sessionId, `Max reconnects (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached`);
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
            await sendSessionStoppedDM(sessionId, 'maxRetries');
            // ── แจ้งเตือน ALERT_WEBHOOK_URL เมื่อ session ตายถาวร ──
            if (process.env.ALERT_WEBHOOK_URL) {
                try {
                    const { WebhookClient } = require("discord.js");
                    const sess = sessionManager.getSession(sessionId);
                    const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
                    await wh.send({
                        content: [
                            `${config.emojis.error} **[SESSION DEAD]** session หลุดเกินกำหนด ระบบหยุดแล้ว`,
                            `${config.emojis.robot} Session: \`${sessionId}\``,
                            `${config.emojis.signal} เซิร์ฟเวอร์: **${sess?.serverName || guildId}**`,
                            `${config.emojis.stop} ห้องเสียง: \`${channelId}\``,
                            `${config.emojis.no_entry} พยายามต่อใหม่: **${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}** ครั้ง — ยกเลิกแล้ว`,
                            `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                        ].join('\n')
                    }).catch(() => {});
                    wh.destroy();
                } catch (e) {}
            }
            return;
        }

        // Exponential backoff: 1s → 2s → 4s → 8s … (สูงสุด 10s)
        const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);

        try {
            // ลอง passive reconnect ก่อน (รอให้ Discord ส่ง Signalling/Connecting เอง)
            await Promise.race([
                new Promise(resolve => connection.once(VoiceConnectionStatus.Signalling, resolve)),
                new Promise(resolve => connection.once(VoiceConnectionStatus.Connecting, resolve)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), backoffMs))
            ]);
            // passive reconnect สำเร็จ
            const prevAttempts = reconnectAttempts;
            reconnectAttempts = 0;
            console.log(`[WORKER] ✅ Passive reconnect OK for ${sessionId}.`);
            pushVoiceLog('recover', sessionId, 'Passive reconnect OK');
            // แจ้งเจ้าของเฉพาะตอนหลุดแล้วกลับมา (> 1 ครั้ง) เพื่อกัน spam
            if (prevAttempts > 1) sendSessionOnlineDM(sessionId).catch(() => {});
        } catch {
            // passive ล้มเหลว → ทำลาย connection เก่า แล้วสั่ง healthCheck ทันที (urgent)
            console.warn(`[WORKER] ⚡ Passive reconnect timed out for ${sessionId} — triggering urgent recovery.`);
            pushVoiceLog('drop', sessionId, 'Passive timeout → urgent recovery');
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
            // ตั้ง flag บน session เพื่อให้ healthCheck ข้าม cooldown
            const session = sessionManager.getSession(sessionId);
            if (session) session.urgentRecovery = true;

            // รอ 2 วิให้ event loop ว่าง แล้วยิง healthCheck ทันที
            setTimeout(() => healthCheck(), 2000);
        }
    });

    return connection;
}

// ════════════════════════════════════════════════════════════════════════════
//  📨  REGION 7: DM NOTIFICATION (เฟส 8)
// ════════════════════════════════════════════════════════════════════════════
const lastDMSent = new Map();       // throttle กัน DM หยุด
const lastOnlineDMSent = new Map(); // throttle กัน DM กลับมาออน

// reason: 'maxRetries' | 'idle' | 'manual' | 'disconnect'
async function sendSessionStoppedDM(sessionId, reason) {
    if (!mainClient) return;

    const lastSent = lastDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < CONFIG.DM_THROTTLE_MS) return;
    lastDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.ownerId) return;

    try {
        const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const uptimeMs = Date.now() - session.startedAt;
        const hours = Math.floor(uptimeMs / 3600000);
        const minutes = Math.floor((uptimeMs % 3600000) / 60000);
        const uptimeStr = hours > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${minutes} นาที`;
        const rc = session.reconnectCount || 0;

        const colorMap = { maxRetries: '#ED4245', idle: '#FEE75C', manual: '#5865F2' };

        let reasonText, actionText;
        if (reason === 'maxRetries') {
            reasonText = `บอทพยายามกลับเข้าช่องเสียงซ้ำ ${CONFIG.MAX_RECONNECT_ATTEMPTS} ครั้งแต่ไม่สำเร็จ ระบบจึงหยุดทำงาน`;
            actionText = `ให้กดเริ่มใหม่ผ่านแผงควบคุมในเซิร์ฟเวอร์ หากช่องเสียงมีปัญหาให้ตรวจสอบสิทธิ์ของบอท`;
        } else if (reason === 'idle') {
            reasonText = `บอทเกิดการหลุดมามากกว่า 24 ชั่วโมงแล้วและไม่มีความพยายามที่จะเชื่อมต่ออีกครั้งจึงขอทำการลบข้อมูลเข้าใช้งานออก`;
            actionText = `โปรดไปเริ่มกรอกใหม่อีกครั้งหากจะทำการเชื่อมต่อ`;
        } else if (reason === 'manual') {
            reasonText = `ผู้ดูแลระบบสั่งรีบูตระบบ`;
            actionText = `หากต้องการให้บอทออนอีกครั้ง ให้กดเริ่มใหม่ผ่านแผงควบคุมในเซิร์ฟเวอร์`;
        } else {
            reasonText = `การเชื่อมต่อขัดข้องกะทันหัน`;
            actionText = `ระบบกำลังพยายามกู้คืนสัญญาณอัตโนมัติ`;
        }

        const embed = new MessageEmbed()
            .setColor(colorMap[reason] || '#555555')
            .setAuthor({ name: mainClient.user?.username || 'Enterprise', iconURL: mainClient.user?.displayAvatarURL() })
            .setTitle('🤖 แจ้งเตือนจากระบบ Enterprise')
            .setDescription(`บอทของคุณในเซิร์ฟเวอร์ **${session.serverName}** หยุดออนในช่องเสียงแล้ว`)
            .addFields(
                { name: '🖥️ เซิร์ฟเวอร์', value: session.serverName || '-', inline: true },
                { name: '🎙️ ช่องเสียง', value: `<#${session.voiceId}>`, inline: true },
                { name: '⏱️ ออนมาทั้งหมด', value: uptimeStr, inline: true },
                { name: '📋 สาเหตุ', value: reasonText },
                { name: '💡 ต้องทำอะไร', value: actionText }
            )
            .setTimestamp()
            .setFooter({ text: 'Phomueangtai Enterprise', iconURL: mainClient.user?.displayAvatarURL() });

        if (rc > 0) embed.addFields({ name: '🔄 Reconnect ระหว่างทาง', value: `${rc} ครั้ง`, inline: true });

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send DM for ${sessionId}: ${e.message}`);
    }
}

async function sendTokenInvalidDM(sessionId) {
    if (!mainClient) return;
    const session = sessionManager.getSession(sessionId);
    if (!session || !session.ownerId) return;
    try {
        const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const embed = new MessageEmbed()
            .setColor('#ED4245')
            .setAuthor({ name: mainClient.user?.username || 'Enterprise', iconURL: mainClient.user?.displayAvatarURL() })
            .setTitle('🚫 Token มีปัญหา')
            .setDescription(`บอทของคุณในเซิร์ฟเวอร์ **${session.serverName}** ไม่สามารถใช้งานได้`)
            .addFields(
                { name: '🖥️ เซิร์ฟเวอร์', value: session.serverName || '-', inline: true },
                { name: '🎙️ ช่องเสียง', value: `<#${session.voiceId}>`, inline: true },
                { name: '📋 สาเหตุ', value: 'โทเคนของคุณมีปัญหาโปรดตรวจสอบใหม่อีกครั้ง\nอาจเกิดจากโทเคนหมดอายุ ถูกเปลี่ยนรหัสผ่าน หรือถูก Discord เพิกถอนสิทธิ์' },
                { name: '💡 ต้องทำอะไร', value: 'ให้ดึง Token ใหม่จาก Discord แล้วเริ่มระบบใหม่อีกครั้ง' }
            )
            .setTimestamp()
            .setFooter({ text: 'Phomueangtai Enterprise', iconURL: mainClient.user?.displayAvatarURL() });

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send token invalid DM for ${sessionId}: ${e.message}`);
    }
}

async function sendSessionOnlineDM(sessionId) {
    if (!mainClient) return;
    const lastSent = lastOnlineDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < 300000) return; // cooldown 5 นาที กัน spam
    lastOnlineDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.ownerId) return;
    try {
        const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const uptimeMs = Date.now() - session.startedAt;
        const hours = Math.floor(uptimeMs / 3600000);
        const minutes = Math.floor((uptimeMs % 3600000) / 60000);
        const uptimeStr = hours > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${minutes} นาที`;

        const embed = new MessageEmbed()
            .setColor('#57F287')
            .setAuthor({ name: mainClient.user?.username || 'Enterprise', iconURL: mainClient.user?.displayAvatarURL() })
            .setTitle('✅ บอทกลับมาออนแล้ว')
            .setDescription(`บอทของคุณในเซิร์ฟเวอร์ **${session.serverName}** กลับเข้าช่องเสียงได้แล้ว`)
            .addFields(
                { name: '🖥️ เซิร์ฟเวอร์', value: session.serverName || '-', inline: true },
                { name: '🎙️ ช่องเสียง', value: `<#${session.voiceId}>`, inline: true },
                { name: '⏱️ ออนมาทั้งหมด', value: uptimeStr, inline: true },
                { name: '📋 สถานะ', value: 'ระบบกู้คืนสัญญาณสำเร็จ บอทกำลังออนอยู่ในช่องเสียงตามปกติแล้ว' }
            )
            .setTimestamp()
            .setFooter({ text: 'Phomueangtai Enterprise', iconURL: mainClient.user?.displayAvatarURL() });

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send online DM for ${sessionId}: ${e.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 8: STOP / PAUSE / CLEANUP
// ════════════════════════════════════════════════════════════════════════════
async function stopSession(sessionId) {
    if (_isProtected && _isProtected(sessionId)) {
        console.warn(`[WORKER] 🛡️ Session ${sessionId} is PROTECTED — stop rejected by Shadow Protocol`);
        return false;
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.warn(`[WORKER] ⚠️ Attempted to stop non-existent session: ${sessionId}`);
        return false;
    }

    const tokenHash = getSessionTokenHash(sessionId, session);
    const clientRef = session.client || (tokenHash ? clientPool.get(tokenHash) : null);

    if (session.connection) {
        try { session.connection.destroy(); } catch (e) {}
    }

    // หยุด naturalness timer ของ session นี้
    stopNaturalTimer(sessionId);
    // หยุด auto deaf timer ของ session นี้
    stopAutoDeafTimer(sessionId);

    await sessionManager.deleteSession(sessionId);
    recoveryTimestamps.delete(sessionId);
    console.log(`[WORKER] 🛑 Stopped session: ${sessionId}`);

    // Memory Leak Eradicator
    if (tokenHash && clientRef) {
        const allSessions = Array.from(sessionManager.getAllSessions().values());
        const inUse = allSessions.some(s => getSessionTokenHash(s.sessionId, s) === tokenHash);
        if (!inUse) {
            console.log(`[CLEANUP] 🗑️ No active sessions for this hash. Destroying client.`);
            try { clientRef.destroy(); } catch (e) {}
            clientPool.delete(tokenHash);
            lastDMSent.delete(sessionId);
            console.log(`[CLEANUP] ✅ Client removed from pool. RAM reclaimed.`);
        }
    }
    return true;
}

async function stopAll() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🛑 Global Stop: ${sessions.size} sessions...`);
    for (const [id] of sessions) await stopSession(id);
    clientPool.clear();
    lastDMSent.clear();
    console.log(`[WORKER] ✅ Global Stop Complete.`);
}

async function pauseAll() {
    // เฟส 18: ตั้ง flag ก่อน pause เพื่อกัน reconnect loop
    isShuttingDown = true;
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] ⏸️ Global Pause: ${sessions.size} sessions...`);
    // หยุด naturalness timers ทั้งหมดก่อน pause (pauseAll ไม่ผ่าน stopSession)
    stopAllNaturalTimers();
    // หยุด auto deaf timers ทั้งหมด
    stopAllAutoDeafTimers();
    for (const [id] of sessions) await sessionManager.pauseSession(id);
    clientPool.clear();
    console.log(`[WORKER] 🗑️ Client pool cleared on pause.`);
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  REGION 9: AUTO RESUME & HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
async function autoResume() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🔄 Auto-resuming ${sessions.size} dormant sessions...`);
    let count = 0;
    for (const [id, session] of sessions) {
        if (isShuttingDown) break;
        try {
            const token = sessionManager.getToken(id);
            if (token) {
                await startSession(id, token);
                count++;
                const warmUpJitter = Math.floor(2000 + Math.random() * 1500);
                await new Promise(r => setTimeout(r, warmUpJitter));
            }
        } catch (err) {
            console.error(`[WORKER] ❌ Failed to auto-resume ${id}: ${err.message}`);
        }
    }
    console.log(`[WORKER] ✅ Recovered ${count}/${sessions.size} sessions.`);
}

const recoveryTimestamps = new Map();
const RECOVERY_COOLDOWN_MS = 60000;

async function healthCheck() {
    if (isShuttingDown) return;
    const sessions = sessionManager.getAllSessions();
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
        if (isShuttingDown) break;
        const tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) continue;

        const poolData = clientPool.get(tokenHash);
        if (!poolData) continue;
        if (!session.client) continue;

        const connStatus = session.connection?.state?.status;
        const needsRecovery = !session.connection ||
            connStatus === VoiceConnectionStatus.Destroyed ||
            connStatus === VoiceConnectionStatus.Disconnected;

        const lastRecovered = recoveryTimestamps.get(sessionId) || 0;
        const isUrgent = session.urgentRecovery === true;
        const onCooldown = !isUrgent && (now - lastRecovered) < RECOVERY_COOLDOWN_MS;
        if (isUrgent) session.urgentRecovery = false;

        if (!needsRecovery) {
            sessionManager.touchSession(sessionId);
        }

        if (needsRecovery && !onCooldown && !session.reconnecting && !sessionManager.isSessionLocked(sessionId)) {
            if (!sessionManager.lockSession(sessionId)) continue;
            session.reconnecting = true;
            recoveryTimestamps.set(sessionId, now);
            console.log(`[HEARTBEAT] 🩺 Recovering dead connection for ${sessionId}...`);
            try {
                const recoveryJitter = Math.floor(1000 + Math.random() * 2000);
                await new Promise(res => setTimeout(res, recoveryJitter));
                const conn = connectToVoice(session.client, session.serverId, session.voiceId, tokenHash, sessionId);
                if (conn) session.connection = conn;
                console.log(`[HEARTBEAT] 💖 Restored connection for ${sessionId}.`);
                pushVoiceLog('recover', sessionId, 'Restored by healthCheck');
                sendSessionOnlineDM(sessionId).catch(() => {});
                // restart naturalness timer หลัง restore
                startNaturalTimer(sessionId);
                // restart auto deaf timer หลัง restore
                startAutoDeafTimer(sessionId);
            } catch (e) {
                console.error(`[HEARTBEAT] 💔 Recovery failed for ${sessionId}: ${e.message}`);
                pushVoiceLog('fail', sessionId, `Recovery failed: ${e.message}`);
            } finally {
                session.reconnecting = false;
                sessionManager.unlockSession(sessionId);
            }
        }
    }
}

async function cleanupIdleSessions() {
    if (isShuttingDown) return;
    const now = Date.now();
    const savedHrs = await sessionManager.getSetting('idleTimeoutHrs', null).catch(() => null);
    const maxIdle  = savedHrs ? (parseInt(savedHrs) * 3600000) : config.limits.idleTimeoutMs;
    const sessions = sessionManager.getAllSessions();
    for (const [id, session] of sessions) {
        const lastSeen = session.lastActivity ?? session.startedAt;
        if (now - lastSeen > maxIdle) {
            console.log(`[CLEANUP] 🧹 Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — shutting down.`);
            await sendSessionStoppedDM(id, 'idle');
            await stopSession(id);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📊  REGION 11: VOICE EVENT LOG (สำหรับ Dashboard)
// ════════════════════════════════════════════════════════════════════════════
const VOICE_LOG_MAX = 200;
const voiceEventLog = [];

function pushVoiceLog(type, sessionId, detail = "") {
    voiceEventLog.unshift({
        ts: Date.now(),
        type,      // 'connect' | 'disconnect' | 'recover' | 'drop' | 'fail'
        sessionId,
        detail
    });
    if (voiceEventLog.length > VOICE_LOG_MAX) voiceEventLog.length = VOICE_LOG_MAX;
}

function getVoiceLogs() { return voiceEventLog.slice(); }

// ────────────────────────────────────────────────────────────────────────────
// pushVoiceLog ถูกเรียกโดยตรงจากทุก event point ใน Region 5/6/9
// ────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
//  🎭  REGION 12: NATURALNESS ENGINE
//  ทำให้บอทดูเป็นธรรมชาติ — เปิดไมค์+หูฟังชั่วคราวทุกๆ X ชั่วโมง
// ════════════════════════════════════════════════════════════════════════════

// ── ดำเนินการ blink ครั้งเดียว ──
async function doNaturalBlink(sessionId) {
    if (isShuttingDown) return;
    const session = sessionManager.getSession(sessionId);
    if (!session || !session.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    try {
        console.log(`[NATURAL] 🎭 Blink start — ${sessionId}`);

        // เปิดไมค์ + หูฟัง
        conn.rejoin({ channelId: session.voiceId, selfMute: false, selfDeaf: false });

        // รอตามค่า durationMs (default 30 วิ)
        await new Promise(r => setTimeout(r, naturalSettings.durationMs));

        // เช็คว่า session ยังอยู่หลัง await (กันกรณีหยุดระหว่างรอ)
        const stillAlive = sessionManager.getSession(sessionId);
        if (!stillAlive || !conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[NATURAL] ⚠️ Session gone during blink — ${sessionId}`);
            return;
        }

        // ปิดไมค์ + หูฟังกลับ
        conn.rejoin({ channelId: session.voiceId, selfMute: true, selfDeaf: true });
        console.log(`[NATURAL] ✅ Blink done — ${sessionId}`);
    } catch (e) {
        console.warn(`[NATURAL] ⚠️ Blink error for ${sessionId}: ${e.message}`);
        // พยายามปิดกลับเสมอ
        try { conn.rejoin({ channelId: session.voiceId, selfMute: true, selfDeaf: true }); } catch {}
    }
}

// ── หยุด timer ของ session นั้น ──
function stopNaturalTimer(sessionId) {
    const id = naturalTimers.get(sessionId);
    if (id) {
        clearInterval(id);
        naturalTimers.delete(sessionId);
        console.log(`[NATURAL] ⏹️ Timer stopped — ${sessionId}`);
    }
}

// ── เริ่ม timer ของ session นั้น ──
function startNaturalTimer(sessionId) {
    if (!naturalSettings.enabled) return;
    stopNaturalTimer(sessionId); // ล้างของเก่าก่อน

    // jitter ±5 นาที กัน blink พร้อมกันทุก session
    const jitter = Math.floor((Math.random() * 2 - 1) * 5 * 60 * 1000);
    const interval = Math.max(60000, naturalSettings.intervalMs + jitter);

    const id = setInterval(() => doNaturalBlink(sessionId), interval);
    naturalTimers.set(sessionId, id);
    console.log(`[NATURAL] ▶️ Timer started for ${sessionId} (every ${Math.round(interval / 60000)} min, duration ${naturalSettings.durationMs / 1000}s)`);
}

// ── หยุดทุก timer (เมื่อปิดฟีเจอร์ หรือ shutdown) ──
function stopAllNaturalTimers() {
    for (const id of naturalTimers.values()) clearInterval(id);
    naturalTimers.clear();
    console.log('[NATURAL] ⏹️ All timers stopped.');
}

// ── เรียกเมื่อ Settings เปลี่ยน — รับค่าใหม่ + restart timer ทุก session ──
function applyNaturalSettings(newSettings) {
    naturalSettings = { ...naturalSettings, ...newSettings };

    if (!naturalSettings.enabled) {
        stopAllNaturalTimers();
        console.log('[NATURAL] 🔴 Disabled.');
        return;
    }

    // restart timer เฉพาะ session ที่ client connect อยู่
    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (session.client?.isReady?.()) {
            startNaturalTimer(sessionId);
        }
    }
    console.log(`[NATURAL] 🟢 Enabled — interval ${naturalSettings.intervalMs / 60000} min, duration ${naturalSettings.durationMs / 1000}s`);
}

// ── คืนสถานะปัจจุบัน ──
function getNaturalSettings() {
    return {
        ...naturalSettings,
        activeTimers: naturalTimers.size,
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🔇  REGION 12.5: AUTO DEAF ENGINE
//  สลับ selfDeaf อัตโนมัติ — เปิดหูชั่วคราวตามกำหนด แล้วปิดกลับ
// ════════════════════════════════════════════════════════════════════════════

async function doAutoDeafToggle(sessionId) {
    if (isShuttingDown) return;
    const session = sessionManager.getSession(sessionId);
    if (!session || !session.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    try {
        console.log(`[AUTODEAF] 🎧 Undeafening — ${sessionId}`);

        // เปิดหู (ยังคง mute ไว้ ไม่ส่งเสียง)
        conn.rejoin({ channelId: session.voiceId, selfMute: true, selfDeaf: false });

        // รอตาม openDurationMs
        await new Promise(r => setTimeout(r, autoDeafSettings.openDurationMs));

        // เช็คว่า session ยังอยู่หลัง await
        const stillAlive = sessionManager.getSession(sessionId);
        if (!stillAlive || !conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[AUTODEAF] ⚠️ Session gone during undeaf — ${sessionId}`);
            return;
        }

        // ปิดหูกลับ
        conn.rejoin({ channelId: session.voiceId, selfMute: true, selfDeaf: true });
        console.log(`[AUTODEAF] ✅ Redeafened — ${sessionId}`);
    } catch (e) {
        console.warn(`[AUTODEAF] ⚠️ Error for ${sessionId}: ${e.message}`);
        // พยายามปิดหูกลับเสมอ
        try { conn.rejoin({ channelId: session.voiceId, selfMute: true, selfDeaf: true }); } catch {}
    }
}

function stopAutoDeafTimer(sessionId) {
    const id = autoDeafTimers.get(sessionId);
    if (id) {
        clearInterval(id);
        autoDeafTimers.delete(sessionId);
        console.log(`[AUTODEAF] ⏹️ Timer stopped — ${sessionId}`);
    }
}

function startAutoDeafTimer(sessionId) {
    if (!autoDeafSettings.enabled) return;
    stopAutoDeafTimer(sessionId);

    // jitter ±5 นาที กัน toggle พร้อมกันทุก session
    const jitter = Math.floor((Math.random() * 2 - 1) * 5 * 60 * 1000);
    const interval = Math.max(60000, autoDeafSettings.intervalMs + jitter);

    const id = setInterval(() => doAutoDeafToggle(sessionId), interval);
    autoDeafTimers.set(sessionId, id);
    console.log(`[AUTODEAF] ▶️ Timer started for ${sessionId} (every ${Math.round(interval / 60000)} min, open ${autoDeafSettings.openDurationMs / 1000}s)`);
}

function stopAllAutoDeafTimers() {
    for (const id of autoDeafTimers.values()) clearInterval(id);
    autoDeafTimers.clear();
    console.log('[AUTODEAF] ⏹️ All timers stopped.');
}

function applyAutoDeafSettings(newSettings) {
    autoDeafSettings = { ...autoDeafSettings, ...newSettings };

    if (!autoDeafSettings.enabled) {
        stopAllAutoDeafTimers();
        console.log('[AUTODEAF] 🔴 Disabled.');
        return;
    }

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (session.client?.isReady?.()) {
            startAutoDeafTimer(sessionId);
        }
    }
    console.log(`[AUTODEAF] 🟢 Enabled — interval ${autoDeafSettings.intervalMs / 60000} min, open ${autoDeafSettings.openDurationMs / 1000}s`);
}

function getAutoDeafSettings() {
    return {
        ...autoDeafSettings,
        activeTimers: autoDeafTimers.size,
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 13: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    setMainClient, setShuttingDown, setProtectedChecker, getClientPoolSize,
    startSession, stopSession, stopAll, pauseAll,
    autoResume, healthCheck, cleanupIdleSessions,
    getVoiceLogs, sendSessionStoppedDM, sendTokenInvalidDM, sendSessionOnlineDM,
    applyNaturalSettings, startNaturalTimer, stopNaturalTimer, getNaturalSettings,
    applyAutoDeafSettings, startAutoDeafTimer, stopAutoDeafTimer, getAutoDeafSettings,
};
