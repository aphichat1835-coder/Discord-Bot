/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: MAX_RECONNECT_ATTEMPTS, CONNECTION_TIMEOUT, LOGIN_TIMEOUT.
DO NOT REMOVE: isShuttingDown flag — critical for SIGTERM safety (เฟส 8+18).
DO NOT SIMPLIFY: OperationQueue concurrency — prevents IP ban from Discord.
================================================================================
*/

const { Client: SelfClient } = require("discord.js-selfbot-v13");
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

function setShuttingDown(val) { isShuttingDown = val; }
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
            session.client = clientPool.get(tokenHash);
            console.log(`[WORKER] ♻️ Reused existing client for Token Hash.`);
        } else {
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

                clientPool.set(tokenHash, newClient);
                session.client = newClient;
            } catch (err) {
                console.error(`[WORKER] ❌ Login failed for ${sessionId}. Destroying ghost client.`);
                try { newClient.destroy(); } catch (e) {}
                if (err.message.includes("TOKEN_INVALID")) throw new Error("TOKEN_INVALID");
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
            await sendDisconnectDM(sessionId, guildId, channelId, true);
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
            reconnectAttempts = 0;
            console.log(`[WORKER] ✅ Passive reconnect OK for ${sessionId}.`);
            pushVoiceLog('recover', sessionId, 'Passive reconnect OK');
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
const lastDMSent = new Map(); // throttle กัน DM สแปม

async function sendDisconnectDM(sessionId, guildId, channelId, isAborted) {
    if (!mainClient) return;

    // เช็ค throttle — ไม่ส่ง DM ถี่เกิน CONFIG.DM_THROTTLE_MS
    const lastSent = lastDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < CONFIG.DM_THROTTLE_MS) return;
    lastDMSent.set(sessionId, Date.now());

    let session = null;
    for (const [id, s] of sessionManager.getAllSessions()) {
        if (s.serverId === guildId && s.voiceId === channelId) {
            session = s;
            break;
        }
    }

    if (!session || !session.ownerId) return;

    try {
        const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const uptimeMs = Date.now() - session.startedAt;
        const hours = Math.floor(uptimeMs / 3600000);
        const minutes = Math.floor((uptimeMs % 3600000) / 60000);
        const uptimeStr = hours > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${minutes} นาที`;

        const abortMsg = isAborted
            ? `> ❌ **ระบบยกเลิกการเชื่อมต่อแล้ว** (เกิน ${CONFIG.MAX_RECONNECT_ATTEMPTS} ครั้ง)`
            : `> 🔄 *ระบบกำลังพยายามกู้คืนสัญญาณ กรุณารอสักครู่...*`;

        const dmMessage =
            `> ${config.emojis.alert} **ระบบแจ้งเตือนช่องเสียงขัดข้อง**\n` +
            `> ${config.emojis.warning} **ผู้ใช้งาน:** \`${session.ownerTag}\`\n` +
            `> ${config.emojis.robot} **เซิร์ฟเวอร์:** **${session.serverName}**\n` +
            `> 🎙️ **ห้องเสียง:** <#${session.voiceId}>\n` +
            `> ⏱️ **ระยะเวลาออนล่าสุด:** ${uptimeStr}\n` +
            abortMsg;

        owner.send(dmMessage).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send disconnect DM for ${sessionId}: ${e.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 8: STOP / PAUSE / CLEANUP
// ════════════════════════════════════════════════════════════════════════════
async function stopSession(sessionId) {
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
    for (const [id] of sessions) await sessionManager.pauseSession(id);
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
    const maxIdle = config.limits.idleTimeoutMs;
    const sessions = sessionManager.getAllSessions();
    for (const [id, session] of sessions) {
        const lastSeen = session.lastActivity ?? session.startedAt;
        if (now - lastSeen > maxIdle) {
            console.log(`[CLEANUP] 🧹 Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — shutting down.`);
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
//  📤  REGION 12: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    setMainClient, setShuttingDown, getClientPoolSize,
    startSession, stopSession, stopAll, pauseAll,
    autoResume, healthCheck, cleanupIdleSessions,
    getVoiceLogs
};
