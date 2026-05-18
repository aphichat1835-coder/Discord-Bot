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

// Schema สำหรับบันทึกข้อมูลการใช้งานช่องเสียงของบัญชีผู้ใช้
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

// Schema สำหรับบันทึกข้อมูลโครงสร้างเซิร์ฟเวอร์ (Backup & Restore)
const snapshotSchema = new mongoose.Schema({
    snapshotId: { type: String, required: true, unique: true },
    guildId: String,
    Backup_Owner_ID: String, 
    data: Object,
    createdAt: { type: Number, default: Date.now }
});
const SnapshotModel = mongoose.model("Snapshot", snapshotSchema);

// Schema สำหรับบันทึกเซิร์ฟเวอร์ที่ได้รับการอนุมัติให้ใช้งานบอท
const approvedGuildSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    approvedAt: { type: Number, default: Date.now }
});
const ApprovedGuildModel = mongoose.model("ApprovedGuild", approvedGuildSchema);

// Schema สำหรับบันทึกคิวเซิร์ฟเวอร์ที่รอการอนุมัติ
const pendingGuildSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    guildName: String,
    requestedBy: String,
    requestedAt: { type: Number, default: Date.now }
});
const PendingGuildModel = mongoose.model("PendingGuild", pendingGuildSchema);

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
        // [V4.8 SRE HARDENING]: ป้องกันบอทแครชกรณี Key Rotation หรือ Token เสียหาย
        console.error(`[SECURITY] ⚠️ Decryption failed (Possible key rotation or corrupted token): ${err.message}`);
        return null;
    }
}

const systemMetrics = {
    requests: 0,
    errors: 0,
    reconnects: 0,
    uptime: Date.now(),
    increment(metric) { if (this[metric] !== undefined) this[metric]++; }
};

let dbConnected = false;

// ════════════════════════════════════════════════════════════════
//  💾  DATABASE: DOUBLE-LAYER STORAGE & REAL-TIME MONITORING
// ════════════════════════════════════════════════════════════════

// [V4.8 SRE HARDENING]: ดักจับ Event ของ MongoDB แบบ Real-time เพื่ออัปเดตสถานะการเชื่อมต่อทันที
mongoose.connection.on('connected', () => {
    console.log("[DATABASE] 🟢 MongoDB Connection Restored / Active.");
    dbConnected = true;
});

mongoose.connection.on('disconnected', () => {
    console.error("[DATABASE] 🔴 MongoDB Connection Lost. System automatically falling back to Local Storage.");
    dbConnected = false;
});

mongoose.connection.on('error', (err) => {
    console.error(`[DATABASE] ❌ MongoDB Connection Error Detected: ${err.message}`);
    dbConnected = false;
});

async function connectDB() {
    try {
        if (!process.env.MONGODB_URI) {
            throw new Error("Missing MONGODB_URI Environment Variable");
        }
        await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        dbConnected = true;
    } catch (err) {
        // Structured Audit Trail
        console.error(`[DATABASE] ❌ MongoDB Connection failed on startup. Reason: ${err.message}. System is falling back to Local JSON Storage.`);
        dbConnected = false;
    }
}

async function loadDatabase() {
    let loadedCount = 0;
    
    // พยายามโหลดจาก MongoDB เป็นลำดับแรกเพื่อความสดใหม่ของข้อมูลระดับคลัสเตอร์
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
            console.log(`[DATABASE] 📂 Loaded ${loadedCount} active sessions from MongoDB Cloud.`);
            return; // สำเร็จแล้วให้ออกเลย ไม่ต้องไปอ่านไฟล์ JSON ให้ซ้ำซ้อน
        } catch (err) {
            console.error(`[DATABASE] ⚠️ Failed to load sessions from MongoDB (Reason: ${err.message}). Triggering Emergency Local Fallback...`);
        }
    }

    // ฟอลแบ็ก (Fallback) ฉุกเฉิน: โหลดจาก JSON ในเครื่องเพื่อป้องกันระบบล่ม
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
                console.log(`[DATABASE] ⚠️ Emergency Recovery: Loaded ${loadedCount} sessions from Local JSON File.`);
            }
        } else {
            console.log("[DATABASE] ℹ️ No local database.json found. Starting with empty memory state.");
        }
    } catch (err) {
        console.error(`[DATABASE] ❌ Fatal error during Emergency Recovery loading local DB: ${err.message}`);
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
            console.error(`[DATABASE] ❌ MongoDB save operation failed: ${err.message}`);
        }
    }
    // สั่งบันทึกข้อมูลแบบคู่ขนานลง Local JSON เพื่อความปลอดภัยชั้นที่สอง
    await createBackup();
}

