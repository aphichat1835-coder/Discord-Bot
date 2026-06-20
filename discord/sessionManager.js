/* eslint-disable complexity -- Session persistence compatibility is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
ATTENTION AI ASSISTANT: DO NOT MODIFY, REFACTOR, OR SIMPLIFY THIS FILE.
1. [DATABASE]: MONGO_URI is the ONLY storage. Local JSON fallback is REMOVED.
2. [ENCRYPTION]: AES-256-GCM with CBC fallback must remain intact.
3. [POOL]: maxPoolSize: 20 MUST remain in mongoose.connect().
4. [SCHEMAS]: Do NOT remove PanelStateModel, LogChannelMapModel, WhitelistModel, BotSettingsModel.
5. [METRICS]: increment() calls must remain for Dashboard accuracy.
================================================================================
*/

const mongoose = require("mongoose");
const crypto = require("crypto");
const config = require("./config.json");
const { sanitizeLogText } = require("./core/safeLogger");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: IN-MEMORY STATE
// ════════════════════════════════════════════════════════════════════════════
const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();
const settingsCache = new Map();

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 2: ENCRYPTION (AES-256-GCM + CBC BACKWARD COMPAT)
// ════════════════════════════════════════════════════════════════════════════
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
    ? crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY).digest("base64").substring(0, 32)
    : "default-key-change-me-32-chars!!";

const LEGACY_KEY = "default-key-change-me-32-chars!!";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").trim() === "production";

if (IS_PRODUCTION && ENCRYPTION_KEY === LEGACY_KEY) {
    throw new Error("[SECURITY] ENCRYPTION_KEY is required in production for session encryption.");
}

function encryptToken(text) {
    if (!text) return null;

    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY), iv);

        let encrypted = cipher.update(text, "utf-8", "hex");
        encrypted += cipher.final("hex");

        const authTag = cipher.getAuthTag().toString("hex");

        return `gcm:${iv.toString("hex")}:${authTag}:${encrypted}`;
    } catch (err) {
        console.error(`[SECURITY] ❌ Failed to encrypt token: ${err.message}`);
        return null;
    }
}

function decryptToken(text) {
    if (!text) return null;

    if (text.startsWith("gcm:")) {
        try {
            const parts = text.split(":");
            const iv = Buffer.from(parts[1], "hex");
            const authTag = Buffer.from(parts[2], "hex");
            const encrypted = Buffer.from(parts.slice(3).join(":"), "hex");

            const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY), iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(encrypted, "hex", "utf-8");
            decrypted += decipher.final("utf-8");

            return decrypted;
        } catch (err) {
            console.error(`[SECURITY] ❌ GCM decryption failed: ${err.message}`);
            return null;
        }
    }

    try {
        const textParts = text.split(":");
        const iv = Buffer.from(textParts.shift(), "hex");
        const encryptedText = Buffer.from(textParts.join(":"), "hex");

        const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText, "hex", "utf-8");
        decrypted += decipher.final("utf-8");

        return decrypted;
    } catch (_) {}

    if (ENCRYPTION_KEY !== LEGACY_KEY) {
        try {
            const textParts = text.split(":");
            const iv = Buffer.from(textParts.shift(), "hex");
            const encryptedText = Buffer.from(textParts.join(":"), "hex");

            const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(LEGACY_KEY), iv);
            let decrypted = decipher.update(encryptedText, "hex", "utf-8");
            decrypted += decipher.final("utf-8");

            console.log("[SECURITY] 🔄 CBC→GCM migration: token ถอดรหัสด้วย legacy key — จะถูก re-encrypt เป็น GCM อัตโนมัติ");
            return decrypted;
        } catch (err) {
            console.error(`[SECURITY] ❌ Decryption failed (GCM + CBC + legacy): ${err.message}`);
        }
    }

    return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  📊  REGION 3: SYSTEM METRICS
// ════════════════════════════════════════════════════════════════════════════
const systemMetrics = {
    requests: 0,
    errors: 0,
    reconnects: 0,
    uptime: Date.now(),

    increment(metric) {
        if (this[metric] !== undefined) this[metric]++;
    }
};

// ════════════════════════════════════════════════════════════════════════════
//  🗄️  REGION 4: MONGOOSE SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

// --- Session Schema ---
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    token: String,

    // Voice target
    serverId: String,
    voiceId: String,
    serverName: String,
    voiceName: String,
    guildIcon: String,

    /*
     * tokenTail is kept ONLY for backward compatibility with old records.
     * Do not display tokenTail in status, DM, dashboard, logs, or UI.
     */
    tokenTail: String,
    tokenHash: String,

    // Owner who started the session
    ownerId: String,
    ownerAvatar: String,
    ownerTag: String,

    // Discord account represented by the supplied token
    accountId: String,
    accountUsername: String,
    accountGlobalName: String,
    accountTag: String,
    accountAvatar: String,

    startedAt: { type: Number, default: Date.now },
    lastActivity: { type: Number, default: Date.now },

    // Optional lifecycle fields. Missing state on old records is treated as active.
    state: String,
    stoppedAt: Number,
    stoppedReason: String,
    stoppedBy: String,
    lastStopError: String
});
const SessionModel = mongoose.model("Session", sessionSchema);

