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

function validateToken(token) {
    const tokenRegex = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
    if (!tokenRegex.test(token)) throw new Error("INVALID_TOKEN_FORMAT");
    return true;
}

class OperationQueue {
    constructor(concurrency = 3) {
        this.queue =[];
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
        try { resolve(await fn()); } catch (err) { reject(err); } finally { this.running--; this.process(); }
    }
}
const stopQueue = new OperationQueue(3);

function connectToVoice(selfBot, serverId, voiceId, tokenTail) {
    try {
        console.log(`\n🔍 [DEBUG][${tokenTail}] กำลังตรวจสอบข้อมูล...`);
        const guild = selfBot.guilds.cache.get(serverId);
        if (!guild) {
            console.error(`❌ [DEBUG][${tokenTail}] ไม่พบ Server ID: ${serverId} (บัญชีนี้อาจจะไม่ได้อยู่ในเซิร์ฟเวอร์)`);
            return null;
        }
        if (!guild.voiceAdapterCreator) return null;

        const channel = guild.channels.cache.get(voiceId);
        if (!channel) {
            console.error(`❌ [DEBUG][${tokenTail}] ไม่พบ Voice ID: ${voiceId} (บัญชีนี้อาจจะมองไม่เห็นห้องนี้)`);
            return null;
        }

        // FIX: รองรับ Discord.js v13
        if (!channel.isVoice()) {
            console.error(`❌ [DEBUG][${tokenTail}] ห้องนี้ไม่ใช่ช่องเสียง (Type: ${channel.type})`);
            return null;
        }

        console.log(`⏳ [DEBUG][${tokenTail}] กำลังพยายามเชื่อมต่อห้อง: ${channel.name}...`);

        const existingConn = getVoiceConnection(guild.id, selfBot.user.id);
        if (existingConn) try { existingConn.destroy(); } catch {}

        const conn = joinVoiceChannel({
            channelId: channel.id, 
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfMute: true, 
            selfDeaf: true,
            group: selfBot.user.id
        });

        conn.on("stateChange", (oldState, newState) => {
            console.log(`🔄 [VOICE-STATE][${tokenTail}] เปลี่ยนสถานะ: ${oldState.status} ➡️ ${newState.status}`);
        });

        conn.on("error", (error) => {
            console.error(`❌ [VOICE-ERROR][${tokenTail}] เกิดข้อผิดพลาด:`, error.message);
        });

        const connTimer = setTimeout(() => {
            if (conn.state.status !== VoiceConnectionStatus.Ready) {
                console.error(`⏰ [DEBUG][${tokenTail}] หมดเวลาเชื่อมต่อ (15 วิ)! สถานะสุดท้ายคือ: ${conn.state.status}`);
                conn.destroy();
            }
        }, CONFIG.CONNECTION_TIMEOUT);

        conn.once(VoiceConnectionStatus.Ready, () => {
            clearTimeout(connTimer);
            console.log(`✅ [DEBUG][${tokenTail}] เชื่อมต่อช่องเสียงสำเร็จ!`);
        });

        return conn;
    } catch (err) { 
        console.error(`❌ [DEBUG-CATCH][${tokenTail}] โค้ดพังระหว่างเชื่อมต่อ:`, err.message);
        return null; 
    }
}

async function getOrCreateClient(token) {
    if (clientPool.has(token)) {
        return clientPool.get(token).client;
    }

    const selfBot = new SelfClient({ checkUpdate: false });
    selfBot.setMaxListeners(50);

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { selfBot.destroy(); } catch (e) {}
            reject(new Error("LOGIN_TIMEOUT"));
        }, CONFIG.LOGIN_TIMEOUT);

        selfBot.once("ready", () => { clearTimeout(timer); resolve(); });
        selfBot.login(token).catch(err => {
            clearTimeout(timer);
            try { selfBot.destroy(); } catch (e) {}
            reject(new Error("LOGIN_FAIL"));
        });
    });

    clientPool.set(token, { client: selfBot, activeSessions: new Set() });

    selfBot.on("error", () => handleClientFailure(token));
    selfBot.on("invalidated", () => handleClientFailure(token));

    selfBot.on("voiceStateUpdate", (oldState, newState) => {
        if (!selfBot.user || oldState.id !== selfBot.user.id) return;
        if (oldState.channelId && !newState.channelId) {
            const guildId = oldState.guild.id;
            const poolData = clientPool.get(token);
            if (!poolData) return;

            let targetSessionId = null;
            for (const sId of poolData.activeSessions) {
                const sess = sessionManager.getSession(sId);
                if (sess && sess.serverId === guildId) {
                    targetSessionId = sId;
                    break;
                }
            }

            if (!targetSessionId) return;
            const sess = sessionManager.getSession(targetSessionId);
            if (!sess || sess.reconnecting || sessionManager.isSessionLocked(targetSessionId)) return;
            if (!sessionManager.lockSession(targetSessionId)) return;

            sess.reconnecting = true;
            const attempts = sessionManager.addReconnect(targetSessionId);

            if (attempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
                stopSession(targetSessionId);
                sessionManager.unlockSession(targetSessionId);
                return;
            }

            const backoffDelay = Math.min(2000 * (2 ** (attempts - 1)), 30000);

            sess.reconnectTimer = setTimeout(() => {
                try {
                    const currentSess = sessionManager.getSession(targetSessionId);
                    if (currentSess && selfBot.user) {
                        const newConn = connectToVoice(selfBot, currentSess.serverId, currentSess.voiceId, currentSess.tokenTail);
                        if (newConn) currentSess.connection = newConn;
                    }
                } finally {
                    const currentSess = sessionManager.getSession(targetSessionId);
                    if (currentSess) { currentSess.reconnecting = false; currentSess.reconnectTimer = null; }
                    sessionManager.unlockSession(targetSessionId);
                }
            }, backoffDelay);
        }
    });

    return selfBot;
}

