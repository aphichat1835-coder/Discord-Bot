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
        try { resolve(await fn()); } catch (err) { reject(err); } finally { this.running--; this.process(); }
    }
}
const stopQueue = new OperationQueue(3);

function connectToVoice(selfBot, serverId, voiceId, tokenTail) {
    try {
        const guild = selfBot.guilds.cache.get(serverId);
        if (!guild || !guild.voiceAdapterCreator) return null;
        const channel = guild.channels.cache.get(voiceId);

        if (!channel) {
            console.error(`❌ [DEBUG][${tokenTail}] ไม่พบช่อง (channelId: ${voiceId})`);
            return null;
        }

        // Accept both normal voice and stage voice channel types (discord.js v13 uses strings)
        const isVoiceChannel = channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE';
        if (!isVoiceChannel) {
            console.error(`❌ [DEBUG][${tokenTail}] ห้องนี้ไม่ใช่ช่องเสียง (Type: ${channel.type})`);
            return null;
        }

        const existingConn = getVoiceConnection(guild.id);
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
            if (conn.state.status !== VoiceConnectionStatus.Ready) conn.destroy();
        }, CONFIG.CONNECTION_TIMEOUT);

        conn.once(VoiceConnectionStatus.Ready, () => clearTimeout(connTimer));
        return conn;
    } catch { return null; }
}

async function cleanupClient(token) {
    const poolData = clientPool.get(token);
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

    clientPool.delete(token);
}

async function getOrCreateClient(token) {
    if (clientPool.has(token)) {
        const existing = clientPool.get(token);
        if (existing.client.user && existing.client.ws.status === 0) {
            return existing.client;
        } else {
            console.warn(`[POOL] Stale client for token ...${token.slice(-4)}, recreating`);
            await cleanupClient(token);
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
                console.error(`[LOGIN] Timeout for token ...${token.slice(-4)}`);
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
        activeSessions: new Set(),
        listeners: []
    };

    clientPool.set(token, poolData);

    const errorHandler = () => handleClientFailure(token);
    const invalidatedHandler = () => handleClientFailure(token);
    const voiceStateHandler = (oldState, newState) => {
        if (!selfBot.user || oldState.id !== selfBot.user.id) return;
        if (oldState.channelId && !newState.channelId) {
            const guildId = oldState.guild.id;
            const pData = clientPool.get(token);
            if (!pData) return;

            let targetSessionId = null;
            for (const sId of pData.activeSessions) {
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
                sessionManager.sendAlert(
                    'Session Failed',
                    `Session ` + "`****${sess.tokenTail}`" + ` exceeded max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) and was terminated.\n\nServer: ${sess.serverName}`
                );
                stopSession(targetSessionId);
                sessionManager.unlockSession(targetSessionId);
                return;
            }

            const jitter = Math.random() * 1000;
            const backoffDelay = Math.min(2000 * (2 ** (attempts - 1)) + jitter, 30000);

            sess.reconnectTimer = setTimeout(() => {
                try {
                    const currentSess = sessionManager.getSession(targetSessionId);
                    if (currentSess && selfBot.user) {
                        const tokenStr = sessionManager.getToken(currentSess);
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

function handleClientFailure(token) {
    const poolData = clientPool.get(token);
    if (!poolData) return;

    for (const sessionId of poolData.activeSessions) {
        sessionManager.systemMetrics.increment('sessionsFailed');
        sessionManager.deleteSession(sessionId);
    }

    cleanupClient(token);
}

function releaseClient(token, sessionId) {
    const poolData = clientPool.get(token);
    if (!poolData) return;

    poolData.activeSessions.delete(sessionId);
    if (poolData.activeSessions.size === 0) {
        cleanupClient(token);
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

        const sessionData = {
            sessionId, tokenTail, serverId, voiceId,
            serverName: selfBot.guilds.cache.get(serverId)?.name || serverId,
            connection: null, reconnecting: false, reconnectTimer: null,
            startedAt: Date.now(),
        };

        sessionManager.createSession(sessionId, sessionData, token);

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

    const token = sessionManager.getToken(session);
    sessionManager.deleteSession(sessionId);
    if (token) releaseClient(token, sessionId);
}

async function stopAll() {
    const sessionIds = [...sessionManager.getAllSessions().keys()];
    await Promise.allSettled(sessionIds.map(id => stopQueue.add(() => stopSession(id))));
}

async function autoResume() {
    const savedData = await sessionManager.loadDatabase();
    if (!savedData || savedData.length === 0) return;

    console.log(`[RESUME] Attempting to restore ${savedData.length} sessions...`);
    let restored = 0;

    const BATCH_SIZE = 3;
    const DELAY_BETWEEN_BATCHES = 2000;

    for (let i = 0; i < savedData.length; i += BATCH_SIZE) {
        const batch = savedData.slice(i, i + BATCH_SIZE);

        await Promise.allSettled(
            batch.map(async (data) => {
                try {
                    const token = sessionManager.decryptToken(data.token);
                    await startSession(token, data.serverId, data.voiceId, true);
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
        const token = sessionManager.getToken(session);
        if (!token) continue;

        const poolData = clientPool.get(token);
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

module.exports = { startSession, stopSession, stopAll, healthCheck, autoResume, cleanupIdleSessions, getClientPoolSize };
