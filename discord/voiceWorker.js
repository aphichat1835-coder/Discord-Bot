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
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
const crypto = require("crypto");
const sessionManager = require("./sessionManager");
const config = require("./config.json");

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 1: CONFIG
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
const tokenLoginCooldowns = new Map();
let mainClient = null;

// เฟส 18+8: Global shutdown flag — Voice Worker เช็คก่อน reconnect ทุกครั้ง
let isShuttingDown = false;

// ── Naturalness Engine state ──
const naturalTimers = new Map();
const naturalRunning = new Set();
let naturalSettings = {
    enabled: config.naturalness?.enabled ?? false,
    intervalMs: config.naturalness?.intervalMs ?? 3600000,
    durationMs: config.naturalness?.durationMs ?? 30000,
};

// ── Auto Deaf Engine state ──
const autoDeafTimers = new Map();
const autoDeafRunning = new Set();
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
function getClientPoolStrategyName() { return "tokenGuild"; }
function isVoiceDebugEnabled() { return process.env.VOICE_DEBUG_MULTI_CLIENT === "true"; }

function debugVoiceSession(event, sessionId, session, extra = {}) {
    if (!isVoiceDebugEnabled()) return;

    const allowedExtra = {};
    for (const key of ["hit", "strategy", "group", "selfVoice", "sameAccountSessions", "connectionStatus"]) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) {
            allowedExtra[key] = extra[key];
        }
    }

    const safe = {
        session: getSessionShortId(sessionId),
        accountId: session?.accountId || session?.client?.user?.id || null,
        guildId: session?.serverId || null,
        channelId: session?.voiceId || null,
        pool: getClientPoolStrategyName(),
        ...allowedExtra
    };

    console.log(`[VOICE-DEBUG] ${event} ${JSON.stringify(safe)}`);
}

function destroyAllPooledClients(reason = "cleanup") {
    for (const [, client] of clientPool.entries()) {
        try {
            client.destroy?.();
        } catch (e) {
            console.warn(`[WORKER] ⚠️ Failed to destroy pooled client during ${reason}: ${sanitizeLifecycleError(e.message)}`);
        }
    }

    for (const session of sessionManager.getAllSessions().values()) {
        if (session) session.client = null;
    }

    clientPool.clear();
    tokenLoginCooldowns.clear();
    console.log(`[WORKER] 🗑️ Client pool destroyed and cleared (${reason}).`);
}

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 3: TOKEN VALIDATION & SESSION MANAGER COMPAT
// ════════════════════════════════════════════════════════════════════════════
function validateToken(token) {
    if (typeof token !== "string" || token.length > 256) throw new Error("INVALID_TOKEN_FORMAT");
    const tokenRegex = /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/;
    if (!tokenRegex.test(token)) throw new Error("INVALID_TOKEN_FORMAT");
    return true;
}

function sanitizeLifecycleError(value) {
    return String(value || "UNKNOWN_ERROR")
        .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, "[REDACTED_TOKEN]")
        .slice(0, 300);
}

function isSessionRunnable(session) {
    if (typeof sessionManager.isSessionRunnable === "function") {
        return sessionManager.isSessionRunnable(session);
    }
    const state = session?.state || "active";
    return state === "active";
}