function handleClientFailure(token) {
    const poolData = clientPool.get(token);
    if (!poolData) return;

    for (const sessionId of poolData.activeSessions) {
        sessionManager.systemMetrics.increment('sessionsFailed');
        sessionManager.deleteSession(sessionId);
    }

    try { poolData.client.removeAllListeners(); poolData.client.destroy(); } catch {}
    clientPool.delete(token);
}

function releaseClient(token, sessionId) {
    const poolData = clientPool.get(token);
    if (!poolData) return;

    poolData.activeSessions.delete(sessionId);
    if (poolData.activeSessions.size === 0) {
        try { poolData.client.removeAllListeners(); poolData.client.destroy(); } catch {}
        clientPool.delete(token);
    }
}

async function startSession(token, serverId, voiceId, isResume = false) {
    if (!isResume) validateToken(token);

    const sessionId = `${token.slice(-8)}_${serverId}`;
    const tokenTail = token.slice(-4);

    if (sessionManager.getSession(sessionId)) throw new Error("SESSION_EXISTS");

    try {
        const selfBot = await getOrCreateClient(token);
        const poolData = clientPool.get(token);
        poolData.activeSessions.add(sessionId);

        sessionManager.createSession(sessionId, {
            sessionId, token, tokenTail, serverId, voiceId,
            serverName: selfBot.guilds.cache.get(serverId)?.name || serverId,
            connection: null, reconnecting: false, reconnectTimer: null,
            startedAt: Date.now(),
        });

        const session = sessionManager.getSession(sessionId);
        const conn = connectToVoice(selfBot, serverId, voiceId, tokenTail);
        if (conn) session.connection = conn;

        if (!isResume) sessionManager.systemMetrics.increment('sessionsStarted');

        return tokenTail;
    } catch (err) {
        sessionManager.systemMetrics.increment('sessionsFailed');
        throw err;
    }
}

async function stopSession(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return;

    const token = session.token;
    sessionManager.deleteSession(sessionId);
    releaseClient(token, sessionId);
}

async function stopAll() {
    const sessionIds =[...sessionManager.getAllSessions().keys()];
    await Promise.all(sessionIds.map(id => stopQueue.add(() => stopSession(id))));
}

async function autoResume() {
    const savedData = await sessionManager.loadDatabase();
    if (!savedData || savedData.length === 0) return;

    console.log(`[RESUME] Attempting to restore ${savedData.length} sessions...`);
    let restored = 0;

    for (const data of savedData) {
        try {
            await startSession(data.token, data.serverId, data.voiceId, true);
            restored++;
        } catch (err) {
            console.error(`[RESUME] Failed for server ${data.serverId}: ${err.message}`);
        }
    }
    console.log(`[RESUME] Restored ${restored}/${savedData.length} sessions`);
}

async function healthCheck() {
    const sessions = sessionManager.getAllSessions();
    for (const [sessionId, session] of sessions) {
        const poolData = clientPool.get(session.token);
        if (!poolData || !poolData.client.user) { stopSession(sessionId); continue; }

        const connStatus = session.connection?.state?.status;
        const needsRecovery = !session.connection || connStatus === VoiceConnectionStatus.Destroyed || connStatus === VoiceConnectionStatus.Disconnected;

        if (needsRecovery && !session.reconnecting && !sessionManager.isSessionLocked(sessionId)) {
            if (!sessionManager.lockSession(sessionId)) continue;
            session.reconnecting = true;
            const conn = connectToVoice(poolData.client, session.serverId, session.voiceId, session.tokenTail);
            if (conn) session.connection = conn;
            session.reconnecting = false;
            sessionManager.unlockSession(sessionId);
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

module.exports = { startSession, stopSession, stopAll, healthCheck, autoResume, cleanupIdleSessions };