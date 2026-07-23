/* eslint-disable complexity -- Session persistence compatibility is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
ATTENTION AI ASSISTANT: DO NOT MODIFY, REFACTOR, OR SIMPLIFY THIS FILE.
1. [DATABASE]: MONGO_URI is the ONLY storage. Local JSON fallback is REMOVED.
2. [ENCRYPTION]: AES-256-GCM with CBC fallback must remain intact.
3. [POOL]: maxPoolSize: 20 MUST remain in mongoose.connect().
4. [SCHEMAS]: Do NOT remove PanelStateModel or BotSettingsModel.
5. [METRICS]: increment() calls must remain for Dashboard accuracy.
================================================================================
*/

const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("./config.json");
const { sanitizeLogText } = require("./core/safeLogger");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: IN-MEMORY STATE
// ════════════════════════════════════════════════════════════════════════════
const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();
const settingsCache = new Map();
const RETIRED_ENTERPRISE_AUDIT_SETTINGS = /^(?:audit_|logChannelMapExtra_)/;
const INTERNAL_EVENT_SETTINGS = /^internal_event_/;
const RETIRED_ENTERPRISE_AUDIT_PREFIXES = ["audit_", "logChannelMapExtra_"];
const INTERNAL_EVENT_PREFIX = "internal_event_";
function isRetiredEnterpriseAuditSetting(key) {
    return RETIRED_ENTERPRISE_AUDIT_PREFIXES.some(prefix => key.startsWith(prefix));
}
function shouldCacheSettingKey(key) {
    return !String(key || "").startsWith(INTERNAL_EVENT_PREFIX);
}
function numberEnv(name, fallback, min = 1) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, value);
}

function boundedLimit(value, max, fallback = max) {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(max, Math.max(1, Math.floor(next)));
}

const SESSION_LOAD_MAX = numberEnv("SESSION_LOAD_MAX", 100, 1);
const APPROVED_GUILDS_LOAD_MAX = numberEnv("APPROVED_GUILDS_LOAD_MAX", 1000, 1);
const PENDING_GUILDS_LOAD_MAX = numberEnv("PENDING_GUILDS_LOAD_MAX", 500, 1);
const BOT_SETTINGS_LOAD_MAX = numberEnv("BOT_SETTINGS_LOAD_MAX", 500, 1);
const PANEL_STATES_LOAD_MAX = numberEnv("PANEL_STATES_LOAD_MAX", 500, 1);
let lastLoadStats = {
    loaded: 0,
    cleaned: 0,
    active: 0,
    recoverable: 0,
    at: null,
    truncated: false,
    max: SESSION_LOAD_MAX
};

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 2: ENCRYPTION (AES-256-GCM + CBC BACKWARD COMPAT)
// ════════════════════════════════════════════════════════════════════════════
const LEGACY_KEY = "default-key-change-me-32-chars!!";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").trim() === "production";
const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || LEGACY_KEY;
const CURRENT_ENCRYPTION_KEY = crypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();
const LEGACY_DERIVED_KEY = process.env.ENCRYPTION_KEY
    ? Buffer.from(crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY).digest("base64").substring(0, 32))
    : Buffer.from(LEGACY_KEY);
const LEGACY_DECRYPTION_KEYS = [LEGACY_DERIVED_KEY, Buffer.from(LEGACY_KEY)]
    .filter((key, index, keys) => keys.findIndex(candidate => candidate.equals(key)) === index);

if (IS_PRODUCTION && !process.env.ENCRYPTION_KEY) {
    throw new Error("[SECURITY] ENCRYPTION_KEY is required in production for session encryption.");
}

function encryptToken(text) {
    if (!text) return null;

    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(
            "aes-256-gcm",
            CURRENT_ENCRYPTION_KEY,
            iv,
            { authTagLength: 16 }
        );

        let encrypted = cipher.update(text, "utf-8", "hex");
        encrypted += cipher.final("hex");

        const authTag = cipher.getAuthTag().toString("hex");

        return `v3:gcm:${iv.toString("hex")}:${authTag}:${encrypted}`;
    } catch (err) {
        console.error(`[SECURITY] ❌ Failed to encrypt token: ${err.message}`);
        return null;
    }
}