function shouldResumeSession(session) {
    if (typeof sessionManager.shouldResumeSession === "function") {
        return sessionManager.shouldResumeSession(session);
    }
    return (session?.state || "active") === "active";
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getSessionToken(sessionId) {
    if (typeof sessionManager.getSessionToken === "function") {
        return sessionManager.getSessionToken(sessionId);
    }
    if (typeof sessionManager.getToken === "function") {
        return sessionManager.getToken(sessionId);
    }
    return null;
}

function getSessionTokenHash(sessionId, session) {
    if (session?.tokenHash) return session.tokenHash;

    if (typeof sessionManager.getSessionTokenHash === "function") {
        const tokenHash = sessionManager.getSessionTokenHash(sessionId, session);
        if (tokenHash) {
            if (session) session.tokenHash = tokenHash;
            return tokenHash;
        }
    }

    const token = getSessionToken(sessionId);
    if (token) {
        const tokenHash = sha256(token);
        if (session) session.tokenHash = tokenHash;
        return tokenHash;
    }

    return null;
}

function lockSession(sessionId) {
    if (typeof sessionManager.lockSession === "function") {
        return sessionManager.lockSession(sessionId);
    }
    if (typeof sessionManager.acquireSessionLock === "function") {
        return sessionManager.acquireSessionLock(sessionId);
    }
    return true;
}

function unlockSession(sessionId) {
    if (typeof sessionManager.unlockSession === "function") {
        return sessionManager.unlockSession(sessionId);
    }
    if (typeof sessionManager.releaseSessionLock === "function") {
        return sessionManager.releaseSessionLock(sessionId);
    }
    return true;
}

function isSessionLocked(sessionId) {
    if (typeof sessionManager.isSessionLocked === "function") {
        return sessionManager.isSessionLocked(sessionId);
    }
    return false;
}

function addReconnect(sessionId) {
    if (typeof sessionManager.addReconnect === "function") {
        return sessionManager.addReconnect(sessionId);
    }
    if (typeof sessionManager.recordReconnectAttempt === "function") {
        return sessionManager.recordReconnectAttempt(sessionId);
    }
    return null;
}

function clearReconnect(sessionId) {
    if (typeof sessionManager.clearReconnect === "function") {
        return sessionManager.clearReconnect(sessionId);
    }
    if (typeof sessionManager.resetReconnectInfo === "function") {
        return sessionManager.resetReconnectInfo(sessionId);
    }
    return null;
}

async function updateSessionMetadata(sessionId, metadata = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return false;

    for (const [key, value] of Object.entries(metadata)) {
        session[key] = value ?? null;
    }
    session.lastActivity = Date.now();

    if (typeof sessionManager.updateSessionMetadata === "function") {
        return sessionManager.updateSessionMetadata(sessionId, metadata);
    }

    return true;
}

function countActiveSessionsByTokenHash(tokenHash) {
    if (typeof sessionManager.countActiveSessionsByTokenHash === "function") {
        return sessionManager.countActiveSessionsByTokenHash(tokenHash);
    }

    let count = 0;
    const sessions = sessionManager.getAllSessions();
    for (const [id, session] of sessions) {
        if (getSessionTokenHash(id, session) === tokenHash) count++;
    }
    return count;
}

function getSessionShortId(sessionId) {
    if (typeof sessionManager.getSessionShortId === "function") {
        return sessionManager.getSessionShortId(sessionId);
    }
    return String(sessionId || "").replace(/^vc_/, "").slice(0, 10);
}

function getClientPoolKey(tokenHash, session) {
    if (!tokenHash || !session?.serverId) return null;
    return sha256(`voice-client:${tokenHash}:${session.serverId}`);
}

function getSessionClientFromPool(sessionId, session, tokenHash) {
    const clientKey = getClientPoolKey(tokenHash, session);
    if (!clientKey) return null;

    const pooledClient = clientPool.get(clientKey) || null;
    if (pooledClient && session && !session.client) {
        session.client = pooledClient;
    }

    debugVoiceSession("clientPool.get", sessionId, session, {
        hit: !!pooledClient,
        strategy: getClientPoolStrategyName()
    });

    return pooledClient;
}

function setSessionClientInPool(sessionId, session, tokenHash, client) {
    const clientKey = getClientPoolKey(tokenHash, session);
    if (!clientKey || !client) return false;

    clientPool.set(clientKey, client);
    if (session) session.client = client;
    debugVoiceSession("clientPool.set", sessionId, session, { strategy: getClientPoolStrategyName() });
    return true;
}

function deleteSessionClientFromPool(sessionId, session, tokenHash, clientRef = null) {
    const clientKey = getClientPoolKey(tokenHash, session);
    if (!clientKey) return false;

    const pooledClient = clientPool.get(clientKey);
    if (clientRef && pooledClient && pooledClient !== clientRef) return false;

    clientPool.delete(clientKey);
    debugVoiceSession("clientPool.delete", sessionId, session, { strategy: getClientPoolStrategyName() });
    return true;
}

function destroySessionClient(sessionId, session, tokenHash, reason = "cleanup", clientRef = null) {
    const targetClient = clientRef || session?.client || getSessionClientFromPool(sessionId, session, tokenHash);
    if (!targetClient) return false;

    try {
        targetClient.destroy?.();
    } catch (err) {
        console.warn(`[CLEANUP] ⚠️ Failed to destroy session client for ${getSessionShortId(sessionId)} (${reason}): ${sanitizeLifecycleError(err.message)}`);
    }

    deleteSessionClientFromPool(sessionId, session, tokenHash, targetClient);
    if (session && session.client === targetClient) session.client = null;
    console.log(`[CLEANUP] 🗑️ Destroyed session-owned client for ${getSessionShortId(sessionId)} (${reason}).`);
    return true;
}

function countOtherActiveSessionsForClient(tokenHash, currentSessionId, currentSession) {
    const currentKey = getClientPoolKey(tokenHash, currentSession);
    if (!currentKey) return 0;

    let count = 0;
    for (const [id, session] of sessionManager.getAllSessions()) {
        if (id === currentSessionId) continue;
        if (!isSessionRunnable(session)) continue;
        if (getSessionTokenHash(id, session) !== tokenHash) continue;
        if (getClientPoolKey(tokenHash, session) === currentKey) count++;
    }

    return count;
}

function cleanupSessionClientIfUnused(tokenHash, clientRef, currentSessionId, currentSession, reason = "cleanup") {
    if (!tokenHash || !clientRef) return false;

    const remaining = countOtherActiveSessionsForClient(tokenHash, currentSessionId, currentSession);
    if (remaining > 0) {
        console.log(`[CLEANUP] ♻️ Keeping session-owned client for ${getSessionShortId(currentSessionId)}. Remaining active sessions: ${remaining}`);
        return false;
    }

    return destroySessionClient(currentSessionId, currentSession, tokenHash, reason, clientRef);
}

function countActiveSessionsForAccountId(accountId) {
    if (!accountId) return 0;

    let count = 0;
    for (const session of sessionManager.getAllSessions().values()) {
        if (isSessionRunnable(session) && String(session.accountId || session.client?.user?.id || "") === String(accountId)) {
            count++;
        }
    }

    return count;
}

async function waitForTokenLoginCooldown(tokenHash) {
    if (!tokenHash) return;

    const minDelayMs = 3500;
    const previous = tokenLoginCooldowns.get(tokenHash) || Promise.resolve(0);

    const next = previous.catch(() => 0).then(async (lastLoginAt) => {
        const elapsed = Date.now() - Number(lastLoginAt || 0);

        if (elapsed < minDelayMs) {
            const jitter = Math.floor(Math.random() * 1200);
            await new Promise(resolve => setTimeout(resolve, minDelayMs - elapsed + jitter));
        }

        return Date.now();
    });

    tokenLoginCooldowns.set(tokenHash, next);
    await next;
}


// ════════════════════════════════════════════════════════════════════════════
//  🧠 REGION 4: SESSION METADATA / DISPLAY HELPERS
// ════════════════════════════════════════════════════════════════════════════
function safeAvatarURL(userLike) {
    try {
        if (!userLike) return null;
        if (typeof userLike.displayAvatarURL === "function") {
            return userLike.displayAvatarURL({ dynamic: true, size: 128 });
        }
        if (typeof userLike.avatarURL === "function") {
            return userLike.avatarURL({ dynamic: true, size: 128 });
        }
    } catch {}
    return null;
}

function safeGuildIconURL(guild) {
    try {
        if (!guild) return null;
        if (typeof guild.iconURL === "function") {
            return guild.iconURL({ dynamic: true, size: 128 });
        }
    } catch {}
    return null;
}

function getAccountLabel(session) {
    const displayName =
        session?.accountGlobalName ||
        session?.accountTag ||
        session?.accountUsername ||
        session?.accountId ||
        "ไม่ทราบบัญชี";

    if (session?.accountUsername && session?.accountGlobalName) {
        return `${session.accountGlobalName} (@${session.accountUsername})`;
    }

    return displayName;
}

function getGuildLabel(session) {
    return session?.serverName || session?.serverId || "ไม่ทราบเซิร์ฟเวอร์";
}

function getVoiceLabel(session) {
    if (session?.voiceName) return session.voiceName;
    if (session?.voiceId) return `<#${session.voiceId}>`;
    return "ไม่ทราบช่องเสียง";
}

function getUptimeString(session) {
    if (!session?.startedAt) return "ไม่ทราบ";
    const uptimeMs = Date.now() - session.startedAt;
    const days = Math.floor(uptimeMs / 86400000);
    const hours = Math.floor((uptimeMs % 86400000) / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);

    if (days > 0) return `${days} วัน ${hours} ชั่วโมง ${minutes} นาที`;
    if (hours > 0) return `${hours} ชั่วโมง ${minutes} นาที`;
    return `${minutes} นาที`;
}

function getConnectionStatusText(session) {
    const status = session?.connection?.state?.status || "unknown";
    if (status === VoiceConnectionStatus.Ready) return "🟢 กำลังออน";
    if (status === VoiceConnectionStatus.Connecting) return "🟡 กำลังเชื่อมต่อ";
    if (status === VoiceConnectionStatus.Signalling) return "🟡 กำลังส่งสัญญาณ";
    if (status === VoiceConnectionStatus.Disconnected) return "🟠 หลุด กำลังกู้คืน";
    if (status === VoiceConnectionStatus.Destroyed) return "🔴 หยุดแล้ว";
    return `⚪ ${status}`;
}

async function refreshSessionMetadata(sessionId, client, guild = null, channel = null) {
    const session = sessionManager.getSession(sessionId);
    if (!session || !client) return false;

    let resolvedGuild = guild;
    let resolvedChannel = channel;

    try {
        if (!resolvedGuild) {
            resolvedGuild = client.guilds.cache.get(session.serverId) ||
                await client.guilds.fetch(session.serverId).catch(() => null);
        }

        if (resolvedGuild && !resolvedChannel) {
            resolvedChannel = resolvedGuild.channels.cache.get(session.voiceId) ||
                await resolvedGuild.channels.fetch(session.voiceId).catch(() => null);
        }
    } catch {}

    const user = client.user || null;
    const metadata = {
        accountId: user?.id || session.accountId || null,
        accountUsername: user?.username || session.accountUsername || null,
        accountGlobalName: user?.globalName || session.accountGlobalName || null,
        accountTag: user?.tag || user?.username || session.accountTag || null,
        accountAvatar: safeAvatarURL(user) || session.accountAvatar || null,

        serverName: resolvedGuild?.name || session.serverName || null,
        guildIcon: safeGuildIconURL(resolvedGuild) || session.guildIcon || null,
        voiceName: resolvedChannel?.name || session.voiceName || null,
        lastActivity: Date.now()
    };

    return updateSessionMetadata(sessionId, metadata);
}

async function refreshSessionMetadataFast(sessionId, timeoutMs = 1500) {
    const session = sessionManager.getSession(sessionId);
    if (!session || !session.client?.isReady?.()) return false;

    return Promise.race([
        refreshSessionMetadata(sessionId, session.client),
        new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
    ]).catch(() => false);
}

function buildVoiceFields(session, extra = {}) {
    const fields = [
        { name: "👤 บัญชีที่ออน", value: getAccountLabel(session), inline: true },
        { name: "🆔 User ID", value: session.accountId ? `\`${session.accountId}\`` : "-", inline: true },
        { name: "🖥️ เซิร์ฟเวอร์", value: getGuildLabel(session), inline: true },
        { name: "🎙️ ช่องเสียง", value: getVoiceLabel(session), inline: true },
        { name: "📌 สถานะ", value: getConnectionStatusText(session), inline: true },
        { name: "⏱️ ออนมาทั้งหมด", value: getUptimeString(session), inline: true },
    ];

    if (session.reconnectCount > 0) {
        fields.push({ name: "🔄 Reconnect", value: `${session.reconnectCount} ครั้ง`, inline: true });
    }

    if (extra.reason) {
        fields.push({ name: "📋 สาเหตุ", value: extra.reason });
    }

    if (extra.action) {
        fields.push({ name: "💡 ต้องทำอะไร", value: extra.action });
    }

    fields.push({ name: "🧩 Session", value: `\`${getSessionShortId(session.sessionId)}\``, inline: true });

    return fields;
}
// ════════════════════════════════════════════════════════════════════════════
//  🚦  REGION 5: OPERATION QUEUE
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
const recoveryQueue = new OperationQueue(2);

// ════════════════════════════════════════════════════════════════════════════
//  🎧  REGION 6: START SESSION
// ════════════════════════════════════════════════════════════════════════════
async function startSession(sessionId, tokenString) {
    if (isShuttingDown) throw new Error("SYSTEM_SHUTTING_DOWN");

    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    validateToken(tokenString);

    if (!lockSession(sessionId)) {
        console.warn(`[WORKER] ⚠️ Session ${sessionId} is locked. Skipping.`);
        throw new Error("SESSION_LOCKED");
    }

    let tokenHash = null;

    try {
        tokenHash = getSessionTokenHash(sessionId, session);
        if (!tokenHash) throw new Error("TOKEN_DECRYPTION_FAILED");

        /*
         * Client ownership is token+guild scoped. Same token in different guilds
         * gets separate SelfClient instances to avoid shared gateway voice-state fights.
         */
        const pooledClient = getSessionClientFromPool(sessionId, session, tokenHash);

        if (pooledClient && pooledClient.isReady?.()) {
            session.client = pooledClient;
            console.log(`[WORKER] ♻️ Reused session-owned client. session=${sessionId}`);
        } else if (pooledClient) {
            deleteSessionClientFromPool(sessionId, session, tokenHash, pooledClient);
            if (session.client === pooledClient) session.client = null;
            console.log(`[WORKER] 🔄 Stale session-owned client — will re-login. session=${sessionId}`);
        }

        if (session.client && !session.client.isReady?.()) {
            destroySessionClient(sessionId, session, tokenHash, "stale-start-client", session.client);
        }

        if (session.client && !pooledClient) {
            setSessionClientInPool(sessionId, session, tokenHash, session.client);
        }

        if (!session.client) {
            const newClient = new SelfClient({ checkUpdate: false });

            newClient.on("ready", () => {
                console.log(`[WORKER] 🟢 Self-bot connected: ${newClient.user.tag}`);
                try { newClient.user.setStatus("idle"); } catch {}
            });

            newClient.on("invalidated", async () => {
                console.error(`[WORKER] 🚫 Token invalidated (WS) for session: ${sessionId}`);
                const sess = sessionManager.getSession(sessionId);
                if (sess) sess.tokenInvalid = true;
                await sendTokenInvalidDM(sessionId).catch(() => {});
            });

            try {
                await waitForTokenLoginCooldown(tokenHash);

                await loginQueue.add(async () => {
                    const loginPromise = newClient.login(tokenString);
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("LOGIN_TIMEOUT")), CONFIG.LOGIN_TIMEOUT)
                    );

                    await Promise.race([loginPromise, timeoutPromise]);
                });

                setSessionClientInPool(sessionId, session, tokenHash, newClient);

            } catch (err) {
                console.error(`[WORKER] ❌ Login failed for ${sessionId}. Destroying ghost client.`);
                try { newClient.destroy(); } catch {}

                const isTokenErr =
                    err.message.includes("TOKEN_INVALID") ||
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
        await new Promise(resolve => setTimeout(resolve, jitterDelay));

        const conn = await connectToVoice(session.client, session.serverId, session.voiceId, tokenHash, sessionId);
        session.connection = conn;

        console.log(`[WORKER] 🎧 Voice connected for Session: ${sessionId} Guild: ${session.serverId}`);
        pushVoiceLog("connect", sessionId, "Voice connected");

        await refreshSessionMetadataFast(sessionId, 1800).catch(() => {});

        // เริ่ม naturalness timer ถ้าเปิดใช้งานอยู่
        startNaturalTimer(sessionId);

        // เริ่ม auto deaf timer ถ้าเปิดใช้งานอยู่
        startAutoDeafTimer(sessionId);

        return true;

    } catch (err) {
        stopNaturalTimer(sessionId);
        stopAutoDeafTimer(sessionId);

        if (session.connection) {
            try { session.connection.destroy(); } catch {}
            session.connection = null;
        }

        if (tokenHash && session.client) {
            cleanupSessionClientIfUnused(tokenHash, session.client, sessionId, session, "start-failure");
        }

        throw err;
    } finally {
        unlockSession(sessionId);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔊  REGION 7: VOICE CONNECTION
// ════════════════════════════════════════════════════════════════════════════
async function connectToVoice(client, guildId, channelId, tokenHash, sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    const guild =
        client.guilds.cache.get(guildId) ||
        await client.guilds.fetch(guildId).catch(() => null);

    if (!guild) throw new Error("GUILD_NOT_FOUND");

    const channel =
        guild.channels.cache.get(channelId) ||
        await guild.channels.fetch(channelId).catch(() => null);

    if (!channel || !channel.isVoice()) throw new Error("CHANNEL_NOT_FOUND");

    await refreshSessionMetadata(sessionId, client, guild, channel).catch(() => {});
    debugVoiceSession("beforeJoin", sessionId, session, {
        accountId: client.user?.id || session.accountId || null,
        group: client.user?.id ? `${client.user.id}:${guild.id}` : null,
        selfVoice: getSelfVoiceStateInfo(client, session).channelId || null,
        sameAccountSessions: countActiveSessionsForAccountId(client.user?.id || session.accountId)
    });

    /*
     * Important:
     * Do NOT use getVoiceConnection(guildId) here.
     * It is guild-wide and can point to another token/session in the same guild.
     * Destroying it causes cross-token collision.
     *
     * Correct behavior:
     * - Same token + same guild is blocked before this point.
     * - Same token + different guild uses a separate session-owned SelfClient.
     * - Different tokens in same guild/channel must not affect each other.
     */
    const existingConn = session.connection;

    if (existingConn && existingConn.state?.status !== VoiceConnectionStatus.Destroyed) {
        const sameGuild = String(existingConn.joinConfig?.guildId) === String(guildId);
        const sameChannel = String(existingConn.joinConfig?.channelId) === String(channelId);

        if (sameGuild && sameChannel && existingConn.state.status === VoiceConnectionStatus.Ready) {
            console.log(`[WORKER] ♻️ Reusing own ready connection for ${sessionId}`);
            return existingConn;
        }

        try {
            console.log(`[WORKER] 🧹 Destroying own stale connection for ${sessionId}`);
            existingConn.destroy();
        } catch {}
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,

        /*
         * group separated by account + guild prevents voice registry collision
         * when multiple tokens join the same guild or same channel.
         */
        group: `${client.user.id}:${guild.id}`
    });

    connection.setMaxListeners(20);
    debugVoiceSession("afterJoinRequested", sessionId, session, {
        accountId: client.user?.id || session.accountId || null,
        group: `${client.user.id}:${guild.id}`,
        connectionStatus: connection.state?.status || null,
        selfVoice: getSelfVoiceStateInfo(client, session).channelId || null,
        sameAccountSessions: countActiveSessionsForAccountId(client.user?.id || session.accountId)
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
        sessionManager.touchSession(sessionId);
        refreshSessionMetadataFast(sessionId, 1200).catch(() => {});
        console.log(`[WORKER] 💚 Voice Ready for ${sessionId}`);
    });

    let reconnectAttempts = 0;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (isShuttingDown) {
            console.log(`[WORKER] ⏸️ Shutdown in progress — skipping reconnect for ${sessionId}`);
            return;
        }

        reconnectAttempts++;
        addReconnect(sessionId);

        const currentSession = sessionManager.getSession(sessionId);
        if (currentSession) currentSession.reconnectCount = (currentSession.reconnectCount || 0) + 1;

        console.log(`[WORKER] ⚠️ Voice dropped for ${sessionId}. Attempt ${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}`);

        if (reconnectAttempts === 3 && process.env.ALERT_WEBHOOK_URL) {
            try {
                const { WebhookClient } = require("discord.js");
                const sess = sessionManager.getSession(sessionId);
                const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });

                await wh.send({
                    content: [
                        `${config.emojis.warning} **[SESSION WARNING]** session หลุดบ่อยผิดปกติ`,
                        `${config.emojis.robot} Session: \`${getSessionShortId(sessionId)}\``,
                        `${config.emojis.signal} เซิร์ฟเวอร์: **${sess?.serverName || guildId}**`,
                        `${config.emojis.halt} ห้องเสียง: **${sess?.voiceName || channel.name || channelId}**`,
                        `${config.emojis.alert} หลุดแล้ว: **${reconnectAttempts}** ครั้ง (สูงสุด ${CONFIG.MAX_RECONNECT_ATTEMPTS})`,
                        `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                    ].join("\n")
                }).catch(() => {});

                wh.destroy();
            } catch {}
        }

        if (reconnectAttempts > CONFIG.MAX_RECONNECT_ATTEMPTS) {
            console.error(`[WORKER] 💀 Max reconnect attempts (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached for ${sessionId}. Aborting.`);
            pushVoiceLog("fail", sessionId, `Max reconnects (${CONFIG.MAX_RECONNECT_ATTEMPTS}) reached`);

            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try { connection.destroy(); } catch {}
            }

            const failedSession = sessionManager.getSession(sessionId);
            if (failedSession) {
                const failedTokenHash = getSessionTokenHash(sessionId, failedSession) || tokenHash;
                const failedClientRef = failedSession.client || getSessionClientFromPool(sessionId, failedSession, failedTokenHash);
                failedSession.connection = null;
                failedSession.reconnecting = false;
                stopNaturalTimer(sessionId);
                stopAutoDeafTimer(sessionId);
                clearReconnect(sessionId);
                recoveryTimestamps.delete(sessionId);
                const markResult = await sessionManager.markSessionFailed?.(
                    sessionId,
                    "max_reconnect_attempts",
                    null,
                    `max reconnect attempts reached (${CONFIG.MAX_RECONNECT_ATTEMPTS})`
                );
                if (markResult?.ok !== true && markResult !== true) {
                    console.warn(`[WORKER] ⚠️ Max reconnect failed state was not persisted for ${sessionId}: ${markResult?.safeError || "UNKNOWN"}`);
                }
                cleanupSessionClientIfUnused(failedTokenHash, failedClientRef, sessionId, failedSession, "max-reconnect");
            }

            await sendSessionStoppedDM(sessionId, "maxRetries");

            if (process.env.ALERT_WEBHOOK_URL) {
                try {
                    const { WebhookClient } = require("discord.js");
                    const sess = sessionManager.getSession(sessionId);
                    const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });

                    await wh.send({
                        content: [
                            `${config.emojis.error} **[SESSION DEAD]** session หลุดเกินกำหนด ระบบหยุดแล้ว`,
                            `${config.emojis.robot} Session: \`${getSessionShortId(sessionId)}\``,
                            `${config.emojis.signal} เซิร์ฟเวอร์: **${sess?.serverName || guildId}**`,
                            `${config.emojis.stop} ห้องเสียง: **${sess?.voiceName || channel.name || channelId}**`,
                            `${config.emojis.no_entry} พยายามต่อใหม่: **${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}** ครั้ง — ยกเลิกแล้ว`,
                            `⏰ <t:${Math.floor(Date.now() / 1000)}:F>`
                        ].join("\n")
                    }).catch(() => {});

                    wh.destroy();
                } catch {}
            }

            return;
        }

        const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);

        let onPassiveSignal;
        let onPassiveConnect;
        let passiveResolved = false;

        try {
            const passivePromise = new Promise(resolve => {
                onPassiveSignal = () => {
                    if (!passiveResolved) {
                        passiveResolved = true;
                        resolve();
                    }
                };

                onPassiveConnect = () => {
                    if (!passiveResolved) {
                        passiveResolved = true;
                        resolve();
                    }
                };

                connection.once(VoiceConnectionStatus.Signalling, onPassiveSignal);
                connection.once(VoiceConnectionStatus.Connecting, onPassiveConnect);
            });

            await Promise.race([
                passivePromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), backoffMs))
            ]);

            if (onPassiveSignal) connection.off(VoiceConnectionStatus.Signalling, onPassiveSignal);
            if (onPassiveConnect) connection.off(VoiceConnectionStatus.Connecting, onPassiveConnect);

            const prevAttempts = reconnectAttempts;
            reconnectAttempts = 0;
            clearReconnect(sessionId);

            console.log(`[WORKER] ✅ Passive reconnect OK for ${sessionId}.`);
            pushVoiceLog("recover", sessionId, "Passive reconnect OK");

            if (prevAttempts > 1) {
                sendSessionOnlineDM(sessionId).catch(() => {});
            }

        } catch {
            if (onPassiveSignal) connection.off(VoiceConnectionStatus.Signalling, onPassiveSignal);
            if (onPassiveConnect) connection.off(VoiceConnectionStatus.Connecting, onPassiveConnect);

            console.warn(`[WORKER] ⚡ Passive reconnect timed out for ${sessionId} — triggering urgent recovery.`);
            pushVoiceLog("drop", sessionId, "Passive timeout → urgent recovery");

            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try { connection.destroy(); } catch {}
            }

            const sess = sessionManager.getSession(sessionId);
            if (sess) sess.urgentRecovery = true;

            setTimeout(() => healthCheck(), 2000);
        }
    });

    return connection;
}
// ════════════════════════════════════════════════════════════════════════════
//  📨  REGION 8: DM NOTIFICATION
// ════════════════════════════════════════════════════════════════════════════
const lastDMSent = new Map();
const lastOnlineDMSent = new Map();