// --- Snapshot Schema (Backup/Restore) ---
const snapshotSchema = new mongoose.Schema({
    snapshotId: { type: String, required: true, unique: true },
    guildId: String,
    Backup_Owner_ID: String,
    data: Object,
    createdAt: { type: Number, default: Date.now }
});
const SnapshotModel = mongoose.model("Snapshot", snapshotSchema);

// --- Approved Guild Schema ---
const approvedGuildSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    approvedAt: { type: Number, default: Date.now }
});
const ApprovedGuildModel = mongoose.model("ApprovedGuild", approvedGuildSchema);

// --- Pending Guild Schema ---
const pendingGuildSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    guildName: String,
    requestedBy: String,
    requestedAt: { type: Number, default: Date.now }
});
const PendingGuildModel = mongoose.model("PendingGuild", pendingGuildSchema);

// --- Panel State Schema (เฟส 2: Panel Persistence หลังบอทรีบูต) ---
const panelStateSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    channelId: String,
    messageId: String,
    updatedAt: { type: Number, default: Date.now }
});
const PanelStateModel = mongoose.model("PanelState", panelStateSchema);

// --- Log Channel Map Schema (เฟส 25: Public Audit Logging) ---
const logChannelMapSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    messageChannelId: String,
    memberChannelId: String,
    voiceChannelId: String,
    serverChannelId: String,
    securityChannelId: String,
    updatedAt: { type: Number, default: Date.now }
});
const LogChannelMapModel = mongoose.model("LogChannelMap", logChannelMapSchema);

// --- Whitelist Schema (เฟส 3: /say whitelist) ---
const whitelistSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    addedBy: String,
    addedAt: { type: Number, default: Date.now },
    scope: { type: String, default: "say" }
});
const WhitelistModel = mongoose.model("Whitelist", whitelistSchema);

// --- Bot Settings Schema (เฟส Dashboard Config) ---
const botSettingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
    updatedAt: { type: Number, default: Date.now }
});
const BotSettingsModel = mongoose.model("BotSettings", botSettingsSchema);

// ════════════════════════════════════════════════════════════════════════════
//  🌐  REGION 5: DATABASE CONNECTION
// ════════════════════════════════════════════════════════════════════════════
let dbConnected = false;
const pendingSessionDeletes = new Set();

mongoose.connection.on("connected", () => {
    console.log("[DATABASE] 🟢 MongoDB Connection Active.");
    dbConnected = true;
    flushPendingSessionDeletes().catch((err) => {
        console.error(`[DATABASE] ❌ Pending session delete flush failed: ${sanitizeLifecycleError(err.message)}`);
    });
});

mongoose.connection.on("disconnected", () => {
    console.error("[DATABASE] 🔴 MongoDB Connection Lost.");
    dbConnected = false;
});

mongoose.connection.on("error", (err) => {
    console.error(`[DATABASE] ❌ MongoDB Error: ${err.message}`);
    dbConnected = false;
});

async function connectDB() {
    if (!process.env.MONGO_URI) {
        throw new Error("[DATABASE] ❌ FATAL: Missing MONGO_URI Environment Variable. System cannot start.");
    }

    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 20,
        minPoolSize: 2
    });

    dbConnected = true;
    console.log("[DATABASE] 🟢 MongoDB Connected with Pool(20) enabled.");
    await flushPendingSessionDeletes();
}

