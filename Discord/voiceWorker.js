// ════════════════════════════════════════════════════════════════════════════
//  🎧  VOICE WORKER  —  ENTERPRISE EDITION
// ════════════════════════════════════════════════════════════════════════════
//  ระบบจัดการ Voice Connection แบบ Enterprise-Grade พร้อม Auto-Recovery
// ════════════════════════════════════════════════════════════════════════════

const { Client: SelfClient } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, VoiceConnectionStatus, getVoiceConnection } = require("@discordjs/voice");

const {
    createSession,
    getSession,
    deleteSession,
    getAllSessions,
    addReconnect,
    clearReconnect,
    lockSession,
    unlockSession,
    isSessionLocked,
    systemMetrics
} = require("./sessionManager");

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: 5,
    RECONNECT_WINDOW: 60_000,
    RECONNECT_DELAY: 3000,
    LOGIN_TIMEOUT: 35_000,
    CONNECTION_TIMEOUT: 15_000,
    VOICE_REJOIN_DELAY: 2000,
};

// ════════════════════════════════════════════════════════════════════════════
//  🛡️  TOKEN VALIDATION
// ════════════════════════════════════════════════════════════════════════════
function validateToken(token) {
    // ตรวจสอบ format พื้นฐานของ Discord Token
    const tokenRegex = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
    if (!tokenRegex.test(token)) {
        throw new Error("INVALID_TOKEN_FORMAT");
    }
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  🚦  GRACEFUL QUEUE (สำหรับทยอยปิดเซสชัน)
// ════════════════════════════════════════════════════════════════════════════
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

        try {
            const result = await fn();
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            this.running--;
            this.process();
        }
    }
}
const stopQueue = new OperationQueue(3);

// ════════════════════════════════════════════════════════════════════════════
//  🔊  VOICE CONNECTION MANAGER
// ════════════════════════════════════════════════════════════════════════════

/**
 * เชื่อมต่อกับ Voice Channel
 * @param {Object} selfBot - Discord client instance
 * @param {string} serverId - Server ID
 * @param {string} voiceId - Voice Channel ID
 * @param {string} tokenTail - 4 หลักท้ายของ Token (สำหรับ logging)
 * @returns {Object|null} Voice connection หรือ null ถ้าล้มเหลว
 */
