const mongoose = require("mongoose");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const config = require("./config.json");

const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();

// ════════════════════════════════════════════════════════════════
//  🔐  SECURITY: TOKEN ENCRYPTION & WEAKMAP
// ════════════════════════════════════════════════════════════════
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? 
    crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substring(0, 32) : 
    'default-key-change-me-32-chars!!';

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

const snapshotSchema = new mongoose.Schema({
    snapshotId: { type: String, required: true, unique: true },
    guildId: String,
    Backup_Owner_ID: String, 
    data: Object,
    createdAt: { type: Number, default: Date.now }
});
const SnapshotModel = mongoose.model("Snapshot", snapshotSchema);

const approvedGuildSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    approvedAt: { type: Number, default: Date.now }
});
const ApprovedGuildModel = mongoose.model("ApprovedGuild", approvedGuildSchema);

const pendingGuildSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    guildName: String,
    requestedBy: String,
    requestedAt: { type: Number, default: Date.now }
});
const PendingGuildModel = mongoose.model("PendingGuild", pendingGuildSchema);

function encryptToken(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(text) {
    if (!text) return null;
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
}

const systemMetrics = {
    requests: 0,
    errors: 0,
    reconnects: 0,
    uptime: Date.now(),
    increment(metric) { if (this[metric] !== undefined) this[metric]++; }
};

const actionLimiter = new Map();

let dbConnected = false;

// ════════════════════════════════════════════════════════════════
//  💾  DATABASE: DOUBLE-LAYER STORAGE (MONGODB + JSON)
// ════════════════════════════════════════════════════════════════
async function connectDB() {
    try {
        if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI");
        await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log("[DATABASE] ✅ Connected to MongoDB Atlas Successfully");
        dbConnected = true;
    } catch (err) {
        console.error("[DATABASE] ❌ MongoDB Connection failed, falling back to local JSON:", err.message);
        dbConnected = false;
    }
}

async function loadDatabase() {
    let loadedCount = 0;
    
    // โหลดจาก MongoDB เป็นหลัก
    if (dbConnected) {
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
                    client: null
                });
            }
            loadedCount = sessions.size;
            console.log(`[DATABASE] Loaded ${loadedCount} sessions from MongoDB.`);
            return;
        } catch (err) {
            console.error("[DATABASE] Failed to load from MongoDB, trying local file...", err.message);
        }
    }

    // ฟอลแบ็ก (Fallback) โหลดจาก JSON ฉุกเฉิน
    try {
        const dbPath = path.resolve(__dirname, config.system.databaseFile || "database.json");
        if (fs.existsSync(dbPath)) {
            const fileData = await fsPromises.readFile(dbPath, 'utf8');
            const parsed = JSON.parse(fileData);
            if (Array.isArray(parsed)) {
                for (const r of parsed) {
                    sessions.set(r.sessionId, { ...r, connection: null, reconnecting: false, client: null });
                }
                loadedCount = sessions.size;
                console.log(`[DATABASE] ⚠️ Loaded ${loadedCount} sessions from Local JSON File.`);
            }
        }
    } catch (err) {
        console.error("[DATABASE] ❌ Fatal error loading local DB:", err.message);
    }
}

async function saveDatabase() {
    if (dbConnected) {
        try {
            for (const [id, session] of sessions) {
                await SessionModel.updateOne(
                    { sessionId: id },
                    { 
                        $set: { 
                            token: session.token, serverId: session.serverId, 
                            voiceId: session.voiceId, serverName: session.serverName, 
                            tokenTail: session.tokenTail, ownerId: session.ownerId,
                            ownerAvatar: session.ownerAvatar, ownerTag: session.ownerTag,
                            lastActivity: session.lastActivity 
                        } 
                    },
                    { upsert: true }
                );
            }
        } catch (err) {
            console.error("[DATABASE] MongoDB save failed:", err.message);
        }
    }
    // สั่งบันทึกข้อมูลแบบคู่ขนาน (Double-Layer Backup)
    await createBackup();
}

async function createSession(token, serverId, voiceId, serverName, ownerId, ownerAvatar, ownerTag) {
    const tail = token.slice(-8);
    const sessionId = `${tail}_${serverId}`;
    if (sessions.has(sessionId)) throw new Error("ALREADY_ACTIVE");
    
    if (sessions.size >= config.limits.maxSessions) throw new Error("SYSTEM_LIMIT");

    const encryptedToken = encryptToken(token);
    const sessionData = {
        sessionId,
        token: encryptedToken,
        serverId,
        voiceId,
        serverName,
        tokenTail: tail,
        ownerId,
        ownerAvatar,
        ownerTag,
        startedAt: Date.now(),
        lastActivity: Date.now()
    };

    sessions.set(sessionId, { ...sessionData, connection: null, reconnecting: false, client: null });
    
    if (dbConnected) {
        try { await SessionModel.create(sessionData); } catch (e) {}
    }
    await createBackup(); 
    return sessionId;
}

function getSession(sessionId) {
    const s = sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
    return s;
}

function getAllSessions() {
    return sessions;
}

async function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.connection) {
        try { session.connection.destroy(); } catch {}
    }
    if (session.client) {
        try { session.client.destroy(); } catch {}
    }

    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);

    if (dbConnected) {
        try { await SessionModel.deleteOne({ sessionId }); } catch(e){}
    }
    await createBackup(); 
    return true;
}

async function pauseSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.connection) { try { session.connection.destroy(); } catch {} }
    sessionLocks.delete(sessionId);
    return true;
}

function addReconnect(sessionId) {
    const now = Date.now();
    let history = reconnectTracking.get(sessionId) || [];
    history = history.filter(t => now - t < 60000);
    history.push(now);
    reconnectTracking.set(sessionId, history);
    systemMetrics.increment('reconnects');
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

// ════════════════════════════════════════════════════════════════
//  🛡️  SYSTEM CRITICAL: ASYNC BACKUP (PREVENTS EVENT LOOP BLOCK)
// ════════════════════════════════════════════════════════════════
async function createBackup() {
    try {
        const dbPath = path.resolve(__dirname, config.system.databaseFile || "database.json");
        const exportData = [];
        for (const [id, session] of sessions) {
            exportData.push({
                sessionId: session.sessionId,
                token: session.token,
                serverId: session.serverId,
                voiceId: session.voiceId,
                serverName: session.serverName,
                tokenTail: session.tokenTail,
                ownerId: session.ownerId,
                ownerAvatar: session.ownerAvatar,
                ownerTag: session.ownerTag,
                startedAt: session.startedAt,
                lastActivity: session.lastActivity
            });
        }
        // ใช้ fsPromises เพื่อไม่ให้บล็อกการทำงานของเซิร์ฟเวอร์
        await fsPromises.writeFile(dbPath, JSON.stringify(exportData, null, 4), 'utf8');
    } catch (err) {
        console.error("[SYSTEM] ❌ Failed to create local backup:", err.message);
    }
}

async function sendAlert(message) {
    console.log(`[ALERT] 🔔 ${message}`);
}

module.exports = {
    connectDB, createSession, getSession, getAllSessions, deleteSession, pauseSession,
    addReconnect, clearReconnect, lockSession, unlockSession, isSessionLocked,
    systemMetrics, actionLimiter, loadDatabase, saveDatabase,
    getToken, decryptToken, createBackup, sendAlert,
    SessionModel, SnapshotModel, ApprovedGuildModel, PendingGuildModel
};

