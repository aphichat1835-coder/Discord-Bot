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
const stopQueue = new OperationQueue(3);

function connectToVoice(selfBot, serverId, voiceId, tokenTail) {
    try {
        const guild = selfBot.guilds.cache.get(serverId);
        if (!guild || !guild.voiceAdapterCreator) {
            console.error(`❌ [DEBUG][${tokenTail}] ไม่พบ guild หรือไม่มี voiceAdapterCreator (serverId: ${serverId})`);
            return null;
        }
        const channel = guild.channels.cache.get(voiceId);

        if (!channel) {
            console.error(`❌ [DEBUG][${tokenTail}] ไม่พบช่อง (channelId: ${voiceId})`);
            return null;
        }

        const isVoiceChannel = channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE';
        if (!isVoiceChannel) {
            console.error(`❌ [DEBUG][${tokenTail}] ห้องนี้ไม่ใช่ช่องเสียง (Type: ${channel.type})`);
            return null;
        }

        try {
            const perms = channel.permissionsFor(selfBot.user);
            if (!perms) {
                console.error(`❌ [DEBUG][${tokenTail}] ไม่สามารถตรวจสอบสิทธิ์ของผู้ใช้ในช่อง`);
                return null;
            }
            const missing = [];
            if (!perms.has('VIEW_CHANNEL')) missing.push('VIEW_CHANNEL');
            if (!perms.has('CONNECT')) missing.push('CONNECT');
            if (missing.length > 0) {
                console.error(`❌ [DEBUG][${tokenTail}] ขาดสิทธิ์: ${missing.join(', ')}`);
                return null;
            }
        } catch (permErr) {
            console.warn(`⚠️ [DEBUG][${tokenTail}] ตรวจสอบสิทธิ์ล้มเหลว: ${permErr.message}`);
        }

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

        const connTimer = setTimeout(() => {
            try {
                if (conn.state && conn.state.status !== VoiceConnectionStatus.Ready) conn.destroy();
            } catch (e) { try { conn.destroy(); } catch {} }
        }, CONFIG.CONNECTION_TIMEOUT);

        conn.once(VoiceConnectionStatus.Ready, () => clearTimeout(connTimer));
        return conn;
    } catch (err) {
        console.error(`❌ [DEBUG][connectToVoice] Error: ${err?.message || err}`);
        return null;
    }
}

async function cleanupClient(sessionId) {
    const poolData = clientPool.get(sessionId);
    if (!poolData) return;

    try {
        if (poolData.listeners) {
            for (const { event, handler } of poolData.listeners) {
                poolData.client.removeListener(event, handler);
            }
        }
        poolData.client.removeAllListeners();
        await poolData.client.destroy();
    } catch (err) {
        console.error(`[CLEANUP] Error cleaning client: ${err.message}`);
    }

    clientPool.delete(sessionId);
}

async function getOrCreateClient(token, sessionId) {
    if (clientPool.has(sessionId)) {
        const existing = clientPool.get(sessionId);
        if (existing.client.user && existing.client.ws.status === 0) {
            return existing.client;
        } else {
            console.warn(`[POOL] Stale client for session ${sessionId}, recreating`);
            await cleanupClient(sessionId);
        }
    }

    const selfBot = new SelfClient({ checkUpdate: false });
    selfBot.setMaxListeners(50);

    let loginPromise = null;
    let isDestroyed = false;

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (!isDestroyed) {
                isDestroyed = true;
                console.error(`[LOGIN] Timeout for session ${sessionId}`);
                selfBot.destroy().catch(() => {});
                reject(new Error("LOGIN_TIMEOUT"));
            }
        }, CONFIG.LOGIN_TIMEOUT);

        selfBot.once("ready", () => { 
            if (!isDestroyed) {
                clearTimeout(timer); 
                resolve(); 
            }
        });

        loginPromise = selfBot.login(token);

        loginPromise.catch(err => {
            if (!isDestroyed) {
                isDestroyed = true;
                clearTimeout(timer);
                selfBot.destroy().catch(() => {});
                reject(new Error("LOGIN_FAIL"));
            }
        });
    });

    if (isDestroyed) {
        selfBot.destroy().catch(() => {});
        throw new Error("LOGIN_TIMEOUT");
    }

    const poolData = { 
        client: selfBot, 
        sessionId: sessionId,
        listeners: []
    };

    clientPool.set(sessionId, poolData);

    const errorHandler = () => handleClientFailure(sessionId);
    const invalidatedHandler = () => handleClientFailure(sessionId);
    const voiceStateHandler = (oldState, newState) => {
        if (!selfBot.user || oldState.id !== selfBot.user.id) return;
        if (oldState.channelId && !newState.channelId) {
            const sess = sessionManager.getSession(sessionId);
            if (!sess || sess.reconnecting || sessionManager.isSessionLocked(sessionId)) return;
            if (!sessionManager.lockSession(sessionId)) return;

            sess.reconnecting = true;
            const attempts = sessionManager.addReconnect(sessionId);

            if (attempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
                sessionManager.sendAlert(
                    'Session Failed',
                    `Session ****${sess.tokenTail} exceeded max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) and was terminated.\n\nServer: ${sess.serverName}`
                );
                stopSession(sessionId);
                sessionManager.unlockSession(sessionId);
                return;
            }

            const jitter = Math.random() * 1000;
            const backoffDelay = Math.min(2000 * (2 ** (attempts - 1)) + jitter, 30000);

            sess.reconnectTimer = setTimeout(() => {
                try {
                    const currentSess = sessionManager.getSession(sessionId);
                    if (currentSess && selfBot.user) {
                        const newConn = connectToVoice(selfBot, currentSess.serverId, currentSess.voiceId, currentSess.tokenTail);
                        if (newConn) currentSess.connection = newConn;
                    }
                } finally {
                    const currentSess = sessionManager.getSession(sessionId);
                    if (currentSess) { currentSess.reconnecting = false; currentSess.reconnectTimer = null; }
                    sessionManager.unlockSession(sessionId);
                }
            }, backoffDelay);
        }
    };

    selfBot.on("error", errorHandler);
    selfBot.on("invalidated", invalidatedHandler);
    selfBot.on("voiceStateUpdate", voiceStateHandler);

    poolData.listeners.push(
        { event: "error", handler: errorHandler },
        { event: "invalidated", handler: invalidatedHandler },
        { event: "voiceStateUpdate", handler: voiceStateHandler }
    );

    return selfBot;
}