async function sendSessionStoppedDM(sessionId, reason) {
    if (!mainClient) return;

    const lastSent = lastDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < CONFIG.DM_THROTTLE_MS) return;
    lastDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.ownerId) return;

    try {
        await refreshSessionMetadataFast(sessionId, 1200).catch(() => {});

        const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const colorMap = {
            maxRetries: "#ED4245",
            idle: "#FEE75C",
            manual: "#5865F2",
            disconnect: "#ED4245"
        };

        let reasonText;
        let actionText;

        if (reason === "maxRetries") {
            reasonText = `บอทพยายามกลับเข้าช่องเสียงซ้ำ ${CONFIG.MAX_RECONNECT_ATTEMPTS} ครั้งแต่ไม่สำเร็จ ระบบจึงหยุดทำงาน`;
            actionText = "ให้กดเริ่มใหม่ผ่านแผงควบคุมในเซิร์ฟเวอร์ หากช่องเสียงมีปัญหาให้ตรวจสอบสิทธิ์ของบัญชีและช่องเสียง";
        } else if (reason === "idle") {
            reasonText = "Session ไม่ได้มี activity นานเกินเวลาที่ตั้งไว้ ระบบจึงหยุดและลบ session นี้ออก";
            actionText = "หากต้องการให้ออนอีกครั้ง ให้เริ่ม session ใหม่";
        } else if (reason === "manual") {
            reasonText = "มีการสั่งหยุด session นี้ด้วยตนเอง";
            actionText = "หากต้องการให้ออนอีกครั้ง ให้เริ่ม session ใหม่";
        } else {
            reasonText = "การเชื่อมต่อขัดข้องกะทันหัน";
            actionText = "ระบบจะพยายามกู้คืนอัตโนมัติหาก session ยังอยู่";
        }

        const embed = new MessageEmbed()
            .setColor(colorMap[reason] || "#555555")
            .setAuthor({
                name: mainClient.user?.username || "Enterprise",
                iconURL: mainClient.user?.displayAvatarURL()
            })
            .setTitle("🤖 แจ้งเตือนระบบออนช่องเสียง")
            .setDescription(`Session ในเซิร์ฟเวอร์ **${getGuildLabel(session)}** หยุดออนช่องเสียงแล้ว`)
            .addFields(buildVoiceFields(session, {
                reason: reasonText,
                action: actionText
            }))
            .setTimestamp()
            .setFooter({
                text: "Phomueangtai Enterprise",
                iconURL: mainClient.user?.displayAvatarURL()
            });

        if (session.accountAvatar) {
            embed.setThumbnail(session.accountAvatar);
        }

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
            .setColor("#ED4245")
            .setAuthor({
                name: mainClient.user?.username || "Enterprise",
                iconURL: mainClient.user?.displayAvatarURL()
            })
            .setTitle("🚫 Token ใช้งานไม่ได้")
            .setDescription("ระบบไม่สามารถเข้าสู่ระบบบัญชีที่ใช้สำหรับออนช่องเสียงได้")
            .addFields(
                { name: "🖥️ เซิร์ฟเวอร์", value: getGuildLabel(session), inline: true },
                { name: "🎙️ ช่องเสียง", value: getVoiceLabel(session), inline: true },
                { name: "📋 สาเหตุที่เป็นไปได้", value: "Token ผิด / Token หมดอายุ / บัญชีถูกล็อก / Discord ปฏิเสธการเข้าสู่ระบบ" },
                { name: "💡 ต้องทำอะไร", value: "ตรวจสอบ token หรือใช้บัญชีอื่นเริ่ม session ใหม่" },
                { name: "🧩 Session", value: `\`${getSessionShortId(sessionId)}\``, inline: true }
            )
            .setTimestamp()
            .setFooter({
                text: "Phomueangtai Enterprise",
                iconURL: mainClient.user?.displayAvatarURL()
            });

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send token invalid DM for ${sessionId}: ${e.message}`);
    }
}

async function sendSessionOnlineDM(sessionId) {
    if (!mainClient) return;

    const lastSent = lastOnlineDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < 300000) return;
    lastOnlineDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.ownerId) return;

    try {
        await refreshSessionMetadataFast(sessionId, 1200).catch(() => {});

        const owner = await mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const embed = new MessageEmbed()
            .setColor("#57F287")
            .setAuthor({
                name: mainClient.user?.username || "Enterprise",
                iconURL: mainClient.user?.displayAvatarURL()
            })
            .setTitle("✅ กลับมาออนช่องเสียงแล้ว")
            .setDescription(`Session ในเซิร์ฟเวอร์ **${getGuildLabel(session)}** กลับมาเชื่อมต่อได้ตามปกติ`)
            .addFields(buildVoiceFields(session, {
                reason: "ระบบกู้คืนการเชื่อมต่อสำเร็จ"
            }))
            .setTimestamp()
            .setFooter({
                text: "Phomueangtai Enterprise",
                iconURL: mainClient.user?.displayAvatarURL()
            });

        if (session.accountAvatar) {
            embed.setThumbnail(session.accountAvatar);
        }

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send online DM for ${sessionId}: ${e.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🛑  REGION 9: STOP / PAUSE / CLEANUP
// ════════════════════════════════════════════════════════════════════════════
function getVoiceGroup(client, guildId, session = null) {
    const userId = client?.user?.id || session?.accountId;
    if (!userId || !guildId) return null;
    return `${userId}:${guildId}`;
}

function destroyConnectionObject(connection) {
    if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) return true;
    connection.destroy();
    return true;
}

function getSelfVoiceStateInfo(client, session) {
    const guild = client?.guilds?.cache?.get?.(session.serverId) || null;
    const userId = client?.user?.id || null;
    const member = guild && userId
        ? (guild.members?.me || guild.me || guild.members?.cache?.get?.(userId) || null)
        : null;
    const memberVoice = member?.voice || null;
    const cachedState = guild && userId ? guild.voiceStates?.cache?.get?.(userId) : null;
    const voiceState = memberVoice || cachedState || null;
    const channelId =
        memberVoice?.channelId ||
        memberVoice?.channel?.id ||
        cachedState?.channelId ||
        cachedState?.channel?.id ||
        null;

    return {
        inspectable: !!guild && (!!memberVoice || !!cachedState),
        inTargetGuild: !!channelId,
        inTargetChannel: !!channelId && String(channelId) === String(session.voiceId),
        channelId,
        voiceState,
        memberVoice
    };
}

async function waitForSelfVoiceExit(clientRef, session, timeoutMs = 1200) {
    const started = Date.now();
    let lastInfo = getSelfVoiceStateInfo(clientRef, session);

    while (Date.now() - started < timeoutMs) {
        if (!lastInfo.inTargetGuild) return lastInfo;
        await new Promise(resolve => setTimeout(resolve, 150));
        lastInfo = getSelfVoiceStateInfo(clientRef, session);
    }

    return lastInfo;
}

async function attemptSelfVoiceDisconnect(clientRef, session, sessionId, tokenHash, errors) {
    let info = getSelfVoiceStateInfo(clientRef, session);
    if (!info.inTargetGuild) return info;

    const started = Date.now();
    const budgetMs = 1500;
    const disconnectors = [
        { target: info.memberVoice, method: "disconnect", args: ["Voice session stopped"] },
        { target: info.voiceState, method: "disconnect", args: ["Voice session stopped"] },
        { target: info.memberVoice, method: "setChannel", args: [null, "Voice session stopped"] },
        { target: info.voiceState, method: "setChannel", args: [null, "Voice session stopped"] }
    ].filter(item => item.target && typeof item.target[item.method] === "function");

    for (const item of disconnectors) {
        info = getSelfVoiceStateInfo(clientRef, session);
        if (!info.inTargetGuild) return info;
        if (Date.now() - started >= budgetMs) break;

        try {
            await item.target[item.method](...item.args);
            const remainingMs = Math.max(150, budgetMs - (Date.now() - started));
            const after = await waitForSelfVoiceExit(clientRef, session, Math.min(remainingMs, 750));
            if (!after.inTargetGuild) return after;
        } catch (err) {
            errors.push(`selfVoiceDisconnect:${sanitizeLifecycleError(err.message)}`);
        }
    }

    info = getSelfVoiceStateInfo(clientRef, session);
    if (!info.inTargetGuild) return info;

    const otherActive = countOtherActiveSessionsForClient(tokenHash, sessionId, session);
    if (otherActive <= 0) {
        cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "self-voice-fallback");
        const afterDestroy = await waitForSelfVoiceExit(clientRef, session, 500);
        return afterDestroy.inTargetGuild
            ? afterDestroy
            : { inspectable: true, inTargetGuild: false, inTargetChannel: false, channelId: null };
    }

    errors.push(`selfVoiceStillConnected:activeSessions=${otherActive}`);
    return getSelfVoiceStateInfo(clientRef, session);
}

async function cleanupSessionVoiceConnection(sessionId, session, tokenHash) {
    const errors = [];
    const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);
    const group = getVoiceGroup(clientRef, session.serverId, session);

    try {
        if (session.connection) destroyConnectionObject(session.connection);
    } catch (err) {
        errors.push(`session.connection:${sanitizeLifecycleError(err.message)}`);
    } finally {
        session.connection = null;
    }

    try {
        const registryConnection = group ? getVoiceConnection(session.serverId, group) : null;
        if (registryConnection) destroyConnectionObject(registryConnection);
    } catch (err) {
        errors.push(`voiceRegistry:${sanitizeLifecycleError(err.message)}`);
    }

    let selfVoiceInfo = { inspectable: false, inTargetGuild: false, inTargetChannel: false, channelId: null };
    if (clientRef) {
        selfVoiceInfo = await attemptSelfVoiceDisconnect(clientRef, session, sessionId, tokenHash, errors);
    }

    const registryAfter = group ? getVoiceConnection(session.serverId, group) : null;
    const registryAlive = !!registryAfter && registryAfter.state?.status !== VoiceConnectionStatus.Destroyed;
    const ownConnectionAlive = !!session.connection && session.connection.state?.status !== VoiceConnectionStatus.Destroyed;
    const selfStillInVoice = !!selfVoiceInfo.inTargetGuild;

    if (registryAlive) errors.push("voiceRegistry:still_active");
    if (ownConnectionAlive) errors.push("session.connection:still_active");
    if (selfStillInVoice) {
        const scope = selfVoiceInfo.inTargetChannel ? "target_channel" : "target_guild";
        errors.push(`selfVoiceStillConnected:${scope}`);
    }

    const ok = errors.length === 0 && !registryAlive && !ownConnectionAlive && !selfStillInVoice;

    return {
        ok,
        verified: ok && (selfVoiceInfo.inspectable || !clientRef || !clientRef.isReady?.()),
        reason: ok ? "cleanup_verified" : "cleanup_not_confirmed",
        safeError: errors.join("; ") || null,
        shouldDeleteRecord: ok,
        clientRef
    };
}

async function repairFailedStopSessionForTokenGuild(tokenString, serverId) {
    const tokenHash = sha256(tokenString);
    let repaired = 0;
    let blocked = 0;

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (!session || String(session.serverId) !== String(serverId)) continue;
        if (session.stoppedReason !== "stop_cleanup_failed") continue;
        if (getSessionTokenHash(sessionId, session) !== tokenHash) continue;

        const cleanup = await cleanupSessionVoiceConnection(sessionId, session, tokenHash);
        clearReconnect(sessionId);
        recoveryTimestamps.delete(sessionId);

        if (!cleanup.ok || !cleanup.shouldDeleteRecord) {
            blocked++;
            await sessionManager.markSessionFailed?.(
                sessionId,
                "stop_cleanup_failed",
                session.stoppedBy || null,
                cleanup.safeError || cleanup.reason || "repair cleanup not verified"
            );
            continue;
        }

        const deleted = await sessionManager.deleteSession(sessionId);
        if (deleted) {
            repaired++;
            cleanupSessionClientIfUnused(tokenHash, cleanup.clientRef || session.client, sessionId, session, "failed-stop-repair");
        } else {
            blocked++;
            await sessionManager.markSessionFailed?.(
                sessionId,
                "stop_cleanup_failed",
                session.stoppedBy || null,
                "repair delete failed after verified cleanup"
            );
        }
    }

    if (repaired > 0) {
        console.log(`[WORKER] 🧹 Repaired ${repaired} failed voice session record(s) before restart attempt.`);
    }

    return { repaired, blocked };
}

async function stopSession(sessionId, options = {}) {
    if (_isProtected && _isProtected(sessionId)) {
        console.warn(`[WORKER] 🛡️ Session ${sessionId} is PROTECTED — stop rejected by Shadow Protocol`);
        return false;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.warn(`[WORKER] ⚠️ Attempted to stop non-existent session: ${sessionId}`);
        return true;
    }

    const tokenHash = getSessionTokenHash(sessionId, session);
    const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);

    await refreshSessionMetadataFast(sessionId, 1000).catch(() => {});

    stopNaturalTimer(sessionId);
    stopAutoDeafTimer(sessionId);

    const cleanup = await cleanupSessionVoiceConnection(sessionId, session, tokenHash);
    recoveryTimestamps.delete(sessionId);
    lastDMSent.delete(sessionId);
    lastOnlineDMSent.delete(sessionId);
    clearReconnect(sessionId);

    if (!cleanup.ok || !cleanup.shouldDeleteRecord) {
        const markResult = await sessionManager.markSessionFailed?.(
            sessionId,
            "stop_cleanup_failed",
            options.stoppedBy || null,
            cleanup.safeError || cleanup.reason
        );
        const markOk = markResult?.ok === true || markResult === true;
        if (!markOk) {
            console.warn(`[WORKER] ⚠️ Stop cleanup failed and failed state was not persisted for ${sessionId}: ${markResult?.safeError || "UNKNOWN"}`);
        } else {
            console.warn(`[WORKER] ⚠️ Stop cleanup failed for ${sessionId}: ${cleanup.safeError || cleanup.reason}`);
        }
        return false;
    }

    if (options.notifyReason) {
        await sendSessionStoppedDM(sessionId, options.notifyReason).catch(() => {});
    }

    if (tokenHash && clientRef) {
        cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "manual-stop");
    }

    const deleted = await sessionManager.deleteSession(sessionId);
    if (!deleted) {
        const markResult = await sessionManager.markSessionFailed?.(
            sessionId,
            "session_delete_failed",
            options.stoppedBy || null,
            "session delete failed after voice cleanup"
        );
        if (markResult?.ok !== true && markResult !== true) {
            console.warn(`[WORKER] ⚠️ Session delete failed and failed state was not persisted for ${sessionId}: ${markResult?.safeError || "UNKNOWN"}`);
        }
        return false;
    }

    console.log(`[WORKER] 🛑 Stopped session: ${sessionId}`);

    return true;
}

async function stopAll() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🛑 Global Stop: ${sessions.size} sessions...`);

    let stopped = 0;
    let failed = 0;
    for (const id of [...sessions.keys()]) {
        const ok = await stopSession(id);
        if (ok) stopped++;
        else failed++;
    }

    if (failed === 0) {
        destroyAllPooledClients("stopAll");
    }
    naturalRunning.clear();
    autoDeafRunning.clear();
    lastDMSent.clear();
    lastOnlineDMSent.clear();

    console.log(`[WORKER] ✅ Global Stop Complete. stopped=${stopped} failed=${failed}`);
}

