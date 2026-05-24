/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE & ARCHITECTURE GUARD] ⚠️
ATTENTION AI ASSISTANT: DO NOT MODIFY, REFACTOR, OR SIMPLIFY THIS FILE.
1. [DATABASE]: MONGO_URI is the ONLY storage. Local JSON fallback is REMOVED.
2. [ENCRYPTION]: AES-256-CBC must remain intact. Do NOT simplify crypto logic.
3. [POOL]: keepAlive: true and maxPoolSize: 20 MUST remain in mongoose.connect().
4. [SCHEMAS]: Do NOT remove PanelStateModel, LogChannelMapModel, WhitelistModel, BotSettingsModel.
5. [METRICS]: increment() calls must remain for Dashboard accuracy.
================================================================================
*/

const mongoose = require("mongoose");
const crypto = require("crypto");
const config = require("./config.json");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 1: IN-MEMORY STATE
// ════════════════════════════════════════════════════════════════════════════
const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  🔐  REGION 2: ENCRYPTION (AES-256-CBC)
// ════════════════════════════════════════════════════════════════════════════
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?
    crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substring(0, 32) :
    'default-key-change-me-32-chars!!';

function encryptToken(text) {
    if (!text) return null;
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let encrypted = cipher.update(text, 'utf-8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    } catch (err) {
        console.error(`[SECURITY] ❌ Failed to encrypt token: ${err.message}`);
        return null;
    }
}

function decryptToken(text) {
    if (!text) return null;
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf-8');
        decrypted += decipher.final('utf-8');
        return decrypted;
    } catch (err) {
        console.error(`[SECURITY] ⚠️ Decryption failed (Possible key rotation or corrupted token): ${err.message}`);
        return null;
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
    increment(metric) { if (this[metric] !== undefined) this[metric]++; }
};

// ════════════════════════════════════════════════════════════════════════════
//  🗄️  REGION 4: MONGOOSE SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

// --- Session Schema ---
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    token: String,
    serverId: String,
    voiceId: String,
    serverName: String,
    tokenTail: String,
    ownerId: String,
    ownerAvatar: String,
    ownerTag: String,
    startedAt: { type: Number, default: Date.now },
    lastActivity: { type: Number, default: Date.now }
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
    scope: { type: String, default: 'say' }
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
//  🌐  REGION 5: DATABASE CONNECTION (เฟส 14: keepAlive + Pool)
// ════════════════════════════════════════════════════════════════════════════
let dbConnected = false;

mongoose.connection.on('connected', () => {
    console.log("[DATABASE] 🟢 MongoDB Connection Active.");
    dbConnected = true;
});
mongoose.connection.on('disconnected', () => {
    console.error("[DATABASE] 🔴 MongoDB Connection Lost.");
    dbConnected = false;
});
mongoose.connection.on('error', (err) => {
    console.error(`[DATABASE] ❌ MongoDB Error: ${err.message}`);
    dbConnected = false;
});