async function createSession(token, serverId, voiceId, serverName, ownerId, ownerAvatar, ownerTag) {
    const tail = token.slice(-8);
    const sessionId = `${tail}_${serverId}`;
    if (sessions.has(sessionId)) {
        console.log(`[SESSION] ⚠️ Blocked duplicate session creation attempt for ID: ${sessionId}`);
        throw new Error("ALREADY_ACTIVE");
    }
    
    if (sessions.size >= config.limits.maxSessions) {
        console.log(`[SESSION] ⛔ System limit reached. Cannot create session for: ${ownerTag}`);
        throw new Error("SYSTEM_LIMIT");
    }

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
    console.log(`[SESSION] ✅ Session created successfully for ID: ${sessionId} by User: ${ownerTag}`);
    
    if (dbConnected) {
        try { 
            await SessionModel.create(sessionData); 
        } catch (e) {
            console.error(`[DATABASE] ❌ Failed to insert session ${sessionId} into MongoDB: ${e.message}`);
        }
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

    console.log(`[SESSION] 🗑️ Session removed from memory: ${sessionId}`);

    if (dbConnected) {
        try { 
            await SessionModel.deleteOne({ sessionId }); 
        } catch(e) {
            console.error(`[DATABASE] ❌ Failed to delete session ${sessionId} from MongoDB: ${e.message}`);
        }
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
    console.log(`[SESSION] ⏸️ Session paused manually: ${sessionId}`);
    return true;
}

function addReconnect(sessionId) {
    const now = Date.now();
    let history = reconnectTracking.get(sessionId) || [];
    history = history.filter(t => now - t < 60000); // เก็บเฉพาะรอบที่หลุดใน 1 นาทีล่าสุด
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
//  🛡️  SYSTEM CRITICAL: ATOMIC BACKUP (PREVENTS FILE CORRUPTION)
// ════════════════════════════════════════════════════════════════
async function createBackup() {
    try {
        const dbPath = path.resolve(__dirname, config.system.databaseFile || "database.json");
        const tmpPath = `${dbPath}.tmp`; // สร้างไฟล์ชั่วคราวเพื่อรับประกันการเขียนข้อมูลสมบูรณ์
        
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
        
        // [V4.8 GOD-TIER FIX]: Atomic Write Pattern
        // 1. เขียนข้อมูลทั้งหมดลงไฟล์ชั่วคราวก่อน (ถ้าเซิร์ฟดับตอนนี้ ไฟล์หลักก็ยังปลอดภัย)
        await fsPromises.writeFile(tmpPath, JSON.stringify(exportData, null, 4), 'utf8');
        
        // 2. ย้าย/เขียนทับไฟล์ชั่วคราวเป็นไฟล์จริง ซึ่งการทำงานนี้จะเกิดขึ้นแบบ Atomic ทันที
        await fsPromises.rename(tmpPath, dbPath);
        
        // ไม่สั่ง console.log ตรงนี้เพื่อป้องกันการสแปมล็อกทุก 30 วินาทีใน Cron
    } catch (err) {
        console.error(`[STORAGE] ❌ Fatal error during local Atomic Backup creation: ${err.message}`);
    }
}

// [V4.8 SRE HARDENING]: Structured Audit Trail
async function sendAlert(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [ALERT-${level.toUpperCase()}] 🔔 ${message}`;
    console.log(formattedMessage);
    // จุดเชื่อมต่อ Webhook สำหรับระบบ Monitor ในอนาคต
}

module.exports = {
    connectDB, createSession, getSession, getAllSessions, deleteSession, pauseSession,
    addReconnect, clearReconnect, lockSession, unlockSession, isSessionLocked,
    systemMetrics, loadDatabase, saveDatabase,
    getToken, decryptToken, createBackup, sendAlert,
    SessionModel, SnapshotModel, ApprovedGuildModel, PendingGuildModel
};