// ════════════════════════════════════════════════════════════════════════════
//  🔑 REGION 6: VOICE SESSION IDENTITY HELPERS
// ════════════════════════════════════════════════════════════════════════════
function hashToken(token) {
    return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function buildVoiceSessionId(tokenHash, serverId, ownerId) {
    const raw = `${tokenHash}:${serverId}:${ownerId}`;
    const shortHash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
    return `vc_${shortHash}`;
}

function getSafeSessionId(sessionId) {
    return String(sessionId || "").slice(0, 32);
}

function isSameTokenGuildSession(session, tokenHash, serverId) {
    if (!session) return false;

    if (session.tokenHash && session.tokenHash === tokenHash && String(session.serverId) === String(serverId)) {
        return true;
    }

    if (!session.tokenHash && session.token) {
        const token = decryptToken(session.token);
        if (!token) return false;

        const existingHash = hashToken(token);
        session.tokenHash = existingHash;

        return existingHash === tokenHash && String(session.serverId) === String(serverId);
    }

    return false;
}

function findActiveVoiceSessionByTokenGuild(tokenHash, serverId) {
    for (const [id, session] of sessions) {
        if (isSameTokenGuildSession(session, tokenHash, serverId)) {
            if (isSessionRunnable(session) || session.stoppedReason === "stop_cleanup_failed") {
                return { id, session };
            }
        }
    }

    return null;
}

function isSessionRunnable(session) {
    if (!session) return false;
    const state = session.state || "active";
    return state === "active";
}

function shouldResumeSession(session) {
    if (!session) return false;
    return (session.state || "active") === "active";
}

function countActiveSessionsByTokenHash(tokenHash) {
    let count = 0;

    for (const session of sessions.values()) {
        if (!session) continue;

        if (session.tokenHash === tokenHash && isSessionRunnable(session)) {
            count++;
            continue;
        }

        if (!session.tokenHash && session.token) {
            const token = decryptToken(session.token);
            if (token && hashToken(token) === tokenHash && isSessionRunnable(session)) {
                session.tokenHash = tokenHash;
                count++;
            }
        }
    }

    return count;
}

// ════════════════════════════════════════════════════════════════════════════
//  💾 REGION 7: SESSION LOAD / SAVE
// ═══��════════════════════════════════════════════════════════════════════════
const LOAD_RECOVERABLE_STOP_CLEANUP_MS = 24 * 60 * 60 * 1000;
const STALE_STOPPED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function loadDatabase() {
    if (!dbConnected) {
        console.error("[DATABASE] ⚠️ Cannot load sessions: DB not connected. Boot sequence will retry.");
        return;
    }

    try {
        const now = Date.now();
        const recoverableCutoff = now - LOAD_RECOVERABLE_STOP_CLEANUP_MS;
        const staleCutoff = now - STALE_STOPPED_SESSION_RETENTION_MS;

        const cleanup = await SessionModel.deleteMany({
            state: { $in: ["failed", "stopped"] },
            stoppedAt: { $lte: staleCutoff },
            stoppedReason: { $ne: "stop_cleanup_failed" }
        }).catch(err => {
            console.warn(`[DATABASE] ⚠️ stale stopped session cleanup skipped: ${err.message}`);
            return null;
        });

        const records = await SessionModel.find({
            $or: [
                { state: "active" },
                { state: { $exists: false } },
                { state: null },
                {
                    stoppedReason: "stop_cleanup_failed",
                    stoppedAt: { $gte: recoverableCutoff }
                }
            ]
        });

        for (const r of records) {
            sessions.set(r.sessionId, {
                sessionId: r.sessionId,
                token: r.token,

                serverId: r.serverId,
                voiceId: r.voiceId,
                serverName: r.serverName,
                voiceName: r.voiceName,
                guildIcon: r.guildIcon,

                tokenTail: r.tokenTail,
                tokenHash: r.tokenHash,

                ownerId: r.ownerId,
                ownerAvatar: r.ownerAvatar,
                ownerTag: r.ownerTag,

                accountId: r.accountId,
                accountUsername: r.accountUsername,
                accountGlobalName: r.accountGlobalName,
                accountTag: r.accountTag,
                accountAvatar: r.accountAvatar,

                startedAt: r.startedAt,
                lastActivity: r.lastActivity,

                state: r.state || "active",
                stoppedAt: r.stoppedAt || null,
                stoppedReason: r.stoppedReason || null,
                stoppedBy: r.stoppedBy || null,
                lastStopError: r.lastStopError || null,

                connection: null,
                reconnecting: false,
                client: null,
                reconnectCount: 0,
                tokenInvalid: false
            });
        }

        const deleted = cleanup?.deletedCount ? `, cleaned=${cleanup.deletedCount}` : "";
        console.log(`[DATABASE] 📂 Loaded ${sessions.size} active/recoverable sessions from MongoDB${deleted}.`);
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load sessions: ${err.message}`);
        throw err;
    }
}

async function saveDatabase() {
    if (!dbConnected) return;

    try {
        if (sessions.size === 0) {
            await SessionModel.deleteMany({}).catch(e => console.error("[DATABASE] ❌ clearAll failed:", e.message));
            return;
        }

        const ops = [];

        for (const [id, session] of sessions) {
            ops.push({
                updateOne: {
                    filter: { sessionId: id },
                    update: {
                        $set: {
                            token: session.token,

                            serverId: session.serverId,
                            voiceId: session.voiceId,
                            serverName: session.serverName,
                            voiceName: session.voiceName,
                            guildIcon: session.guildIcon,

                            tokenTail: session.tokenTail,
                            tokenHash: session.tokenHash,

                            ownerId: session.ownerId,
                            ownerAvatar: session.ownerAvatar,
                            ownerTag: session.ownerTag,

                            accountId: session.accountId,
                            accountUsername: session.accountUsername,
                            accountGlobalName: session.accountGlobalName,
                            accountTag: session.accountTag,
                            accountAvatar: session.accountAvatar,

                            startedAt: session.startedAt,
                            lastActivity: session.lastActivity,
                            state: session.state || "active",
                            stoppedAt: session.stoppedAt || null,
                            stoppedReason: session.stoppedReason || null,
                            stoppedBy: session.stoppedBy || null,
                            lastStopError: session.lastStopError || null
                        }
                    },
                    upsert: true
                }
            });
        }

        await SessionModel.bulkWrite(ops, { ordered: false });
    } catch (err) {
        console.error(`[DATABASE] ❌ MongoDB save failed: ${err.message}`);
    }
}
// ════════════════════════════════════════════════════════════════════════════
//  💾 REGION 8: SESSION CRUD
// ════════════════════════════════════════════════════════════════════════════
async function createSession(token, serverId, voiceId, serverName, ownerId, ownerAvatar, ownerTag) {
    if (!dbConnected) {
        throw new Error("DATABASE_NOT_CONNECTED");
    }

    const tokenHash = hashToken(token);
    const legacyTail = String(token || "").slice(-8);
    const sessionId = buildVoiceSessionId(tokenHash, serverId, ownerId);

    for (const [oldId, oldSession] of [...sessions]) {
        if (
            isSameTokenGuildSession(oldSession, tokenHash, serverId) &&
            oldSession.state === "failed" &&
            oldSession.stoppedReason === "max_reconnect_attempts"
        ) {
            await deleteSession(oldId);
        }
    }

    /*
     * Correct voice rule:
     * - Same token + same guild = blocked.
     * - Same token + different guild = allowed.
     * - Different token + same guild/channel = allowed.
     */
    const existingSameGuild = findActiveVoiceSessionByTokenGuild(tokenHash, serverId);
    if (existingSameGuild) {
        console.log(`[SESSION] ⚠️ Blocked duplicate token/guild voice session: ${getSafeSessionId(existingSameGuild.id)}`);
        throw new Error("ALREADY_ACTIVE_IN_GUILD");
    }

    const configuredMaxSessions = Math.max(
        1,
        Number(await getSetting("maxSessions", config.limits.maxSessions)) || config.limits.maxSessions
    );
    const activeSessionCount = Array.from(sessions.values()).filter(isSessionRunnable).length;
    if (activeSessionCount >= configuredMaxSessions) {
        console.log(`[SESSION] ⛔ System limit reached for: ${ownerTag}`);
        throw new Error("SYSTEM_LIMIT");
    }

    const encryptedToken = encryptToken(token);
    if (!encryptedToken) {
        throw new Error("TOKEN_ENCRYPTION_FAILED");
    }

    const now = Date.now();

    const sessionData = {
        sessionId,
        token: encryptedToken,

        serverId,
        voiceId,
        serverName,
        voiceName: null,
        guildIcon: null,

        /*
         * Kept only for compatibility with old records/tools.
         * Do not show this in status or DM.
         */
        tokenTail: legacyTail,
        tokenHash,

        ownerId,
        ownerAvatar,
        ownerTag,

        accountId: null,
        accountUsername: null,
        accountGlobalName: null,
        accountTag: null,
        accountAvatar: null,

        startedAt: now,
        lastActivity: now,
        state: "active",
        stoppedAt: null,
        stoppedReason: null,
        stoppedBy: null,
        lastStopError: null
    };

    sessions.set(sessionId, {
        ...sessionData,
        connection: null,
        reconnecting: false,
        client: null,
        reconnectCount: 0,
        tokenInvalid: false
    });

    console.log(`[SESSION] ✅ Voice session created: ${sessionId} guild=${serverId} owner=${ownerTag}`);
    systemMetrics.increment("requests");

    try {
        await SessionModel.updateOne(
            { sessionId },
            { $set: sessionData },
            { upsert: true }
        );
    } catch (e) {
        sessions.delete(sessionId);
        console.error(`[DATABASE] ❌ Failed to persist session ${sessionId}: ${sanitizeLifecycleError(e.message)}`);
        throw new Error("SESSION_PERSIST_FAILED");
    }

    return sessionId;
}

function getSession(sessionId) {
    return sessions.get(sessionId);
}

function touchSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
    return session;
}

async function updateSessionMetadata(sessionId, metadata = {}) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    const allowedKeys = [
        "serverName",
        "voiceName",
        "guildIcon",
        "accountId",
        "accountUsername",
        "accountGlobalName",
        "accountTag",
        "accountAvatar",
        "lastActivity",
        "state",
        "stoppedAt",
        "stoppedReason",
        "stoppedBy",
        "lastStopError"
    ];

    const update = {};

    for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)) {
            session[key] = metadata[key] ?? null;
            update[key] = session[key];
        }
    }

    session.lastActivity = Date.now();
    update.lastActivity = session.lastActivity;

    if (dbConnected && Object.keys(update).length > 0) {
        try {
            await SessionModel.updateOne(
                { sessionId },
                { $set: update }
            );
        } catch (err) {
            console.error(`[DATABASE] ❌ Failed to update metadata for ${sessionId}: ${err.message}`);
            systemMetrics.increment("errors");
        }
    }

    return true;
}

function sanitizeLifecycleError(value) {
    return sanitizeLogText(value || "UNKNOWN_ERROR").slice(0, 300);
}

function cleanupSessionMemory(sessionId, session) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

    if (session.connection) {
        try {
            session.connection.destroy();
        } catch {}
        session.connection = null;
    }

    session.reconnecting = false;
    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);
}

async function flushPendingSessionDeletes() {
    if (!dbConnected || pendingSessionDeletes.size === 0) return;

    const sessionIds = [...pendingSessionDeletes];
    try {
        await SessionModel.deleteMany({ sessionId: { $in: sessionIds } });
        for (const sessionId of sessionIds) pendingSessionDeletes.delete(sessionId);
        console.log(`[DATABASE] 🧹 Flushed ${sessionIds.length} pending session delete(s).`);
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to flush pending session deletes: ${sanitizeLifecycleError(err.message)}`);
        systemMetrics.increment("errors");
    }
}