function decryptGcmToken(text, key, versioned) {
    const parts = text.split(":");
    const offset = versioned ? 2 : 1;
    const iv = Buffer.from(parts[offset], "hex");
    const authTag = Buffer.from(parts[offset + 1], "hex");
    const encrypted = Buffer.from(parts.slice(offset + 2).join(":"), "hex");
    if (iv.length !== 12 || authTag.length !== 16 || encrypted.length === 0) {
        throw new Error("Invalid GCM token payload");
    }
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        iv,
        { authTagLength: 16 }
    );
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}

function decryptCbcToken(text, key) {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    if (iv.length !== 16 || encryptedText.length === 0) throw new Error("Invalid CBC token payload");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString("utf-8");
}

function isPlausiblePlaintext(value) {
    if (typeof value !== "string" || value.length === 0) return false;
    for (const character of value) {
        const code = character.codePointAt(0);
        const allowedWhitespace = code === 9 || code === 10 || code === 13;
        if ((code < 32 && !allowedWhitespace) || code === 127) return false;
    }
    return true;
}

function decryptTokenWithMetadata(text) {
    if (!text || typeof text !== "string") return null;

    if (text.startsWith("v3:gcm:")) {
        try {
            return { plaintext: decryptGcmToken(text, CURRENT_ENCRYPTION_KEY, true), needsMigration: false };
        } catch (err) {
            console.error(`[SECURITY] ❌ GCM decryption failed: ${err.message}`);
            return null;
        }
    }

    if (text.startsWith("gcm:")) {
        let lastError = null;
        for (const key of LEGACY_DECRYPTION_KEYS) {
            try {
                return { plaintext: decryptGcmToken(text, key, false), needsMigration: true };
            } catch (err) {
                lastError = err;
            }
        }
        console.error(`[SECURITY] ❌ Legacy GCM decryption failed: ${lastError?.message || "unknown"}`);
        return null;
    }

    for (const key of LEGACY_DECRYPTION_KEYS) {
        try {
            const plaintext = decryptCbcToken(text, key);
            if (!isPlausiblePlaintext(plaintext)) continue;
            return { plaintext, needsMigration: true };
        } catch (_) {}
    }

    console.error("[SECURITY] ❌ Decryption failed for all compatible Voice token formats");
    return null;
}

function decryptToken(text) {
    return decryptTokenWithMetadata(text)?.plaintext || null;
}

/*
 * Existing records are migrated only after authenticated decryption succeeds.
 * ENCRYPTION_KEY must stay unchanged during this transition.
 */
function migrateEncryptedToken(text) {
    const result = decryptTokenWithMetadata(text);
    if (!result?.plaintext || result.needsMigration !== true) return { token: text, migrated: false };
    try {
        const token = encryptToken(result.plaintext);
        return token ? { token, migrated: true } : { token: text, migrated: false };
    } finally {
        result.plaintext = null;
    }
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
    voiceReadyAt: Number,
    lifecycleGeneration: String,
    reconnectCount: { type: Number, default: 0 },
    tokenInvalid: { type: Boolean, default: false },
    recoveryState: mongoose.Schema.Types.Mixed,
    notificationState: mongoose.Schema.Types.Mixed,

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
    storageMode: { type: String, default: "legacy" },
    chunkMeta: Object,
    complete: { type: Boolean, default: true },
    activationPending: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    supersededAt: { type: Number, default: null },
    supersededBy: { type: String, default: null },
    createdAt: { type: Number, default: Date.now }
});
snapshotSchema.index({ guildId: 1 }, { unique: true, partialFilterExpression: { active: true } });
const SnapshotModel = mongoose.model("Snapshot", snapshotSchema);
const snapshotChunkSchema = new mongoose.Schema({
    snapshotId: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    itemCount: { type: Number, required: true },
    byteSize: { type: Number, required: true },
    complete: { type: Boolean, default: true },
    createdAt: { type: Number, default: Date.now }
});
snapshotChunkSchema.index({ snapshotId: 1, kind: 1, chunkIndex: 1 }, { unique: true });
const SnapshotChunkModel = mongoose.model("SnapshotChunk", snapshotChunkSchema);

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
const MONGO_POOL_CONFIG = {
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
};

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
        serverSelectionTimeoutMS: MONGO_POOL_CONFIG.serverSelectionTimeoutMS,
        socketTimeoutMS: MONGO_POOL_CONFIG.socketTimeoutMS,
        maxPoolSize: MONGO_POOL_CONFIG.maxPoolSize,
        minPoolSize: MONGO_POOL_CONFIG.minPoolSize
    });

    dbConnected = true;
    console.log("[DATABASE] 🟢 MongoDB Connected with Pool(20) enabled.");
    await flushPendingSessionDeletes();
}

