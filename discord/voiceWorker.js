const { Client: SelfClient } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, VoiceConnectionStatus, getVoiceConnection } = require("@discordjs/voice");
const sessionManager = require("./sessionManager");
const config = require("./config.json");

const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: 7,
    LOGIN_TIMEOUT: 35000,
    CONNECTION_TIMEOUT: 15000,
};

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
    if (!tokenRegex.test(token)) throw new Error("INVALID_TOKEN_FORMAT");
    return true;
}

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

async function startSession(sessionId, tokenString) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    
    validateToken(tokenString);

    if (!sessionManager.lockSession(sessionId)) throw new Error("SESSION_LOCKED");

    try {
        // [GOD-TIER FIX]: เก็บและเรียก Client ด้วย tokenTail ป้องกัน HealthCheck พัง
        if (clientPool.has(session.tokenTail)) {
            session.client = clientPool.get(session.tokenTail);
        } else {
            const newClient = new SelfClient({ checkUpdate: false });
            
            await loginQueue.add(async () => {
                try {
                    const loginPromise = newClient.login(tokenString);
                    const timeoutPromise = new Promise((_, r) => setTimeout(() => r(new Error("LOGIN_TIMEOUT")), CONFIG.LOGIN_TIMEOUT));
                    await Promise.race([loginPromise, timeoutPromise]);
                } catch (err) {
                    if (err.message.includes("TOKEN_INVALID")) throw new Error("TOKEN_INVALID");
                    throw err;
                }
            });

            newClient.on("ready", () => {
                console.log(`[WORKER] User connected: ${newClient.user.tag}`);
                newClient.user.setStatus('idle'); 
            });

            clientPool.set(session.tokenTail, newClient);
            session.client = newClient;
        }

        // ป้องกัน Rate Limit จาก Discord กรณีล็อกอินและมุดเข้าห้องรัวๆ
        await new Promise(r => setTimeout(r, 1500));
        const conn = connectToVoice(session.client, session.serverId, session.voiceId, session.tokenTail);
        session.connection = conn;
        return true;
    } finally {
        sessionManager.unlockSession(sessionId);
    }
}

function connectToVoice(client, guildId, channelId, tokenTail) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("GUILD_NOT_FOUND");
    
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoice()) throw new Error("CHANNEL_NOT_FOUND");

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

    const sessionId = `${tokenTail}_${guildId}`;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                new Promise(resolve => connection.once(VoiceConnectionStatus.Signalling, resolve)),
                new Promise(resolve => connection.once(VoiceConnectionStatus.Connecting, resolve)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
            ]);
        } catch (error) {
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
            
            const session = sessionManager.getSession(sessionId);
            // Strict Null Checks ก่อนดึงข้อมูลเพื่อป้องกัน Unhandled Promise Rejection
            if (!session || !session.ownerId || !mainClient) return; 

            try {
                const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
                if (owner) {
                    owner.send(`> ⚠️ **ผู้ใช้งานหลุดจากการเชื่อมต่อ**\n> ${config.emojis.warning} เซสชันในเซิร์ฟเวอร์ **${session.serverName}** (ห้อง <#${session.voiceId}>) ขัดข้องและหลุดออก กรุณาตรวจสอบ`).catch(()=>{});
                }
            } catch(e) {}
        }
    });

    return connection;
}

async function stopSession(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return false;

    const token = sessionManager.getToken(sessionId);
    const clientRef = session.client;
    const tokenTailRef = session.tokenTail;

    if (session.connection) {
        try { session.connection.destroy(); } catch {}
    }

    await sessionManager.deleteSession(sessionId);
    console.log(`[WORKER] Stopped session: ${sessionId}`);

    // [GOD-TIER FIX]: ป้องกัน Memory Leak คืนค่า RAM เมื่อไม่มีการใช้ Token นั้นในระบบแล้ว
    if (token && clientRef) {
        const allSessions = Array.from(sessionManager.getAllSessions().values());
        const inUse = allSessions.some(s => s.tokenTail === tokenTailRef);
        
        if (!inUse) {
            console.log(`[CLEANUP] Destroying unused client for token tail: ${tokenTailRef}`);
            try { clientRef.destroy(); } catch {}
            clientPool.delete(tokenTailRef);
        }
    }

    return true;
}

async function stopAll() {
    const sessions = sessionManager.getAllSessions();
    for (const [id] of sessions) {
        await stopSession(id);
    }
    clientPool.clear();
}

async function pauseAll() {
    const sessions = sessionManager.getAllSessions();
    for (const [id] of sessions) {
        await sessionManager.pauseSession(id);
    }
}

async function autoResume() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] Auto-resuming ${sessions.size} sessions...`);
    let count = 0;
    for (const [id, session] of sessions) {
        try {
            const token = sessionManager.getToken(id);
            if (token) {
                await startSession(id, token);
                count++;
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (err) {
            console.error(`[WORKER] Failed to resume ${id}:`, err.message);
        }
    }
    console.log(`[WORKER] Successfully resumed ${count} sessions.`);
}

async function healthCheck() {
    const sessions = sessionManager.getAllSessions();
    for (const [sessionId, session] of sessions) {
        const poolData = clientPool.get(session.tokenTail);
        if (!poolData) continue;

        const connStatus = session.connection?.state?.status;
        const needsRecovery = !session.connection || connStatus === VoiceConnectionStatus.Destroyed || connStatus === VoiceConnectionStatus.Disconnected;

        if (needsRecovery && !session.reconnecting && !sessionManager.isSessionLocked(sessionId)) {
            if (!sessionManager.lockSession(sessionId)) continue;
            session.reconnecting = true;
            try {
                await new Promise(res => setTimeout(res, 1000));
                const conn = connectToVoice(session.client, session.serverId, session.voiceId, session.tokenTail);
                if (conn) session.connection = conn;
            } catch(e) {
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
            console.log(`[CLEANUP] Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — stopping`);
            await stopSession(id);
        }
    }
}

module.exports = { setMainClient, startSession, stopSession, stopAll, pauseAll, autoResume, cleanupIdleSessions, getClientPoolSize, healthCheck };