async function pauseAll() {
    isShuttingDown = true;

    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] ⏸️ Global Pause: ${sessions.size} sessions...`);

    stopAllNaturalTimers();
    stopAllAutoDeafTimers();

    for (const [id, session] of [...sessions]) {
        try {
            if (session.connection) {
                session.connection.destroy();
                session.connection = null;
            }
            session.reconnecting = false;
            unlockSession(id);

            if (typeof sessionManager.pauseSession === "function") {
                await sessionManager.pauseSession(id);
            }
        } catch {}
    }

    naturalRunning.clear();
    autoDeafRunning.clear();
    destroyAllPooledClients("pauseAll");
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  REGION 10: AUTO RESUME & HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
async function autoResume() {
    const sessions = sessionManager.getAllSessions();
    console.log(`[WORKER] 🔄 Auto-resuming ${sessions.size} dormant sessions...`);

    let count = 0;

    for (const [id] of sessions) {
        if (isShuttingDown) break;

        try {
            const session = sessionManager.getSession(id);
            if (!shouldResumeSession(session)) continue;

            const token = getSessionToken(id);
            if (token) {
                await startSession(id, token);
                count++;

                const warmUpJitter = Math.floor(2000 + Math.random() * 1500);
                await new Promise(resolve => setTimeout(resolve, warmUpJitter));
            }
        } catch (err) {
            console.error(`[WORKER] ❌ Failed to auto-resume ${id}: ${err.message}`);
        }
    }

    console.log(`[WORKER] ✅ Recovered ${count}/${sessions.size} sessions.`);
}

const recoveryTimestamps = new Map();
const RECOVERY_COOLDOWN_MS = 60000;
let healthCheckRunning = false;

async function recoverSessionConnection(sessionId, tokenHash) {
    try {
        const session = sessionManager.getSession(sessionId);
        if (!session || isShuttingDown || !isSessionRunnable(session)) return;

        const recoveryJitter = Math.floor(1000 + Math.random() * 2000);
        await new Promise(resolve => setTimeout(resolve, recoveryJitter));

        if (isShuttingDown) return;

        const latest = sessionManager.getSession(sessionId);
        if (!latest || isShuttingDown || !isSessionRunnable(latest)) return;

        if (!latest.client) latest.client = getSessionClientFromPool(sessionId, latest, tokenHash);
        if (!latest.client?.isReady?.()) return;

        const conn = await connectToVoice(latest.client, latest.serverId, latest.voiceId, tokenHash, sessionId);
        if (conn) latest.connection = conn;

        console.log(`[HEARTBEAT] 💖 Restored connection for ${sessionId}.`);
        pushVoiceLog("recover", sessionId, "Restored by background healthCheck");
        sendSessionOnlineDM(sessionId).catch(() => {});

        startNaturalTimer(sessionId);
        startAutoDeafTimer(sessionId);

    } catch (e) {
        console.error(`[HEARTBEAT] 💔 Recovery failed for ${sessionId}: ${e.message}`);
        pushVoiceLog("fail", sessionId, `Recovery failed: ${e.message}`);
    } finally {
        const latest = sessionManager.getSession(sessionId);
        if (latest) latest.reconnecting = false;
        unlockSession(sessionId);
    }
}

function scheduleHealthRecovery(sessionId, session, tokenHash, now) {
    if (!lockSession(sessionId)) return false;

    session.reconnecting = true;
    recoveryTimestamps.set(sessionId, now);

    console.log(`[HEARTBEAT] 🩺 Queueing dead connection recovery for ${sessionId}...`);

    recoveryQueue.add(() => recoverSessionConnection(sessionId, tokenHash)).catch((e) => {
        console.error(`[HEARTBEAT] 💔 Recovery queue failed for ${sessionId}: ${e.message}`);
        const latest = sessionManager.getSession(sessionId);
        if (latest) latest.reconnecting = false;
        unlockSession(sessionId);
    });

    return true;
}

async function healthCheck() {
    if (isShuttingDown) return;
    if (healthCheckRunning) {
        console.warn("[HEARTBEAT] ⚠️ Previous healthCheck scan still running — skipped.");
        return;
    }

    healthCheckRunning = true;

    try {
        const sessions = sessionManager.getAllSessions();
        const now = Date.now();

        for (const [sessionId, session] of sessions) {
            if (isShuttingDown) break;
            if (!isSessionRunnable(session)) continue;

            const tokenHash = getSessionTokenHash(sessionId, session);
            if (!tokenHash) continue;

            const pooledClient = getSessionClientFromPool(sessionId, session, tokenHash);
            if (!pooledClient) continue;

            if (!session.client) session.client = pooledClient;
            if (!session.client?.isReady?.()) continue;

            const connStatus = session.connection?.state?.status;
            const needsRecovery =
                !session.connection ||
                connStatus === VoiceConnectionStatus.Destroyed ||
                connStatus === VoiceConnectionStatus.Disconnected;

            const lastRecovered = recoveryTimestamps.get(sessionId) || 0;
            const isUrgent = session.urgentRecovery === true;
            const onCooldown = !isUrgent && (now - lastRecovered) < RECOVERY_COOLDOWN_MS;

            if (isUrgent) session.urgentRecovery = false;

            if (!needsRecovery) {
                sessionManager.touchSession(sessionId);
                continue;
            }

            if (needsRecovery && !onCooldown && !session.reconnecting && !isSessionLocked(sessionId)) {
                scheduleHealthRecovery(sessionId, session, tokenHash, now);
            }
        }
    } finally {
        healthCheckRunning = false;
    }
}
async function cleanupIdleSessions() {
    if (isShuttingDown) return;

    const now = Date.now();
    const savedHrs = await sessionManager.getSetting("idleTimeoutHrs", null).catch(() => null);
    const maxIdle = savedHrs ? (parseInt(savedHrs, 10) * 3600000) : config.limits.idleTimeoutMs;
    const sessions = sessionManager.getAllSessions();

    for (const [id, session] of sessions) {
        const lastSeen = session.lastActivity ?? session.startedAt;

        if (now - lastSeen > maxIdle) {
            console.log(`[CLEANUP] 🧹 Session ${id} idle for ${Math.round((now - lastSeen) / 3600000)}h — shutting down.`);
            await sendSessionStoppedDM(id, "idle");
            const stopped = await stopSession(id);
            if (!stopped) {
                console.warn(`[CLEANUP] ⚠️ Idle cleanup could not stop ${id}; session remains visible for review.`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📊  REGION 11: VOICE EVENT LOG
// ════════════════════════════════════════════════════════════════════════════
const VOICE_LOG_MAX = 200;
const voiceEventLog = [];

function pushVoiceLog(type, sessionId, detail = "") {
    const session = sessionManager.getSession(sessionId);

    voiceEventLog.unshift({
        ts: Date.now(),
        type,
        sessionId,
        shortId: getSessionShortId(sessionId),
        account: session ? getAccountLabel(session) : null,
        guild: session ? getGuildLabel(session) : null,
        voice: session ? getVoiceLabel(session) : null,
        detail
    });

    if (voiceEventLog.length > VOICE_LOG_MAX) {
        voiceEventLog.length = VOICE_LOG_MAX;
    }
}

function getVoiceLogs() {
    return voiceEventLog.slice();
}

// ════════════════════════════════════════════════════════════════════════════
//  🎭  REGION 12: NATURALNESS ENGINE
//  ทำให้บอทดูเป็นธรรมชาติ — เปิดไมค์+หูฟังชั่วคราวทุกๆ X ชั่วโมง
//  หมายเหตุ: ไม่มี scheduled leave/rejoin ออกจากห้องเอง
//  ใช้เฉพาะ conn.rejoin เพื่อเปลี่ยน mute/deaf state เท่านั้น
// ════════════════════════════════════════════════════════════════════════════
async function doNaturalBlink(sessionId) {
    if (isShuttingDown) return;
    if (naturalRunning.has(sessionId)) return;

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    naturalRunning.add(sessionId);

    try {
        console.log(`[NATURAL] 🎭 Blink start — ${sessionId}`);

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: false,
            selfDeaf: false
        });

        await new Promise(resolve => setTimeout(resolve, naturalSettings.durationMs));

        const stillAlive = sessionManager.getSession(sessionId);
        if (!stillAlive || !conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[NATURAL] ⚠️ Session gone during blink — ${sessionId}`);
            return;
        }

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: true
        });

        console.log(`[NATURAL] ✅ Blink done — ${sessionId}`);
    } catch (e) {
        console.warn(`[NATURAL] ⚠️ Blink error for ${sessionId}: ${e.message}`);
        try {
            conn.rejoin({
                channelId: session.voiceId,
                selfMute: true,
                selfDeaf: true
            });
        } catch {}
    } finally {
        naturalRunning.delete(sessionId);
    }
}