async function markSessionFailed(sessionId, reason, stoppedBy = null, err = null) {
    const session = sessions.get(sessionId);
    if (!session) {
        return {
            ok: false,
            memoryUpdated: false,
            dbPersisted: false,
            safeError: "SESSION_NOT_FOUND"
        };
    }

    const now = Date.now();
    session.state = "failed";
    session.stoppedAt = now;
    session.stoppedReason = reason || "unknown_failure";
    session.stoppedBy = stoppedBy || null;
    session.lastStopError = sanitizeLifecycleError(err?.message || err || reason || "unknown_failure");
    session.reconnecting = false;
    session.lastActivity = now;

    if (!dbConnected) {
        systemMetrics.increment("errors");
        return {
            ok: false,
            memoryUpdated: true,
            dbPersisted: false,
            safeError: "DATABASE_NOT_CONNECTED"
        };
    }

    try {
        const result = await SessionModel.updateOne(
            { sessionId },
            {
                $set: {
                    state: session.state,
                    stoppedAt: session.stoppedAt,
                    stoppedReason: session.stoppedReason,
                    stoppedBy: session.stoppedBy,
                    lastStopError: session.lastStopError,
                    lastActivity: session.lastActivity
                }
            }
        );

        const matched = result?.matchedCount ?? result?.n ?? 0;
        if (matched < 1) {
            systemMetrics.increment("errors");
            return {
                ok: false,
                memoryUpdated: true,
                dbPersisted: false,
                safeError: "SESSION_NOT_FOUND_IN_DATABASE"
            };
        }

        return {
            ok: true,
            memoryUpdated: true,
            dbPersisted: true,
            safeError: null
        };
    } catch (dbErr) {
        const safeError = sanitizeLifecycleError(dbErr.message);
        console.error(`[DATABASE] ❌ Failed to mark session ${sessionId} failed: ${safeError}`);
        systemMetrics.increment("errors");
        return {
            ok: false,
            memoryUpdated: true,
            dbPersisted: false,
            safeError
        };
    }
}

