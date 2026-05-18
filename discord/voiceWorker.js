const { Client: SelfClient } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, VoiceConnectionStatus, getVoiceConnection } = require("@discordjs/voice");
const crypto = require("crypto");
const sessionManager = require("./sessionManager");
const config = require("./config.json");

const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: 7,
    LOGIN_TIMEOUT: 35000,
    CONNECTION_TIMEOUT: 15000,
};

// เปลี่ยน Key ของ Map จาก Token ท้าย 8 ตัว เป็น SHA-256 Hash ป้องกันการชนกัน 100%
const clientPool = new Map(); 
let mainClient = null;

function setMainClient(client) {
    mainClient = client;
}

function getClientPoolSize() {
    return clientPool.size;
}

function validateToken(token) {
    const tokenRegex = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
    if (!tokenRegex.test(token)) {
        throw new Error("INVALID_TOKEN_FORMAT");
    }
    return true;
}

// ฟังก์ชันแปลง Token เป็น SHA-256 Hash เพื่อใช้เป็น Key ปลอดภัยใน clientPool
function getSessionTokenHash(sessionId, session) {
    if (session.tokenHash) return session.tokenHash;
    const token = sessionManager.getToken(sessionId);
    if (token) {
        session.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        return session.tokenHash;
    }
    return null;
}

// ════════════════════════════════════════════════════════════════
//  🚀  LOGIN CONCURRENCY MANAGER (ป้องกันการ Login พร้อมกันรัวๆ)
// ════════════════════════════════════════════════════════════════
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
const loginQueue = new OperationQueue(2); // ลิมิต Login พร้อมกันแค่ 2 ตัว ป้องกัน IP โดนแบน