function stopNaturalTimer(sessionId) {
    const id = naturalTimers.get(sessionId);

    if (id) {
        clearInterval(id);
        naturalTimers.delete(sessionId);
        naturalRunning.delete(sessionId);
        console.log(`[NATURAL] ⏹️ Timer stopped — ${sessionId}`);
    }
}

function startNaturalTimer(sessionId) {
    if (!naturalSettings.enabled) return;

    stopNaturalTimer(sessionId);

    const jitter = Math.floor((Math.random() * 2 - 1) * 5 * 60 * 1000);
    const interval = Math.max(60000, naturalSettings.intervalMs + jitter);

    const id = setInterval(() => doNaturalBlink(sessionId), interval);
    naturalTimers.set(sessionId, id);

    console.log(`[NATURAL] ▶️ Timer started for ${sessionId} (every ${Math.round(interval / 60000)} min, duration ${naturalSettings.durationMs / 1000}s)`);
}

function stopAllNaturalTimers() {
    for (const id of naturalTimers.values()) {
        clearInterval(id);
    }

    naturalTimers.clear();
    naturalRunning.clear();
    console.log("[NATURAL] ⏹️ All timers stopped.");
}

function applyNaturalSettings(newSettings) {
    naturalSettings = { ...naturalSettings, ...newSettings };

    if (!naturalSettings.enabled) {
        stopAllNaturalTimers();
        console.log("[NATURAL] 🔴 Disabled.");
        return;
    }

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (session.client?.isReady?.()) {
            startNaturalTimer(sessionId);
        }
    }

    console.log(`[NATURAL] 🟢 Enabled — interval ${naturalSettings.intervalMs / 60000} min, duration ${naturalSettings.durationMs / 1000}s`);
}