function getAllSessions() {
    return sessions;
}

async function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (!dbConnected) {
        console.warn(`[DATABASE] ⚠️ Queued session ${sessionId} delete until database reconnects`);
        pendingSessionDeletes.add(sessionId);
        cleanupSessionMemory(sessionId, session);
        systemMetrics.increment("errors");
        console.log(`[SESSION] 🗑️ Session removed from memory: ${sessionId}`);
        return true;
    }

    try {
        const result = await SessionModel.deleteOne({ sessionId });
        const deleted = result?.deletedCount ?? result?.n ?? 0;
        if (deleted < 1) {
            console.warn(`[DATABASE] ⚠️ Session ${sessionId} was already absent in database; clearing memory record`);
        }
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to delete session ${sessionId}; queued retry: ${sanitizeLifecycleError(err.message)}`);
        pendingSessionDeletes.add(sessionId);
        cleanupSessionMemory(sessionId, session);
        systemMetrics.increment("errors");
        console.log(`[SESSION] 🗑️ Session removed from memory: ${sessionId}`);
        return true;
    }

    pendingSessionDeletes.delete(sessionId);
    cleanupSessionMemory(sessionId, session);

    console.log(`[SESSION] 🗑️ Session removed: ${sessionId}`);

    return true;
}
async function pauseSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

    if (session.connection) {
        try {
            session.connection.destroy();
        } catch {}
        session.connection = null;
    }

    session.reconnecting = false;
    session.lastActivity = Date.now();

    if (dbConnected) {
        try {
            await SessionModel.updateOne(
                { sessionId },
                { $set: { lastActivity: session.lastActivity } }
            );
        } catch (err) {
            console.error(`[DATABASE] ❌ Failed to pause session ${sessionId}: ${err.message}`);
            systemMetrics.increment("errors");
        }
    }

    return true;
}

async function clearAllSessions() {
    for (const [sessionId, session] of sessions) {
        try {
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            if (session.connection) session.connection.destroy();
        } catch {}
        reconnectTracking.delete(sessionId);
        sessionLocks.delete(sessionId);
    }

    sessions.clear();

    if (dbConnected) {
        try {
            await SessionModel.deleteMany({});
        } catch (err) {
            console.error(`[DATABASE] ❌ Failed to clear sessions: ${err.message}`);
            systemMetrics.increment("errors");
        }
    }

    console.log("[SESSION] 🧹 All sessions cleared.");
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  🛡️ REGION 9: RECONNECT TRACKING / LOCKS
// ════════════════════════════════════════════════════════════════════════════
function acquireSessionLock(sessionId) {
    if (sessionLocks.has(sessionId)) return false;
    sessionLocks.add(sessionId);
    return true;
}

function releaseSessionLock(sessionId) {
    sessionLocks.delete(sessionId);
}

function isSessionLocked(sessionId) {
    return sessionLocks.has(sessionId);
}

function getReconnectInfo(sessionId) {
    if (!reconnectTracking.has(sessionId)) {
        reconnectTracking.set(sessionId, {
            attempts: 0,
            lastAttempt: 0,
            nextAllowedAt: 0
        });
    }

    return reconnectTracking.get(sessionId);
}

function resetReconnectInfo(sessionId) {
    reconnectTracking.delete(sessionId);
}

function canAttemptReconnect(sessionId) {
    const info = getReconnectInfo(sessionId);
    return Date.now() >= (info.nextAllowedAt || 0);
}

function recordReconnectAttempt(sessionId) {
    const info = getReconnectInfo(sessionId);
    const now = Date.now();

    info.attempts += 1;
    info.lastAttempt = now;

    const baseDelay = config.reconnect?.baseDelayMs || 5000;
    const maxDelay = config.reconnect?.maxDelayMs || 300000;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(2, Math.max(0, info.attempts - 1)));

    info.nextAllowedAt = now + delay;

    reconnectTracking.set(sessionId, info);
    systemMetrics.increment("reconnects");

    return info;
}

// ════════════════════════════════════════════════════════════════════════════
//  ✅ REGION 10: APPROVED / PENDING GUILDS
// ════════════════════════════════════════════════════════════════════════════
async function getApprovedGuilds() {
    if (!dbConnected) return [];

    try {
        const docs = await ApprovedGuildModel.find({});
        return docs.map(d => d.guildId);
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load approved guilds: ${err.message}`);
        systemMetrics.increment("errors");
        return [];
    }
}