// ════════════════════════════════════════════════════════════════
//  🎧  VOICE SESSION CONTROLLER
// ════════════════════════════════════════════════════════════════
async function startSession(sessionId, tokenString) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    
    validateToken(tokenString);

    if (!sessionManager.lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sessionId} is currently locked. Skipping start.`);
        throw new Error("SESSION_LOCKED");
    }

    try {
        const tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) throw new Error("TOKEN_DECRYPTION_FAILED");

        // ตรวจสอบจาก Pool ด้วย Hash ขั้นสูง
        if (clientPool.has(tokenHash)) {
            session.client = clientPool.get(tokenHash);
            console.log(`[WORKER] ♻️ Reused existing client for Token Hash.`);
        } else {
            const newClient = new SelfClient({ checkUpdate: false });
            
            try {
                await loginQueue.add(async () => {
                    const loginPromise = newClient.login(tokenString);
                    const timeoutPromise = new Promise((_, r) => setTimeout(() => r(new Error("LOGIN_TIMEOUT")), CONFIG.LOGIN_TIMEOUT));
                    await Promise.race([loginPromise, timeoutPromise]);
                });

                newClient.on("ready", () => {
                    console.log(`[WORKER] 🟢 Self-bot User Connected: ${newClient.user.tag} (ID: ${newClient.user.id})`);
                    newClient.user.setStatus('idle'); 
                });

                clientPool.set(tokenHash, newClient);
                session.client = newClient;
            } catch (err) {
                // Ghost Client Eradication! ทำลายร่างซอมบี้ทิ้งทันทีหากล็อกอินไม่สำเร็จ
                console.error(`[WORKER] ❌ Login failed for session ${sessionId}. Destroying ghost client to prevent Memory Leak.`);
                try { newClient.destroy(); } catch (e) {}
                
                if (err.message.includes("TOKEN_INVALID")) throw new Error("TOKEN_INVALID");
                throw err;
            }
        }

        // Advanced Rate-Limiter (Jitter Delay)
        // สุ่มดีเลย์ 1.5 - 3.5 วินาที เกลี่ยทราฟฟิกให้สมูท ไม่ให้บอทยิง Request เข้าห้องพร้อมกันเป็นแพ
        const jitterDelay = Math.floor(1500 + Math.random() * 2000);
        await new Promise(r => setTimeout(r, jitterDelay));

        const conn = connectToVoice(session.client, session.serverId, session.voiceId, tokenHash);
        session.connection = conn;
        console.log(`[WORKER] 🎧 Successfully connected to voice in Guild: ${session.serverId}`);
        return true;
    } finally {
        sessionManager.unlockSession(sessionId);
    }
}

function connectToVoice(client, guildId, channelId, tokenHash) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        console.error(`[WORKER] ❌ Guild Not Found: ${guildId}`);
        throw new Error("GUILD_NOT_FOUND");
    }
    
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoice()) {
        console.error(`[WORKER] ❌ Channel Not Found or Invalid: ${channelId} in Guild: ${guildId}`);
        throw new Error("CHANNEL_NOT_FOUND");
    }

    const existingConn = getVoiceConnection(guildId);
    if (existingConn) {
        if (existingConn.joinConfig.channelId === channelId && existingConn.state.status === VoiceConnectionStatus.Ready) {
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

    const sessionId = `${sessionManager.getSession(tokenHash)?.tokenTail || 'unknown'}_${guildId}`;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            console.log(`[WORKER] ⚠️ Connection dropped for ${sessionId}. Attempting to reconnect...`);
            await Promise.race([
                new Promise(resolve => connection.once(VoiceConnectionStatus.Signalling, resolve)),
                new Promise(resolve => connection.once(VoiceConnectionStatus.Connecting, resolve)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
            ]);
        } catch (error) {
            console.error(`[WORKER] ❌ Connection strictly failed for ${sessionId}. Destroying connection.`);
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
            
            // ค้นหา Session แบบกว้างๆ ในกรณีฉุกเฉิน
            let session = null;
            for (const [id, s] of sessionManager.getAllSessions()) {
                if (s.serverId === guildId && s.voiceId === channelId) {
                    session = s;
                    break;
                }
            }
            
            // Strict Null Pointer Catching ปกป้องระบบ DM ขั้นสุด
            if (!session || !session.ownerId || !mainClient) return; 

            try {
                const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
                if (owner) {
                    // [V4.9 FINAL]: UI/UX - คำนวณ Uptime และใช้ Custom Emojis ในการแจ้งเตือน
                    const uptimeMs = Date.now() - session.startedAt;
                    const hours = Math.floor(uptimeMs / 3600000);
                    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
                    const uptimeStr = hours > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${minutes} นาที`;

                    const dmMessage = `> ${config.emojis.alert} **ระบบแจ้งเตือนช่องเสียงขัดข้อง**\n` +
                                      `> ${config.emojis.warning} **ผู้ใช้งาน:** \`${session.ownerTag}\`\n` +
                                      `> ${config.emojis.robot} **เซิร์ฟเวอร์:** **${session.serverName}**\n` +
                                      `> 🎙️ **ห้องเสียง:** <#${session.voiceId}>\n` +
                                      `> ⏱️ **ระยะเวลาที่ออนล่าสุด:** ${uptimeStr}\n` +
                                      `> 🔄 *ระบบกำลังพยายามกู้คืนสัญญาณอัตโนมัติ กรุณารอสักครู่...*`;

                    owner.send(dmMessage).catch(()=>{});
                }
            } catch(e) {
                console.error(`[WORKER] ❌ Failed to dispatch disconnect DM for ${sessionId}: ${e.message}`);
            }
        }
    });

    return connection;
}

// ════════════════════════════════════════════════════════════════
//  🛑  TERMINATION & RESOURCE RECLAMATION
// ════════════════════════════════════════════════════════════════
async function stopSession(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.warn(`[WORKER] ⚠️ Attempted to stop non-existent session: ${sessionId}`);
        return false;
    }

    const tokenHash = getSessionTokenHash(sessionId, session);
    const clientRef = session.client || (tokenHash ? clientPool.get(tokenHash) : null);

    if (session.connection) {
        try { 
            session.connection.destroy(); 
        } catch(e) {
            console.error(`[WORKER] ⚠️ Error destroying connection for ${sessionId}: ${e.message}`);
        }
    }

    await sessionManager.deleteSession(sessionId);
    console.log(`[WORKER] 🛑 Stopped session securely: ${sessionId}`);

    // Memory Leak Eradicator (คืนแรมให้เซิร์ฟเวอร์ 100%)
    if (tokenHash && clientRef) {
        const allSessions = Array.from(sessionManager.getAllSessions().values());
        // ตรวจสอบว่ายังมีเซสชันอื่นที่ใช้ Token Hash เดียวกันนี้ค้างอยู่หรือไม่
        const inUse = allSessions.some(s => getSessionTokenHash(s.sessionId, s) === tokenHash);
        
        if (!inUse) {
            console.log(`[CLEANUP] 🗑️ No active sessions left for this Token Hash. Executing Client Self-Destruct.`);
            try { 
                clientRef.destroy(); 
            } catch(e) {
                console.error(`[CLEANUP] ⚠️ Failed to destroy client object for hash: ${e.message}`);
            }
            clientPool.delete(tokenHash);
            console.log(`[CLEANUP] ✅ Client removed from pool. RAM reclaimed.`);
        }
    }

    return true;
}