function handleClientFailure(sessionId) {
    const poolData = clientPool.get(sessionId);
    if (!poolData) return;

    sessionManager.systemMetrics.increment('sessionsFailed');
    sessionManager.deleteSession(sessionId);
    cleanupClient(sessionId);
}

async function startSession(token, serverId, voiceId, isResume = false) {
    if (!isResume) validateToken(token);

    const sessionId = `${token.slice(-8)}_${serverId}`;
    const tokenTail = token.slice(-4);

    if (sessionManager.getSession(sessionId)) throw new Error("SESSION_EXISTS");

    try {
        const selfBot = await getOrCreateClient(token, sessionId);
        
        const sessionData = {
            sessionId, tokenTail, serverId, voiceId,
            serverName: selfBot.guilds.cache.get(serverId)?.name || serverId,
            connection: null, reconnecting: false, reconnectTimer: null,
            startedAt: Date.now(),
        };

        await sessionManager.createSession(sessionId, sessionData, token);

        const session = sessionManager.getSession(sessionId);
        const conn = connectToVoice(selfBot, serverId, voiceId, tokenTail);
        if (conn) {
            session.connection = conn;
        } else {
            await stopSession(sessionId);
            throw new Error("VOICE_NOT_FOUND");
        }

        if (!isResume) sessionManager.systemMetrics.increment('sessionsStarted');

        return tokenTail;
    } catch (err) {
        if (!isResume) sessionManager.systemMetrics.increment('sessionsFailed');
        throw err;
    }
}

async function stopSession(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return;

    await sessionManager.deleteSession(sessionId);
    await cleanupClient(sessionId);
}

async function stopAll() {
    const sessionIds = [...sessionManager.getAllSessions().keys()];
    await Promise.allSettled(sessionIds.map(id => stopQueue.add(() => stopSession(id))));
}

async function pauseAll() {
    const sessionIds = [...sessionManager.getAllSessions().keys()];
    await Promise.allSettled(sessionIds.map(async (id) => {
        await sessionManager.pauseSession(id);
        await cleanupClient(id);
    }));
}

async function autoResume() {
    const savedData = await sessionManager.loadDatabase();
    if (!savedData || savedData.length === 0) return;

    console.log(`[RESUME] Attempting to restore ${savedData.length} sessions from Cloud...`);
    let restored = 0;

    const BATCH_SIZE = 3;
    const DELAY_BETWEEN_BATCHES = 5000;

    for (let i = 0; i < savedData.length; i += BATCH_SIZE) {
        const batch = savedData.slice(i, i + BATCH_SIZE);

        await Promise.allSettled(
            batch.map(async (data) => {
                try {
                    await startSession(data.token, data.serverId, data.voiceId, true);
                    restored++;
                } catch (err) {
                    console.error(`[RESUME] Failed for server ${data.serverId}: ${err.message}`);
                }
            })
        );

        if (i + BATCH_SIZE < savedData.length) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
        }
    }

    console.log(`[RESUME] Restored ${restored}/${savedData.length} sessions`);
}

async function healthCheck() {
    const sessions = sessionManager.getAllSessions();
    for (const [sessionId, session] of sessions) {
        const poolData = clientPool.get(sessionId);
        if (!poolData || !poolData.client.user) { 
            continue; 
        }

        const connStatus = session.connection?.state?.status;
        const needsRecovery = !session.connection || connStatus === VoiceConnectionStatus.Destroyed || connStatus === VoiceConnectionStatus.Disconnected;

        if (needsRecovery && !session.reconnecting && !sessionManager.isSessionLocked(sessionId)) {
            if (!sessionManager.lockSession(sessionId)) continue;
            session.reconnecting = true;
            try {
                const conn = connectToVoice(poolData.client, session.serverId, session.voiceId, session.tokenTail);
                if (conn) session.connection = conn;
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

// นำ setTimeout(healthCheck) ออกไปแล้ว เพื่อให้ index.js เป็นคนควบคุมจังหวะ 100% ป้องกันพายุรีเควสต์

module.exports = { startSession, stopSession, stopAll, pauseAll, autoResume, cleanupIdleSessions, getClientPoolSize, healthCheck };