async function isGuildApproved(guildId) {
    if (!dbConnected) return false;

    try {
        const found = await ApprovedGuildModel.findOne({ guildId });
        return !!found;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to check approved guild ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function approveGuild(guildId) {
    if (!dbConnected) return false;

    try {
        await ApprovedGuildModel.updateOne(
            { guildId },
            { $set: { guildId, approvedAt: Date.now() } },
            { upsert: true }
        );
        await PendingGuildModel.deleteOne({ guildId });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to approve guild ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function removeApprovedGuild(guildId) {
    if (!dbConnected) return false;

    try {
        await ApprovedGuildModel.deleteOne({ guildId });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to remove approved guild ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function addPendingGuild(guildId, guildName, requestedBy) {
    if (!dbConnected) return false;

    try {
        await PendingGuildModel.updateOne(
            { guildId },
            {
                $set: {
                    guildId,
                    guildName,
                    requestedBy,
                    requestedAt: Date.now()
                }
            },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to add pending guild ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getPendingGuilds() {
    if (!dbConnected) return [];

    try {
        return await PendingGuildModel.find({}).sort({ requestedAt: -1 });
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load pending guilds: ${err.message}`);
        systemMetrics.increment("errors");
        return [];
    }
}

async function removePendingGuild(guildId) {
    if (!dbConnected) return false;

    try {
        await PendingGuildModel.deleteOne({ guildId });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to remove pending guild ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💾 REGION 11: BACKUP SNAPSHOTS
// ════════════════════════════════════════════════════════════════════════════
async function saveSnapshot(snapshotId, guildId, backupOwnerId, data) {
    if (!dbConnected) return false;

    try {
        await SnapshotModel.updateOne(
            { snapshotId },
            {
                $set: {
                    snapshotId,
                    guildId,
                    Backup_Owner_ID: backupOwnerId,
                    data,
                    createdAt: Date.now()
                }
            },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to save snapshot ${snapshotId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getSnapshot(snapshotId) {
    if (!dbConnected) return null;

    try {
        return await SnapshotModel.findOne({ snapshotId });
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to get snapshot ${snapshotId}: ${err.message}`);
        systemMetrics.increment("errors");
        return null;
    }
}

async function deleteSnapshot(snapshotId) {
    if (!dbConnected) return false;

    try {
        await SnapshotModel.deleteOne({ snapshotId });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to delete snapshot ${snapshotId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🧾 REGION 12: PANEL STATE
// ════════════════════════════════════════════════════════════════════════════
async function savePanelState(guildId, channelId, messageId) {
    if (!dbConnected) return false;

    try {
        await PanelStateModel.updateOne(
            { guildId },
            {
                $set: {
                    guildId,
                    channelId,
                    messageId,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to save panel state for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getPanelState(guildId) {
    if (!dbConnected) return null;

    try {
        return await PanelStateModel.findOne({ guildId });
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to get panel state for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return null;
    }
}

async function deletePanelState(guildId) {
    if (!dbConnected) return false;

    try {
        await PanelStateModel.deleteOne({ guildId });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to delete panel state for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📢 REGION 13: LOG CHANNEL MAP
// ════════════════════════════════════════════════════════════════════════════
async function saveLogChannelMap(guildId, map = {}) {
    if (!dbConnected) return false;

    try {
        await LogChannelMapModel.updateOne(
            { guildId },
            {
                $set: {
                    guildId,
                    messageChannelId: map.messageChannelId || null,
                    memberChannelId: map.memberChannelId || null,
                    voiceChannelId: map.voiceChannelId || null,
                    serverChannelId: map.serverChannelId || null,
                    securityChannelId: map.securityChannelId || null,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to save log channel map for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function setLogChannelMap(guildId, category, channelId) {
    if (!dbConnected) return false;
    const keyMap = {
        message: "messageChannelId",
        member: "memberChannelId",
        voice: "voiceChannelId",
        server: "serverChannelId",
        security: "securityChannelId"
    };
    const key = keyMap[category];
    if (!key) return false;
    try {
        await LogChannelMapModel.updateOne(
            { guildId },
            {
                $set: {
                    guildId,
                    [key]: channelId || null,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to set log channel map ${category} for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getLogChannelMap(guildId) {
    if (!dbConnected) return null;

    try {
        return await LogChannelMapModel.findOne({ guildId });
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to get log channel map for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return null;
    }
}

async function deleteLogChannelMap(guildId) {
    if (!dbConnected) return false;

    try {
        await LogChannelMapModel.deleteOne({ guildId });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to delete log channel map for ${guildId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}
// ════════════════════════════════════════════════════════════════════════════
//  ✅ REGION 14: WHITELIST
// ════════════════════════════════════════════════════════════════════════════
async function isWhitelisted(userId, scope = "say") {
    if (!dbConnected) return false;

    try {
        const doc = await WhitelistModel.findOne({
            userId,
            scope
        });

        return !!doc;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to check whitelist for ${userId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function addWhitelist(userId, addedBy, scope = "say") {
    if (!dbConnected) return false;

    try {
        await WhitelistModel.updateOne(
            { userId, scope },
            {
                $set: {
                    userId,
                    addedBy,
                    scope,
                    addedAt: Date.now()
                }
            },
            { upsert: true }
        );

        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to add whitelist ${userId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function removeWhitelist(userId, scope = "say") {
    if (!dbConnected) return false;

    try {
        await WhitelistModel.deleteOne({ userId, scope });
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to remove whitelist ${userId}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getWhitelist(scope = "say") {
    if (!dbConnected) return [];

    try {
        return await WhitelistModel.find({ scope }).sort({ addedAt: -1 });
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load whitelist: ${err.message}`);
        systemMetrics.increment("errors");
        return [];
    }
}

async function getAllWhitelist(scope = "say") {
    return getWhitelist(scope);
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️ REGION 15: BOT SETTINGS
// ════════════════════════════════════════════════════════════════════════════
async function setSetting(key, value) {
    if (!dbConnected) return false;

    try {
        await BotSettingsModel.updateOne(
            { key },
            {
                $set: {
                    key,
                    value,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        settingsCache.set(key, value);

        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to set setting ${key}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getSetting(key, fallback = null) {
    if (!dbConnected) return fallback;

    try {
        const doc = await BotSettingsModel.findOne({ key });
        if (!doc) return fallback;
        settingsCache.set(key, doc.value);
        return doc.value;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to get setting ${key}: ${err.message}`);
        systemMetrics.increment("errors");
        return fallback;
    }
}

async function deleteSetting(key) {
    if (!dbConnected) return false;

    try {
        await BotSettingsModel.deleteOne({ key });
        settingsCache.delete(key);
        return true;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to delete setting ${key}: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getAllSettings() {
    if (!dbConnected) return {};

    try {
        const docs = await BotSettingsModel.find({});
        const result = {};

        for (const doc of docs) {
            result[doc.key] = doc.value;
            settingsCache.set(doc.key, doc.value);
        }

        return result;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load all settings: ${err.message}`);
        systemMetrics.increment("errors");
        return {};
    }
}

function getCachedSetting(key, fallback = null) {
    return settingsCache.has(key) ? settingsCache.get(key) : fallback;
}

// ════════════════════════════════════════════════════════════════════════════
//  📊 REGION 16: METRICS / STATUS
// ════════════════════════════════════════════════════════════════════════════
function getSystemMetrics() {
    return {
        ...systemMetrics,
        uptimeMs: Date.now() - systemMetrics.uptime,
        sessions: sessions.size,
        dbConnected,
        lockedSessions: sessionLocks.size,
        reconnectTracking: reconnectTracking.size
    };
}

function getDatabaseStatus() {
    return {
        connected: dbConnected,
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host || null,
        name: mongoose.connection.name || null
    };
}

function getVoiceSessionSummary(session) {
    if (!session) return null;

    return {
        sessionId: session.sessionId,
        serverId: session.serverId,
        voiceId: session.voiceId,
        serverName: session.serverName || null,
        voiceName: session.voiceName || null,
        guildIcon: session.guildIcon || null,

        ownerId: session.ownerId,
        ownerTag: session.ownerTag || null,
        ownerAvatar: session.ownerAvatar || null,

        accountId: session.accountId || null,
        accountUsername: session.accountUsername || null,
        accountGlobalName: session.accountGlobalName || null,
        accountTag: session.accountTag || null,
        accountAvatar: session.accountAvatar || null,

        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        reconnecting: !!session.reconnecting,
        reconnectCount: session.reconnectCount || 0,
        tokenInvalid: !!session.tokenInvalid,
        hasConnection: !!session.connection,
        state: session.state || "active",
        stoppedAt: session.stoppedAt || null,
        stoppedReason: session.stoppedReason || null,
        stoppedBy: session.stoppedBy || null,
        lastStopError: session.lastStopError || null,
        clientReady: !!session.client?.isReady?.(),
        staleSuspected: (session.state || "active") === "active" && !session.connection,
        ghostSuspected: session.stoppedReason === "stop_cleanup_failed",

        /*
         * Do not expose token, encrypted token, tokenTail, or tokenHash here.
         */
        connectionStatus: session.connection?.state?.status || null
    };
}

function getAllSessionSummaries() {
    return Array.from(sessions.values()).map(getVoiceSessionSummary);
}

// ════════════════════════════════════════════════════════════════════════════
//  🧩 REGION 17: COMPATIBILITY HELPERS
// ════════════════════════════════════════════════════════════════════════════
function getSessionToken(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.token) return null;
    return decryptToken(session.token);
}

function getSessionTokenHash(sessionId, sessionOverride = null) {
    const session = sessionOverride || sessions.get(sessionId);
    if (!session) return null;

    if (session.tokenHash) return session.tokenHash;

    const token = getSessionToken(sessionId);
    if (!token) return null;

    const tokenHash = hashToken(token);
    session.tokenHash = tokenHash;

    return tokenHash;
}

function getSessionByTokenGuild(tokenHash, serverId) {
    const found = findActiveVoiceSessionByTokenGuild(tokenHash, serverId);
    return found?.session || null;
}

function hasActiveTokenGuildSession(tokenHash, serverId) {
    return !!findActiveVoiceSessionByTokenGuild(tokenHash, serverId);
}

function getActiveSessionsByTokenHash(tokenHash) {
    const result = [];

    for (const session of sessions.values()) {
        const currentHash = session.tokenHash || getSessionTokenHash(session.sessionId, session);
        if (currentHash === tokenHash && isSessionRunnable(session)) result.push(session);
    }

    return result;
}

function getActiveSessionsByGuild(serverId) {
    const result = [];

    for (const session of sessions.values()) {
        if (String(session.serverId) === String(serverId) && isSessionRunnable(session)) {
            result.push(session);
        }
    }

    return result;
}

function getSessionShortId(sessionId) {
    return String(sessionId || "").replace(/^vc_/, "").slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════════════
//  📤 REGION 18: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    // DB
    connectDB,
    loadDatabase,
    saveDatabase,
    getDatabaseStatus,

    // Session CRUD
    createSession,
    getSession,
    touchSession,
    updateSessionMetadata,
    getAllSessions,
    getAllSessionSummaries,
    getVoiceSessionSummary,
    markSessionFailed,
    deleteSession,
    pauseSession,
    clearAllSessions,

    // Voice identity helpers
    hashToken,
    buildVoiceSessionId,
    findActiveVoiceSessionByTokenGuild,
    countActiveSessionsByTokenHash,
    isSessionRunnable,
    shouldResumeSession,
    getSessionToken,
    getSessionTokenHash,
    getSessionByTokenGuild,
    hasActiveTokenGuildSession,
    getActiveSessionsByTokenHash,
    getActiveSessionsByGuild,
    getSessionShortId,

    // Reconnect / locks
    acquireSessionLock,
    releaseSessionLock,
    isSessionLocked,
    getReconnectInfo,
    resetReconnectInfo,
    canAttemptReconnect,
    recordReconnectAttempt,

    // Backward-compatible aliases for existing project files
    lockSession: acquireSessionLock,
    unlockSession: releaseSessionLock,
    addReconnect: recordReconnectAttempt,
    clearReconnect: resetReconnectInfo,
    getToken: getSessionToken,

    // Guild approvals
    getApprovedGuilds,
    isGuildApproved,
    approveGuild,
    removeApprovedGuild,
    addPendingGuild,
    getPendingGuilds,
    removePendingGuild,

    // Snapshots
    saveSnapshot,
    getSnapshot,
    deleteSnapshot,

    // Panel state
    savePanelState,
    getPanelState,
    deletePanelState,

    // Log channels
    saveLogChannelMap,
    setLogChannelMap,
    getLogChannelMap,
    deleteLogChannelMap,

    // Whitelist
    isWhitelisted,
    addWhitelist,
    removeWhitelist,
    getWhitelist,
    getAllWhitelist,

    // Settings
    setSetting,
    getSetting,
    getCachedSetting,
    deleteSetting,
    getAllSettings,

    // Metrics
    systemMetrics,
    getSystemMetrics,

    // Raw models for existing internal dashboards/tools
    SessionModel,
    SnapshotModel,
    ApprovedGuildModel,
    PendingGuildModel,
    PanelStateModel,
    LogChannelMapModel,
    WhitelistModel,
    BotSettingsModel,

    // Encryption helpers kept for existing code paths
    encryptToken,
    decryptToken
};