async function stopAll() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🛑 Initiating Global Stop for ${sessions.size} active sessions...`);
    for (const [id] of sessions) {
        await stopSession(id);
    }
    clientPool.clear();
    console.log(`[WORKER] ✅ Global Stop Complete. Client Pool flushed.`);
}

async function pauseAll() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] ⏸️ Initiating Global Pause for ${sessions.size} active sessions...`);
    for (const [id] of sessions) {
        await sessionManager.pauseSession(id);
    }
}

// ════════════════════════════════════════════════════════════════
//  🔄  RECOVERY & MAINTENANCE PROTOCOLS
// ════════════════════════════════════════════════════════════════
async function autoResume() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🔄 Auto-resuming ${sessions.size} dormant sessions...`);
    let count = 0;
    for (const [id, session] of sessions) {
        try {
            const token = sessionManager.getToken(id);
            if (token) {
                await startSession(id, token);
                count++;
                // เกลี่ยโหลดกันสแปมตอนบอทรีบูต (Warm-up Jitter Delay)
                const warmUpJitter = Math.floor(2000 + Math.random() * 1500);
                await new Promise(r => setTimeout(r, warmUpJitter));
            }
        } catch (err) {
            console.error(`[WORKER] ❌ Failed to auto-resume ${id}:`, err.message);
        }
    }
    console.log(`[WORKER] ✅ Successfully recovered ${count}/${sessions.size} sessions.`);
}

async function healthCheck() {
    const sessions = sessionManager.getAllSessions();
    for (const [sessionId, session] of sessions) {
        const tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) continue;

        const poolData = clientPool.get(tokenHash);
        if (!poolData) continue;

        const connStatus = session.connection?.state?.status;
        const needsRecovery = !session.connection || connStatus === VoiceConnectionStatus.Destroyed || connStatus === VoiceConnectionStatus.Disconnected;

        if (needsRecovery && !session.reconnecting && !sessionManager.isSessionLocked(sessionId)) {
            if (!sessionManager.lockSession(sessionId)) continue;
            session.reconnecting = true;
            console.log(`[HEARTBEAT] 🩺 Recovering dead voice connection for ${sessionId}...`);
            try {
                // Jitter Delay ใน Health Check 
                const recoveryJitter = Math.floor(1000 + Math.random() * 2000);
                await new Promise(res => setTimeout(res, recoveryJitter));
                
                const conn = connectToVoice(session.client, session.serverId, session.voiceId, tokenHash);
                if (conn) session.connection = conn;
                console.log(`[HEARTBEAT] 💖 Successfully restored connection for ${sessionId}.`);
            } catch(e) {
                console.error(`[HEARTBEAT] 💔 Recovery failed for ${sessionId}: ${e.message}`);
            } finally {
                session.reconnecting = false;
                sessionManager.unlockSession(sessionId);
            }
        }
    }
}

async function cleanupIdleSessions() {
    const now = Date.now();
    const maxIdle = config.limits.idleTimeoutMs;
    const sessions = sessionManager.getAllSessions();
    for (const [id, session] of sessions) {
        const lastSeen = session.lastActivity ?? session.startedAt;
        if (now - lastSeen > maxIdle) {
            console.log(`[CLEANUP] 🧹 Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — initiating automated shutdown.`);
            await stopSession(id);
        }
    }
}

module.exports = { 
    setMainClient, startSession, stopSession, stopAll, pauseAll, 
    autoResume, cleanupIdleSessions, getClientPoolSize, healthCheck 
};