function connectToVoice(selfBot, serverId, voiceId, tokenTail) {
    try {
        if (!selfBot || !selfBot.user) {
            console.error(`❌ [VOICE][${tokenTail}] Client instance is invalid`);
            return null;
        }

        const guild = selfBot.guilds.cache.get(serverId);
        if (!guild) {
            console.error(`❌ [VOICE][${tokenTail}] Guild not found: ${serverId}`);
            return null;
        }

        if (!guild.voiceAdapterCreator) {
            console.error(`❌ [VOICE][${tokenTail}] Guild not ready (voiceAdapterCreator undefined)`);
            return null;
        }

        const channel = guild.channels.cache.get(voiceId);
        if (!channel) {
            console.error(`❌ [VOICE][${tokenTail}] Channel not found: ${voiceId}`);
            return null;
        }

        if (channel.type !== 2) {
            console.error(`❌ [VOICE][${tokenTail}] Channel is not a voice channel (type=${channel.type})`);
            return null;
        }

        // ทำลาย connection เก่าถ้ามี
        const existingConn = getVoiceConnection(guild.id);
        if (existingConn) {
            try {
                existingConn.destroy();
            } catch (err) {
                console.warn(`⚠️  [VOICE][${tokenTail}] Failed to destroy existing connection: ${err.message}`);
            }
        }

        const conn = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfMute: true,
            selfDeaf: true,
        });

        // Connection timeout handler
        const connTimer = setTimeout(() => {
            try {
                if (conn.state.status !== VoiceConnectionStatus.Ready) {
                    console.warn(`⚠️  [VOICE][${tokenTail}] Connection timeout (15s) — destroying`);
                    conn.destroy();
                }
            } catch (err) {
                console.error(`❌ [VOICE][${tokenTail}] Connection timeout handler error: ${err.message}`);
            }
        }, CONFIG.CONNECTION_TIMEOUT);

        conn.once(VoiceConnectionStatus.Ready, () => {
            clearTimeout(connTimer);
            console.log(`✅ [VOICE][${tokenTail}] Connected to #${channel.name}`);
        });

        conn.on("stateChange", (oldState, newState) => {
            console.log(
                `🔄[VOICE][${tokenTail}] State: ${oldState.status} → ${newState.status}`
            );
        });

        return conn;
    } catch (err) {
        console.error(`❌[VOICE][${tokenTail}] Connection error: ${err.message}`);
        return null;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔧  EVENT HANDLERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * ตั้งค่า Event Handlers สำหรับ Self Bot
 */
function setupEvents(selfBot, token, serverId, voiceId, onReady) {
    const tokenTail = token.slice(-4);
    const sessionId = `${token.slice(-8)}_${serverId}`;

    let readyCallbackFired = false;

    function fireReady(err) {
        if (readyCallbackFired) return;
        readyCallbackFired = true;
        if (onReady) onReady(err);
    }

    // ────────────────────────────────────────────────────────────────────────
    //  READY EVENT (Initial)
    // ────────────────────────────────────────────────────────────────────────
    selfBot.once("ready", () => {
        try {
            console.log(`✅ [BOT][${tokenTail}] Authenticated successfully`);

            const session = getSession(sessionId);
            if (!session) {
                return fireReady(new Error("SESSION_NOT_FOUND"));
            }

            const guild = selfBot.guilds.cache.get(serverId);
            session.serverName = guild?.name || serverId;

            // Cleanup old connection
            if (session.connection) {
                try {
                    session.connection.destroy();
                } catch (err) {
                    console.warn(`⚠️  [BOT][${tokenTail}] Old connection cleanup error: ${err.message}`);
                }
                session.connection = null;
            }

            // Establish voice connection
            const conn = connectToVoice(selfBot, serverId, voiceId, tokenTail);
            if (conn) {
                session.connection = conn;
                session.reconnecting = false;
                clearReconnect(sessionId);
            }

            systemMetrics.increment('sessionsStarted');
            fireReady(null);
        } catch (err) {
            console.error(`❌ [BOT][${tokenTail}] Ready handler error: ${err.message}`);
            fireReady(err);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    //  READY EVENT (Reconnect)
    // ────────────────────────────────────────────────────────────────────────
    selfBot.on("ready", () => {
        try {
            if (!readyCallbackFired) return;

            const session = getSession(sessionId);
            if (!session) return;

            console.log(`🔄 [BOT][${tokenTail}] Gateway reconnected`);

            const guild = selfBot.guilds.cache.get(serverId);
            session.serverName = guild?.name || serverId;

            if (session.connection) {
                try {
                    session.connection.destroy();
                } catch {}
                session.connection = null;
            }

            const conn = connectToVoice(selfBot, serverId, voiceId, tokenTail);
            if (conn) {
                session.connection = conn;
                session.reconnecting = false;
                clearReconnect(sessionId);
            }
        } catch (err) {
            console.error(`❌[BOT][${tokenTail}] Reconnect handler error: ${err.message}`);
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    //  ERROR EVENT
    // ────────────────────────────────────────────────────────────────────────
    selfBot.on("error", (err) => {
        console.error(`❌ [BOT][${tokenTail}] Client error: ${err.message}`);
        systemMetrics.increment('sessionsFailed');
        fireReady(new Error("LOGIN_FAIL"));

        const session = getSession(sessionId);
        if (session?.connection) {
            try {
                session.connection.destroy();
            } catch {}
        }

        try {
            selfBot.removeAllListeners();
            selfBot.destroy();
        } catch {}

        deleteSession(sessionId);
    });

    // ────────────────────────────────────────────────────────────────────────
    //  INVALIDATED EVENT
    // ────────────────────────────────────────────────────────────────────────
    selfBot.on("invalidated", () => {
        console.warn(`⚠️  [BOT][${tokenTail}] Token invalidated or banned`);
        systemMetrics.increment('sessionsFailed');
        fireReady(new Error("LOGIN_FAIL"));

        const session = getSession(sessionId);
        if (session?.connection) {
            try {
                session.connection.destroy();
            } catch {}
        }

        try {
            selfBot.removeAllListeners();
            selfBot.destroy();
        } catch {}

        deleteSession(sessionId);
    });

    // ────────────────────────────────────────────────────────────────────────
    //  GUILD UNAVAILABLE EVENT
    // ────────────────────────────────────────────────────────────────────────
    selfBot.on("guildUnavailable", (guild) => {
        if (guild.id !== serverId) return;
        console.warn(`⚠️  [BOT][${tokenTail}] Guild temporarily unavailable`);

        const session = getSession(sessionId);
        if (session?.connection) {
            try {
                session.connection.destroy();
            } catch {}
            session.connection = null;
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    //  GUILD CREATE EVENT
    // ────────────────────────────────────────────────────────────────────────
    selfBot.on("guildCreate", (guild) => {
        if (guild.id !== serverId) return;

        const session = getSession(sessionId);
        if (!session || session.connection) return;

        console.log(`🔄 [BOT][${tokenTail}] Guild restored — reconnecting voice`);

        setTimeout(() => {
            const conn = connectToVoice(selfBot, serverId, voiceId, tokenTail);
            if (conn && session) {
                session.connection = conn;
                session.reconnecting = false;
            }
        }, CONFIG.VOICE_REJOIN_DELAY);
    });

    // ────────────────────────────────────────────────────────────────────────
    //  VOICE STATE UPDATE EVENT
    // ────────────────────────────────────────────────────────────────────────
    selfBot.on("voiceStateUpdate", (oldState, newState) => {
        try {
            if (!selfBot.user || oldState.id !== selfBot.user.id) return;

            // Kicked from voice channel
            if (oldState.channelId && !newState.channelId) {
                const session = getSession(sessionId);
                if (!session || session.reconnecting || isSessionLocked(sessionId)) return;

                if (!lockSession(sessionId)) {
                    console.warn(`⚠️  [VOICE][${tokenTail}] Reconnect already in progress`);
                    return;
                }

                session.reconnecting = true;
                console.warn(`⚠️  [VOICE][${tokenTail}] Disconnected from voice channel`);

                const reconnectCount = addReconnect(sessionId);

                // Max reconnect attempts exceeded
                if (reconnectCount >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
                    console.error(
                        `❌ [VOICE][${tokenTail}] Max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) exceeded — terminating session`
                    );

                    if (session.connection) {
                        try {
                            session.connection.destroy();
                        } catch {}
                    }

                    try {
                        selfBot.removeAllListeners();
                        selfBot.destroy();
                    } catch {}

                    deleteSession(sessionId);
                    unlockSession(sessionId);
                    return;
                }

                // Schedule reconnect
                session.reconnectTimer = setTimeout(() => {
                    try {
                        const sess = getSession(sessionId);
                        if (!sess) {
                            unlockSession(sessionId);
                            return;
                        }

                        if (!selfBot.user) {
                            deleteSession(sessionId);
                            unlockSession(sessionId);
                            return;
                        }

                        console.log(`🔄 [VOICE][${tokenTail}] Attempting reconnect (${reconnectCount}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`);

                        const conn = connectToVoice(selfBot, serverId, voiceId, tokenTail);
                        if (conn && sess) {
                            sess.connection = conn;
                        }
                    } catch (err) {
                        console.error(`❌ [VOICE][${tokenTail}] Reconnect error: ${err.message}`);
                    } finally {
                        const sess = getSession(sessionId);
                        if (sess) {
                            sess.reconnecting = false;
                            sess.reconnectTimer = null;
                        }
                        unlockSession(sessionId);
                    }
                }, CONFIG.RECONNECT_DELAY);
            }
        } catch (err) {
            console.error(`❌[VOICE][${tokenTail}] Voice state update error: ${err.message}`);
            const session = getSession(sessionId);
            if (session) {
                session.reconnecting = false;
            }
            unlockSession(sessionId);
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  🚀  SESSION MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * เริ่มต้นเซสชันใหม่
 */
async function startSession(token, serverId, voiceId) {
    // ตรวจสอบ Token ก่อนทำงาน
    try {
        validateToken(token);
    } catch (err) {
        systemMetrics.increment('sessionsFailed');
        throw err;
    }

    const sessionId = `${token.slice(-8)}_${serverId}`;
    const tokenTail = token.slice(-4);

    if (getSession(sessionId)) {
        throw new Error("SESSION_EXISTS");
    }

    const selfBot = new SelfClient({ checkUpdate: false });
    selfBot.setMaxListeners(25);

    return new Promise((resolve, reject) => {
        const loginTimer = setTimeout(() => {
            console.error(`❌[SESSION][${tokenTail}] Login timeout (${CONFIG.LOGIN_TIMEOUT}ms)`);
            systemMetrics.increment('sessionsFailed');

            const session = getSession(sessionId);
            if (session?.connection) {
                try {
                    session.connection.destroy();
                } catch {}
            }

            try {
                selfBot.removeAllListeners();
                selfBot.destroy();
            } catch {}

            deleteSession(sessionId);
            reject(new Error("LOGIN_TIMEOUT"));
        }, CONFIG.LOGIN_TIMEOUT);

        createSession(sessionId, {
            sessionId,
            bot: selfBot,
            tokenTail,
            serverId,
            voiceId,
            serverName: "กำลังโหลดข้อมูล...",
            connection: null,
            reconnecting: false,
            reconnectTimer: null,
            startedAt: Date.now(),
        });

        setupEvents(selfBot, token, serverId, voiceId, (err) => {
            clearTimeout(loginTimer);

            if (err) {
                deleteSession(sessionId);
                reject(err);
            } else {
                console.log(`✅ [SESSION][${tokenTail}] Started successfully`);
                resolve(tokenTail);
            }
        });

        (async () => {
            try {
                await selfBot.login(token);
            } catch (err) {
                clearTimeout(loginTimer);
                console.error(`❌ [SESSION][${tokenTail}] Login failed: ${err.message}`);
                systemMetrics.increment('sessionsFailed');

                const session = getSession(sessionId);
                if (session?.connection) {
                    try {
                        session.connection.destroy();
                    } catch {}
                }

                try {
                    selfBot.removeAllListeners();
                    selfBot.destroy();
                } catch {}

                deleteSession(sessionId);
                reject(new Error("LOGIN_FAIL"));
            }
        })();
    });
}

/**
 * หยุดเซสชัน
 */
async function stopSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        console.warn(`⚠️  [SESSION] Stop attempt on non-existent session: ${sessionId}`);
        return;
    }

    console.log(`🛑 [SESSION][${session.tokenTail}] Stopping...`);

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }

    if (session.connection) {
        try {
            session.connection.destroy();
        } catch (err) {
            console.warn(`⚠️  [SESSION][${session.tokenTail}] Connection destroy error: ${err.message}`);
        }
        session.connection = null;
    }

    try {
        session.bot.removeAllListeners();
        await session.bot.destroy();
    } catch (err) {
        console.error(`❌ [SESSION][${session.tokenTail}] Bot destroy error: ${err.message}`);
    }

    deleteSession(sessionId);
    console.log(`✅ [SESSION][${session.tokenTail}] Stopped successfully`);
}

/**
 * หยุดเซสชันทั้งหมด (ใช้ Queue เพื่อป้องกันการโดนแบน IP)
 */
async function stopAll() {
    const sessionIds = [...getAllSessions().keys()];
    console.log(`🛑 [SESSION] Stopping all sessions (${sessionIds.length}) gracefully...`);

    await Promise.all(
        sessionIds.map(id => stopQueue.add(() => stopSession(id)))
    );

    console.log("✅ [SESSION] All sessions stopped");
}

/**
 * ตรวจสอบสุขภาพของเซสชัน
 */
async function healthCheck() {
    const sessions = getAllSessions();
    let healthyCount = 0;
    let recoveredCount = 0;

    for (const [sessionId, session] of sessions) {
        try {
            if (!session.bot || !session.bot.user) {
                console.warn(`⚠️  [HEALTH][${session.tokenTail}] Bot instance invalid — removing session`);
                deleteSession(sessionId);
                continue;
            }

            const connStatus = session.connection?.state?.status;
            const needsRecovery =
                !session.connection ||
                connStatus === VoiceConnectionStatus.Destroyed ||
                connStatus === VoiceConnectionStatus.Disconnected;

            if (needsRecovery && !session.reconnecting && !isSessionLocked(sessionId)) {
                console.log(`💓 [HEALTH][${session.tokenTail}] Connection lost — attempting recovery`);

                if (!lockSession(sessionId)) continue;

                session.reconnecting = true;

                const conn = connectToVoice(session.bot, session.serverId, session.voiceId, session.tokenTail);

                if (conn) {
                    session.connection = conn;
                    session.reconnecting = false;
                    recoveredCount++;
                }

                unlockSession(sessionId);
            } else if (connStatus === VoiceConnectionStatus.Ready) {
                healthyCount++;
            }
        } catch (err) {
            console.error(`❌ [HEALTH][${session.tokenTail}] Check error: ${err.message}`);
        }
    }

    console.log(
        `💓 [HEALTH] Check complete — Healthy: ${healthyCount}, Recovered: ${recoveredCount}, Total: ${sessions.size}`
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  MODULE EXPORTS
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
    startSession,
    stopSession,
    stopAll,
    healthCheck,
};