async function disconnectDB() {
    if (mongoose.connection.readyState === 0) {
        dbConnected = false;
        return;
    }
    try {
        await flushPendingSessionDeletes();
    } finally {
        try {
            await mongoose.disconnect();
        } finally {
            dbConnected = false;
        }
    }
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
    return state === "active" && session.tokenInvalid !== true;
}

function shouldResumeSession(session) {
    if (!session) return false;
    return (session.state || "active") === "active" && session.tokenInvalid !== true;
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
        await reconcileSnapshotPointers().catch(err => {
            console.warn(`[DATABASE] ⚠️ Snapshot pointer reconciliation deferred: ${String(err?.message || err).slice(0, 180)}`);
        });
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

        const sessionLoadFilter = {
            $or: [
                { state: "active" },
                { state: { $exists: false } },
                { state: null },
                {
                    stoppedReason: "stop_cleanup_failed",
                    stoppedAt: { $gte: recoverableCutoff }
                }
            ]
        };
        const [records, matchingCount] = await Promise.all([
            SessionModel.find(sessionLoadFilter)
                .sort({ lastActivity: -1, startedAt: -1, _id: -1 })
                .limit(SESSION_LOAD_MAX)
                .lean(),
            SessionModel.countDocuments(sessionLoadFilter)
        ]);

        let activeLoaded = 0;
        let recoverableLoaded = 0;
        const encryptionMigrationOps = [];

        for (const r of records) {
            const state = r.state || "active";
            if (state === "active") activeLoaded++;
            else recoverableLoaded++;

            const migratedToken = migrateEncryptedToken(r.token);
            if (migratedToken.migrated) {
                encryptionMigrationOps.push({
                    updateOne: {
                        filter: { _id: r._id, token: r.token },
                        update: { $set: { token: migratedToken.token } }
                    }
                });
            }

            sessions.set(r.sessionId, {
                sessionId: r.sessionId,
                token: migratedToken.token,

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
                voiceReadyAt: r.voiceReadyAt || null,
                lifecycleGeneration: r.lifecycleGeneration || crypto.randomUUID(),

                state,
                stoppedAt: r.stoppedAt || null,
                stoppedReason: r.stoppedReason || null,
                stoppedBy: r.stoppedBy || null,
                lastStopError: r.lastStopError || null,

                connection: null,
                reconnecting: false,
                client: null,
                reconnectCount: Number(r.reconnectCount || 0),
                tokenInvalid: r.tokenInvalid === true,
                recoveryState: r.recoveryState || null,
                notificationState: r.notificationState || null
            });
        }

        if (encryptionMigrationOps.length > 0) {
            try {
                const migrationResult = await SessionModel.bulkWrite(encryptionMigrationOps, { ordered: false });
                console.log(`[SECURITY] 🔄 Migrated ${migrationResult.modifiedCount || 0} Voice session token(s) to v3 encryption.`);
            } catch (err) {
                console.warn(`[SECURITY] ⚠️ Voice token migration will retry on the next save: ${err.message}`);
            }
        }

        lastLoadStats = {
            loaded: records.length,
            cleaned: cleanup?.deletedCount || 0,
            active: activeLoaded,
            recoverable: recoverableLoaded,
            matching: matchingCount,
            truncated: matchingCount > records.length,
            max: SESSION_LOAD_MAX,
            at: now
        };

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
                            voiceReadyAt: session.voiceReadyAt || null,
                            lifecycleGeneration: session.lifecycleGeneration || null,
                            reconnectCount: Number(session.reconnectCount || 0),
                            tokenInvalid: session.tokenInvalid === true,
                            recoveryState: session.recoveryState || null,
                            notificationState: session.notificationState || null,
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

    for (const [oldId, oldSession] of Array.from(sessions)) {
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
        console.log(`[SESSION] ⚠️ Blocked duplicate token/guild voice session: ${sanitizeLogText(getSafeSessionId(existingSameGuild.id))}`);
        throw new Error("ALREADY_ACTIVE_IN_GUILD");
    }

    const configuredMaxSessions = Math.max(
        1,
        Number(await getSetting("maxSessions", config.limits.maxSessions)) || config.limits.maxSessions
    );
    const activeSessionCount = Array.from(sessions.values()).filter(isSessionRunnable).length;
    if (activeSessionCount >= configuredMaxSessions) {
        console.log(`[SESSION] ⛔ System limit reached for owner=${sanitizeLogText(ownerId || "unknown")}`);
        throw new Error("SYSTEM_LIMIT");
    }

    const encryptedToken = encryptToken(token);
    if (!encryptedToken) {
        throw new Error("TOKEN_ENCRYPTION_FAILED");
    }

    const now = Date.now();
    const lifecycleGeneration = crypto.randomUUID();

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
        voiceReadyAt: null,
        lifecycleGeneration,
        reconnectCount: 0,
        tokenInvalid: false,
        recoveryState: null,
        notificationState: null,
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
        client: null
    });

    console.log(`[SESSION] ✅ Voice session created: ${sanitizeLogText(getSafeSessionId(sessionId))} guild=${sanitizeLogText(serverId)} owner=${sanitizeLogText(ownerId || "unknown")}`);
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
        if (Object.hasOwn(metadata, key)) {
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

async function saveVoiceRuntimeState(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (!dbConnected) return false;

    try {
        const result = await SessionModel.updateOne(
            { sessionId },
            {
                $set: {
                    lifecycleGeneration: session.lifecycleGeneration || null,
                    voiceReadyAt: session.voiceReadyAt || null,
                    reconnectCount: Number(session.reconnectCount || 0),
                    tokenInvalid: session.tokenInvalid === true,
                    recoveryState: session.recoveryState || null,
                    notificationState: session.notificationState || null,
                    lastActivity: session.lastActivity || Date.now()
                }
            }
        );
        return (result?.matchedCount ?? result?.n ?? 0) > 0;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to save voice runtime state for ${sessionId}: ${sanitizeLifecycleError(err.message)}`);
        systemMetrics.increment("errors");
        return false;
    }
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
        const docs = await ApprovedGuildModel.find({})
            .select("guildId")
            .sort({ approvedAt: -1, _id: -1 })
            .limit(APPROVED_GUILDS_LOAD_MAX)
            .lean();
        return docs.map(d => d.guildId);
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load approved guilds: ${err.message}`);
        systemMetrics.increment("errors");
        return [];
    }
}