async function connectDB() {
    // เฟส 1: บังคับใช้ MONGO_URI เท่านั้น (ไม่มี fallback)
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
}
// ════════════════════════════════════════════════════════════════════════════
//  💾  REGION 6: SESSION LOAD (MongoDB Only — เฟส 10)
// ════════════════════════════════════════════════════════════════════════════
async function loadDatabase() {
    if (!dbConnected) {
        // เฟส 7: ถ้า DB ไม่พร้อม — boot sequence จะจัดการ ไม่ต้อง fallback
        console.error("[DATABASE] ⚠️ Cannot load sessions: DB not connected. Boot sequence will retry.");
        return;
    }
    try {
        const records = await SessionModel.find({});
        for (const r of records) {
            sessions.set(r.sessionId, {
                sessionId: r.sessionId,
                token: r.token,
                serverId: r.serverId,
                voiceId: r.voiceId,
                serverName: r.serverName,
                tokenTail: r.tokenTail,
                ownerId: r.ownerId,
                ownerAvatar: r.ownerAvatar,
                ownerTag: r.ownerTag,
                startedAt: r.startedAt,
                lastActivity: r.lastActivity,
                connection: null,
                reconnecting: false,
                client: null,
                reconnectCount: 0,
                tokenInvalid: false
            });
        }
        console.log(`[DATABASE] 📂 Loaded ${sessions.size} active sessions from MongoDB.`);
    } catch (err) {
        console.error(`[DATABASE] ❌ Failed to load sessions: ${err.message}`);
        throw err; // เฟส 24: boot sequence จะรับ error และ exit(1)
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  💾  REGION 7: SESSION CRUD
// ════════════════════════════════════════════════════════════════════════════
async function saveDatabase() {
    if (!dbConnected) return;
    try {
        if (sessions.size === 0) return;
        const ops = [];
        for (const [id, session] of sessions) {
            ops.push({
                updateOne: {
                    filter: { sessionId: id },
                    update: {
                        $set: {
                            token: session.token, serverId: session.serverId,
                            voiceId: session.voiceId, serverName: session.serverName,
                            tokenTail: session.tokenTail, ownerId: session.ownerId,
                            ownerAvatar: session.ownerAvatar, ownerTag: session.ownerTag,
                            lastActivity: session.lastActivity
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

async function createSession(token, serverId, voiceId, serverName, ownerId, ownerAvatar, ownerTag) {
    const tail = token.slice(-8);
    const sessionId = `${tail}_${serverId}_${ownerId}`;

    if (sessions.has(sessionId)) {
        console.log(`[SESSION] ⚠️ Blocked duplicate session: ${sessionId}`);
        throw new Error("ALREADY_ACTIVE");
    }
    if (sessions.size >= config.limits.maxSessions) {
        console.log(`[SESSION] ⛔ System limit reached for: ${ownerTag}`);
        throw new Error("SYSTEM_LIMIT");
    }

    const encryptedToken = encryptToken(token);
    const sessionData = {
        sessionId, token: encryptedToken, serverId, voiceId,
        serverName, tokenTail: tail, ownerId, ownerAvatar, ownerTag,
        startedAt: Date.now(), lastActivity: Date.now()
    };

    sessions.set(sessionId, { ...sessionData, connection: null, reconnecting: false, client: null, reconnectCount: 0, tokenInvalid: false });
    console.log(`[SESSION] ✅ Session created: ${sessionId} by ${ownerTag}`);
    systemMetrics.increment('requests');

    if (dbConnected) {
        try {
            await SessionModel.create(sessionData);
        } catch (e) {
            console.error(`[DATABASE] ❌ Failed to insert session ${sessionId}: ${e.message}`);
            systemMetrics.increment('errors');
        }
    }
    return sessionId;
}

function getSession(sessionId) {
    return sessions.get(sessionId) || null;
}

function touchSession(sessionId) {
    const s = sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
    return s;
}

function getAllSessions() { return sessions; }

async function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.connection) { try { session.connection.destroy(); } catch {} }

    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);

    console.log(`[SESSION] 🗑️ Session removed: ${sessionId}`);

    if (dbConnected) {
        try {
            await SessionModel.deleteOne({ sessionId });
        } catch (e) {
            console.error(`[DATABASE] ❌ Failed to delete session ${sessionId}: ${e.message}`);
            systemMetrics.increment('errors');
        }
    }
    return true;
}

async function pauseSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.connection) { try { session.connection.destroy(); } catch {} }
    sessionLocks.delete(sessionId);
    console.log(`[SESSION] ⏸️ Session paused: ${sessionId}`);
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  REGION 8: RECONNECT & LOCK MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════
function addReconnect(sessionId) {
    const now = Date.now();
    let history = reconnectTracking.get(sessionId) || [];
    history = history.filter(t => now - t < 60000);
    history.push(now);
    reconnectTracking.set(sessionId, history);
    systemMetrics.increment('reconnects');
    const s = sessions.get(sessionId);
    if (s) s.reconnectCount = (s.reconnectCount || 0) + 1;
    return history.length;
}

function clearReconnect(sessionId) { reconnectTracking.delete(sessionId); }
function lockSession(sessionId) {
    if (sessionLocks.has(sessionId)) return false;
    sessionLocks.add(sessionId);
    return true;
}
function unlockSession(sessionId) { sessionLocks.delete(sessionId); }
function isSessionLocked(sessionId) { return sessionLocks.has(sessionId); }
function getToken(sessionId) {
    const s = sessions.get(sessionId);
    return s ? decryptToken(s.token) : null;
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 9: BOT SETTINGS (Dashboard Config)
// ════════════════════════════════════════════════════════════════════════════
async function getSetting(key, defaultValue = null) {
    try {
        const doc = await BotSettingsModel.findOne({ key });
        return doc ? doc.value : defaultValue;
    } catch (err) {
        console.error(`[SETTINGS] ❌ getSetting failed for key "${key}": ${err.message}`);
        return defaultValue;
    }
}

async function setSetting(key, value) {
    try {
        await BotSettingsModel.updateOne(
            { key },
            { $set: { value, updatedAt: Date.now() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[SETTINGS] ❌ setSetting failed for key "${key}": ${err.message}`);
        systemMetrics.increment('errors');
    }
}

async function getAllSettings() {
    try {
        const docs = await BotSettingsModel.find({});
        const result = {};
        for (const doc of docs) result[doc.key] = doc.value;
        return result;
    } catch (err) {
        console.error(`[SETTINGS] ❌ getAllSettings failed: ${err.message}`);
        return {};
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔔  REGION 10: ALERT SYSTEM (เฟส 13: Global Crash Shield)
// ════════════════════════════════════════════════════════════════════════════
async function sendAlert(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [ALERT-${level.toUpperCase()}] 🔔 ${message}`;
    console.log(formattedMessage);

    // ส่งเข้า ALERT_WEBHOOK_URL สำหรับ crash/system critical
    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const { WebhookClient } = require("discord.js");
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            const emoji = level === 'CRITICAL' ? '🚨' : level === 'ERROR' ? '❌' : '🔔';
            await wh.send({
                content: `${emoji} **[SYSTEM ALERT - ${level.toUpperCase()}]**\n\`\`\`\n${formattedMessage}\n\`\`\``
            }).catch(() => {});
            wh.destroy();
        } catch (e) {
            // ถ้า webhook พัง ไม่ให้กระทบระบบหลัก
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  🔒  REGION 11: WHITELIST MANAGEMENT (เฟส 3: /say whitelist)
// ════════════════════════════════════════════════════════════════════════════
async function isWhitelisted(userId) {
    try {
        const doc = await WhitelistModel.findOne({ userId });
        return !!doc;
    } catch (err) {
        console.error(`[WHITELIST] ❌ isWhitelisted failed: ${err.message}`);
        return false;
    }
}

async function addWhitelist(userId, addedBy) {
    try {
        await WhitelistModel.updateOne(
            { userId },
            { $set: { addedBy, addedAt: Date.now(), scope: 'say' } },
            { upsert: true }
        );
        return true;
    } catch (err) {
        console.error(`[WHITELIST] ❌ addWhitelist failed: ${err.message}`);
        return false;
    }
}

async function removeWhitelist(userId) {
    try {
        await WhitelistModel.deleteOne({ userId });
        return true;
    } catch (err) {
        console.error(`[WHITELIST] ❌ removeWhitelist failed: ${err.message}`);
        return false;
    }
}

async function getAllWhitelist() {
    try {
        return await WhitelistModel.find({});
    } catch (err) {
        console.error(`[WHITELIST] ❌ getAllWhitelist failed: ${err.message}`);
        return [];
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📌  REGION 12: PANEL STATE (เฟส 2: Panel Persistence)
// ════════════════════════════════════════════════════════════════════════════
async function savePanelState(guildId, channelId, messageId) {
    try {
        await PanelStateModel.updateOne(
            { guildId },
            { $set: { channelId, messageId, updatedAt: Date.now() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[PANEL] ❌ savePanelState failed: ${err.message}`);
    }
}

async function getPanelState(guildId) {
    try {
        return await PanelStateModel.findOne({ guildId });
    } catch (err) {
        console.error(`[PANEL] ❌ getPanelState failed: ${err.message}`);
        return null;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📋  REGION 13: LOG CHANNEL MAP (เฟส 25: Audit Logging)
// ════════════════════════════════════════════════════════════════════════════
async function saveLogChannelMap(guildId, channels) {
    try {
        await LogChannelMapModel.updateOne(
            { guildId },
            { $set: { ...channels, updatedAt: Date.now() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[AUDIT] ❌ saveLogChannelMap failed: ${err.message}`);
    }
}

async function setLogChannelMap(guildId, category, channelId) {
    const keyMap = {
        message:  'messageChannelId',
        member:   'memberChannelId',
        voice:    'voiceChannelId',
        server:   'serverChannelId',
        security: 'securityChannelId'
    };
    const key = keyMap[category];
    if (!key) return;
    try {
        await LogChannelMapModel.updateOne(
            { guildId },
            { $set: { [key]: channelId, updatedAt: Date.now() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[AUDIT] ❌ setLogChannelMap failed: ${err.message}`);
        systemMetrics.increment('errors');
    }
}

async function getLogChannelMap(guildId) {
    try {
        return await LogChannelMapModel.findOne({ guildId });
    } catch (err) {
        console.error(`[AUDIT] ❌ getLogChannelMap failed: ${err.message}`);
        return null;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  REGION 14: EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
    // DB Connection
    connectDB, loadDatabase, saveDatabase,

    // Session Management
    createSession, getSession, getAllSessions, deleteSession, pauseSession,

    // Reconnect & Lock
    addReconnect, clearReconnect, lockSession, unlockSession, isSessionLocked,

    // Token
    getToken, decryptToken,

    // Metrics
    systemMetrics,

    // Alerts
    sendAlert,

    // Settings (Dashboard)
    getSetting, setSetting, getAllSettings,

    // Whitelist
    isWhitelisted, addWhitelist, removeWhitelist, getAllWhitelist,

    // Panel State
    savePanelState, getPanelState,

    // Log Channel Map
    saveLogChannelMap, setLogChannelMap, getLogChannelMap,

    // Session Touch (explicit lastActivity update)
    touchSession,

    // Models (ใช้ใน index.js + commands.js)
    SessionModel, SnapshotModel, ApprovedGuildModel, PendingGuildModel,
    PanelStateModel, LogChannelMapModel, WhitelistModel, BotSettingsModel
};