function getNaturalSettings() {
    return {
        ...naturalSettings,
        activeTimers: naturalTimers.size
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🔇  REGION 12.5: AUTO DEAF ENGINE
//  สลับ selfDeaf อัตโนมัติ — เปิดหูชั่วคราวตามกำหนด แล้วปิดกลับ
// ════════════════════════════════════════════════════════════════════════════
async function doAutoDeafToggle(sessionId) {
    if (isShuttingDown) return;
    if (autoDeafRunning.has(sessionId)) return;

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.connection) return;

    const conn = session.connection;
    if (conn.state.status !== VoiceConnectionStatus.Ready) return;

    autoDeafRunning.add(sessionId);

    try {
        console.log(`[AUTODEAF] 🎧 Undeafening — ${sessionId}`);

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: false
        });

        await new Promise(resolve => setTimeout(resolve, autoDeafSettings.openDurationMs));

        const stillAlive = sessionManager.getSession(sessionId);
        if (!stillAlive || !conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[AUTODEAF] ⚠️ Session gone during undeaf — ${sessionId}`);
            return;
        }

        conn.rejoin({
            channelId: session.voiceId,
            selfMute: true,
            selfDeaf: true
        });

        console.log(`[AUTODEAF] ✅ Redeafened — ${sessionId}`);
    } catch (e) {
        console.warn(`[AUTODEAF] ⚠️ Error for ${sessionId}: ${e.message}`);
        try {
            conn.rejoin({
                channelId: session.voiceId,
                selfMute: true,
                selfDeaf: true
            });
        } catch {}
    } finally {
        autoDeafRunning.delete(sessionId);
    }
}

function stopAutoDeafTimer(sessionId) {
    const id = autoDeafTimers.get(sessionId);

    if (id) {
        clearInterval(id);
        autoDeafTimers.delete(sessionId);
        autoDeafRunning.delete(sessionId);
        console.log(`[AUTODEAF] ⏹️ Timer stopped — ${sessionId}`);
    }
}

function startAutoDeafTimer(sessionId) {
    if (!autoDeafSettings.enabled) return;

    stopAutoDeafTimer(sessionId);

    const jitter = Math.floor((Math.random() * 2 - 1) * 5 * 60 * 1000);
    const interval = Math.max(60000, autoDeafSettings.intervalMs + jitter);

    const id = setInterval(() => doAutoDeafToggle(sessionId), interval);
    autoDeafTimers.set(sessionId, id);

    console.log(`[AUTODEAF] ▶️ Timer started for ${sessionId} (every ${Math.round(interval / 60000)} min, open ${autoDeafSettings.openDurationMs / 1000}s)`);
}

function stopAllAutoDeafTimers() {
    for (const id of autoDeafTimers.values()) {
        clearInterval(id);
    }

    autoDeafTimers.clear();
    autoDeafRunning.clear();
    console.log("[AUTODEAF] ⏹️ All timers stopped.");
}

function applyAutoDeafSettings(newSettings) {
    autoDeafSettings = { ...autoDeafSettings, ...newSettings };

    if (!autoDeafSettings.enabled) {
        stopAllAutoDeafTimers();
        console.log("[AUTODEAF] 🔴 Disabled.");
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
        activeTimers: autoDeafTimers.size
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 13: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    setMainClient,
    setShuttingDown,
    setProtectedChecker,
    getClientPoolSize,

    startSession,
    repairFailedStopSessionForTokenGuild,
    stopSession,
    stopAll,
    pauseAll,

    autoResume,
    healthCheck,
    cleanupIdleSessions,

    getVoiceLogs,
    sendSessionStoppedDM,
    sendTokenInvalidDM,
    sendSessionOnlineDM,

    applyNaturalSettings,
    startNaturalTimer,
    stopNaturalTimer,
    getNaturalSettings,

    applyAutoDeafSettings,
    startAutoDeafTimer,
    stopAutoDeafTimer,
    getAutoDeafSettings
};