async function getApprovedGuildDocs(limit = APPROVED_GUILDS_LOAD_MAX) {
    if (!dbConnected) return [];

    try {
        return await ApprovedGuildModel.find({})
            .select("guildId approvedAt")
            .sort({ approvedAt: -1, _id: -1 })
            .limit(boundedLimit(limit, APPROVED_GUILDS_LOAD_MAX))
            .lean();
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load approved guild docs: ${err.message}`);
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
        return await PendingGuildModel.find({})
            .select("guildId guildName requestedBy requestedAt")
            .sort({ requestedAt: -1, _id: -1 })
            .limit(PENDING_GUILDS_LOAD_MAX)
            .lean();
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
const SNAPSHOT_CHUNK_MAX_BYTES = 512 * 1024;

function chunkSnapshotItems(items, maxBytes = SNAPSHOT_CHUNK_MAX_BYTES) {
    const chunks = [];
    let current = [];
    let currentBytes = 2;
    for (const item of Array.isArray(items) ? items : []) {
        const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
        if (itemBytes > maxBytes) throw new Error("SNAPSHOT_ITEM_TOO_LARGE");
        if (current.length && currentBytes + itemBytes > maxBytes) {
            chunks.push(current);
            current = [];
            currentBytes = 2;
        }
        current.push(item);
        currentBytes += itemBytes;
    }
    if (current.length || chunks.length === 0) chunks.push(current);
    return chunks;
}

async function saveChunkedSnapshot(snapshotId, guildId, backupOwnerId, data) {
    if (!dbConnected) return false;
    const normalizedGuildId = String(guildId);
    const oldSnapshot = await getLatestSnapshotForGuild(normalizedGuildId);
    const createdAt = Date.now();
    const kinds = ["roles", "channels"];
    const chunkMeta = {};
    try {
        for (const kind of kinds) {
            const source = Array.isArray(data?.[kind]) ? data[kind] : [];
            const chunks = chunkSnapshotItems(source);
            chunkMeta[kind] = { returnedCount: source.length, storedCount: 0, chunkCount: chunks.length, complete: false };
            for (let index = 0; index < chunks.length; index++) {
                const items = chunks[index];
                const byteSize = Buffer.byteLength(JSON.stringify(items), "utf8");
                await SnapshotChunkModel.create({ snapshotId, kind, chunkIndex: index, items, itemCount: items.length, byteSize, complete: true, createdAt });
                chunkMeta[kind].storedCount += items.length;
            }
            chunkMeta[kind].complete = chunkMeta[kind].storedCount === source.length;
            if (!chunkMeta[kind].complete) throw new Error("SNAPSHOT_CHUNK_INCOMPLETE");
        }
        const metadata = { ...data };
        delete metadata.roles;
        delete metadata.channels;
        await SnapshotModel.create({
            snapshotId,
            guildId: normalizedGuildId,
            Backup_Owner_ID: String(backupOwnerId),
            data: metadata,
            storageMode: "chunked",
            chunkMeta,
            complete: true,
            activationPending: true,
            active: false,
            createdAt
        });

        await SnapshotModel.updateMany(
            { guildId: normalizedGuildId, snapshotId: { $ne: snapshotId } },
            { $set: { active: false, supersededAt: createdAt, supersededBy: snapshotId } }
        );
        try {
            const activated = await SnapshotModel.updateOne(
                { snapshotId, complete: true, activationPending: true },
                { $set: { active: true, activationPending: false, supersededAt: null, supersededBy: null } }
            );
            if ((activated?.matchedCount ?? activated?.n ?? 0) !== 1) throw new Error("SNAPSHOT_ACTIVATION_FAILED");
        } catch (activationError) {
            if (oldSnapshot?.snapshotId) {
                await SnapshotModel.updateOne(
                    { snapshotId: oldSnapshot.snapshotId },
                    { $set: { active: true, supersededAt: null, supersededBy: null } }
                ).catch(() => null);
            }
            throw activationError;
        }
        return true;
    } catch (err) {
        await SnapshotChunkModel.deleteMany({ snapshotId }).catch(() => null);
        await SnapshotModel.deleteOne({ snapshotId, active: { $ne: true } }).catch(() => null);
        await reconcileSnapshotPointers().catch(() => null);
        console.error(`[DATABASE] ❌ Failed to save chunked snapshot: ${err.message}`);
        systemMetrics.increment("errors");
        return false;
    }
}

async function getLatestSnapshotForGuild(guildId) {
    const normalizedGuildId = String(guildId || "");
    if (!normalizedGuildId || !dbConnected) return null;
    const readable = { complete: { $ne: false }, activationPending: { $ne: true } };
    const active = await SnapshotModel.findOne({ guildId: normalizedGuildId, active: true, ...readable })
        .sort({ createdAt: -1, _id: -1 });
    if (active) return active;
    return SnapshotModel.findOne({ guildId: normalizedGuildId, ...readable })
        .sort({ createdAt: -1, _id: -1 });
}

async function reconcileSnapshotPointers() {
    if (!dbConnected) return { guilds: 0, activated: 0 };
    const guildIds = await SnapshotModel.distinct("guildId", { guildId: { $type: "string", $ne: "" } });
    let activated = 0;
    for (const guildId of guildIds) {
        const latest = await SnapshotModel.findOne({ guildId, complete: { $ne: false }, activationPending: { $ne: true } })
            .sort({ createdAt: -1, _id: -1 })
            .select("snapshotId")
            .lean();
        if (!latest) continue;
        const now = Date.now();
        await SnapshotModel.updateMany(
            { guildId, snapshotId: { $ne: latest.snapshotId } },
            { $set: { active: false, supersededAt: now, supersededBy: latest.snapshotId } }
        );
        await SnapshotModel.updateOne(
            { snapshotId: latest.snapshotId },
            { $set: { active: true, activationPending: false, supersededAt: null, supersededBy: null } }
        );
        activated++;
    }
    return { guilds: guildIds.length, activated };
}

async function loadSnapshotData(snapshot) {
    if (!snapshot) return null;
    const source = snapshot.toObject?.() || snapshot;
    if (source.storageMode !== "chunked") return source.data || null;
    if (!source.complete || !source.chunkMeta) return null;
    const data = { ...source.data };
    for (const kind of ["roles", "channels"]) {
        const meta = source.chunkMeta[kind];
        if (!meta?.complete || !Number.isInteger(meta.chunkCount) || meta.chunkCount < 1) return null;
        const docs = await SnapshotChunkModel.find({ snapshotId: source.snapshotId, kind }).sort({ chunkIndex: 1 }).lean();
        if (docs.length !== meta.chunkCount || docs.some((doc, index) => {
            const items = Array.isArray(doc.items) ? doc.items : [];
            return !doc.complete ||
                doc.chunkIndex !== index ||
                doc.itemCount !== items.length ||
                doc.byteSize !== Buffer.byteLength(JSON.stringify(items), "utf8");
        })) return null;
        data[kind] = docs.flatMap(doc => Array.isArray(doc.items) ? doc.items : []);
        if (data[kind].length !== meta.returnedCount || data[kind].length !== meta.storedCount) return null;
    }
    return data;
}

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

async function getPanelStates(limit = PANEL_STATES_LOAD_MAX) {
    if (!dbConnected) return [];

    try {
        return await PanelStateModel.find({})
            .select("guildId channelId messageId updatedAt")
            .sort({ updatedAt: -1, _id: -1 })
            .limit(boundedLimit(limit, PANEL_STATES_LOAD_MAX))
            .lean();
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load panel states: ${err.message}`);
        systemMetrics.increment("errors");
        return [];
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
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  ⚙️ REGION 15: BOT SETTINGS
// ════════════════════════════════════════════════════════════════════════════
async function setSetting(key, value) {
    if (!dbConnected) return false;

    try {
        const result = await BotSettingsModel.updateOne(
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
        if (result?.acknowledged === false) return false;
        if (shouldCacheSettingKey(key)) settingsCache.set(key, value);
        else settingsCache.delete(key);

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
        if (shouldCacheSettingKey(key)) settingsCache.set(key, doc.value);
        return doc.value;
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to get setting ${key}: ${err.message}`);
        systemMetrics.increment("errors");
        return fallback;
    }
}

async function getSettingStrict(key) {
    if (!dbConnected) throw new Error("DATABASE_NOT_CONNECTED");
    const doc = await BotSettingsModel.findOne({ key: String(key) }).lean();
    if (!doc) return { found: false, value: null };
    if (shouldCacheSettingKey(key)) settingsCache.set(String(key), doc.value);
    return { found: true, value: doc.value };
}

async function getLatestSettingByPrefix(prefix) {
    if (typeof prefix !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(prefix)) {
        throw new Error("INVALID_SETTING_PREFIX");
    }
    if (!dbConnected) throw new Error("DATABASE_NOT_CONNECTED");
    const docs = await BotSettingsModel.find()
        .where("key")
        .gte(prefix)
        .lt(`${prefix}\uffff`)
        .sort({ updatedAt: -1, _id: -1 })
        .limit(1)
        .lean();
    const doc = docs[0] || null;
    return doc ? { key: doc.key, value: doc.value, updatedAt: doc.updatedAt } : null;
}

async function deleteSetting(key) {
    if (!dbConnected) return false;

    try {
        const result = await BotSettingsModel.deleteOne({ key });
        if (result?.acknowledged === false) return false;
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
        const docs = await BotSettingsModel.find({
            $nor: [
                { key: RETIRED_ENTERPRISE_AUDIT_SETTINGS },
                { key: INTERNAL_EVENT_SETTINGS }
            ]
        })
            .select("key value updatedAt")
            .sort({ updatedAt: -1, _id: -1 })
            .limit(BOT_SETTINGS_LOAD_MAX)
            .lean();
        const result = {};

        for (const doc of docs) {
            const key = String(doc.key || "");
            if (isRetiredEnterpriseAuditSetting(key) || key.startsWith(INTERNAL_EVENT_PREFIX)) continue;
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

function getSessionDiagnostics() {
    const byState = {};
    let runnable = 0;
    let withClient = 0;
    let readyClients = 0;
    let withConnection = 0;
    let reconnecting = 0;

    for (const session of sessions.values()) {
        const state = session?.state || "active";
        byState[state] = (byState[state] || 0) + 1;
        if (isSessionRunnable(session)) runnable++;
        if (session?.client) withClient++;
        if (session?.client?.isReady?.()) readyClients++;
        if (session?.connection) withConnection++;
        if (session?.reconnecting) reconnecting++;
    }

    return {
        total: sessions.size,
        runnable,
        byState,
        withClient,
        readyClients,
        withConnection,
        reconnecting,
        lockedSessions: sessionLocks.size,
        reconnectTracking: reconnectTracking.size,
        pendingSessionDeletes: pendingSessionDeletes.size,
        settingsCache: settingsCache.size,
        limits: {
            sessionLoadMax: SESSION_LOAD_MAX,
            approvedGuildsLoadMax: APPROVED_GUILDS_LOAD_MAX,
            pendingGuildsLoadMax: PENDING_GUILDS_LOAD_MAX,
            botSettingsLoadMax: BOT_SETTINGS_LOAD_MAX,
            panelStatesLoadMax: PANEL_STATES_LOAD_MAX
        },
        lastLoad: lastLoadStats
    };
}

function getDatabaseStatus() {
    return {
        connected: dbConnected,
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host || null,
        name: mongoose.connection.name || null,
        pool: MONGO_POOL_CONFIG,
        models: mongoose.modelNames().length,
        loadLimits: {
            sessionLoadMax: SESSION_LOAD_MAX,
            approvedGuildsLoadMax: APPROVED_GUILDS_LOAD_MAX,
            pendingGuildsLoadMax: PENDING_GUILDS_LOAD_MAX,
            botSettingsLoadMax: BOT_SETTINGS_LOAD_MAX,
            panelStatesLoadMax: PANEL_STATES_LOAD_MAX
        }
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
    disconnectDB,
    loadDatabase,
    saveDatabase,
    getDatabaseStatus,
    getSessionDiagnostics,

    // Session CRUD
    createSession,
    getSession,
    touchSession,
    updateSessionMetadata,
    saveVoiceRuntimeState,
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
    getApprovedGuildDocs,
    isGuildApproved,
    approveGuild,
    removeApprovedGuild,
    addPendingGuild,
    getPendingGuilds,
    removePendingGuild,

    // Snapshots
    saveSnapshot,
    saveChunkedSnapshot,
    loadSnapshotData,
    getLatestSnapshotForGuild,
    reconcileSnapshotPointers,
    chunkSnapshotItems,
    getSnapshot,
    deleteSnapshot,

    // Panel state
    savePanelState,
    getPanelState,
    getPanelStates,
    deletePanelState,

    // Settings
    setSetting,
    getSetting,
    getSettingStrict,
    getLatestSettingByPrefix,
    getCachedSetting,
    deleteSetting,
    getAllSettings,

    // Metrics
    systemMetrics,
    getSystemMetrics,

    // Raw models for existing internal dashboards/tools
    SessionModel,
    SnapshotModel,
    SnapshotChunkModel,
    ApprovedGuildModel,
    PendingGuildModel,
    PanelStateModel,
    BotSettingsModel,

    // Encryption helpers kept for existing code paths
    encryptToken,
    decryptToken,

    _test: {
        shouldCacheSettingKey,
        INTERNAL_EVENT_SETTINGS,
        decryptTokenWithMetadata,
        isPlausiblePlaintext,
        migrateEncryptedToken
    }
};
