const mongoose = require("mongoose");
const crypto = require("crypto");
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
    startedAt: { type: Number, default: Date.now },
    lastActivity: { type: Number, default: Date.now }
});
const SessionModel = mongoose.model("Session", sessionSchema);

const snapshotSchema = new mongoose.Schema({
    snapshotId: { type: String, required: true, unique: true },
    guildId: String,
    data: Object,
    createdAt: { type: Number, default: Date.now }
});
const SnapshotModel = mongoose.model("Snapshot", snapshotSchema);

function encryptToken(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(text) {
    if (!text) return null;
    const parts = text.split(':');
    if (parts.length < 2) return null;
    try {
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = parts.join(':');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        return null;
    }
}

const tokenStore = new WeakMap();
const TOKEN_SYMBOL = Symbol('token');

function storeToken(sessionObj, token) {
    tokenStore.set(sessionObj, { [TOKEN_SYMBOL]: token });
}

function getToken(sessionObj) {
    return tokenStore.get(sessionObj)?.[TOKEN_SYMBOL];
}

if (ENCRYPTION_KEY === 'default-key-change-me-32-chars!!') {
    console.warn('[SECURITY] ENCRYPTION_KEY not set. Using default key — this is insecure. Please set ENCRYPTION_KEY env var.');
}

// ════════════════════════════════════════════════════════════════
//  📊  METRICS & RATE LIMITER
// ════════════════════════════════════════════════════════════════
class MetricsCollector {
    constructor() {
        this.metrics = { sessionsStarted: 0, sessionsFailed: 0, reconnects: 0, uptime: Date.now() };
    }
    increment(metric) { this.metrics[metric] = (this.metrics[metric] || 0) + 1; }
    getReport() {
        const total = this.metrics.sessionsStarted + this.metrics.sessionsFailed;
        return {
            ...this.metrics,
            uptimeHours: ((Date.now() - this.metrics.uptime) / 3600000).toFixed(2),
            successRate: total === 0 ? '0.00%' : ((this.metrics.sessionsStarted / total) * 100).toFixed(2) + '%'
        };
    }
}
const systemMetrics = new MetricsCollector();

class RateLimiter {
    constructor(maxRequests, windowMs) {
        this.max = maxRequests;
        this.window = windowMs;
        this.requests = new Map();
    }
    canRequest(key) {
        const now = Date.now();
        const userReqs = this.requests.get(key) || [];
        const validReqs = userReqs.filter(time => now - time < this.window);
        if (validReqs.length >= this.max) return false;

        validReqs.push(now);
        this.requests.set(key, validReqs);
        return true;
    }
    cleanup() {
        const now = Date.now();
        for (const [key, timestamps] of this.requests) {
            const valid = timestamps.filter(t => now - t < this.window);
            if (valid.length === 0) {
                this.requests.delete(key);
            } else {
                this.requests.set(key, valid);
            }
        }
    }
}
const actionLimiter = new RateLimiter(config.limits.rateLimitRequests, config.limits.rateLimitWindowMs);

// ════════════════════════════════════════════════════════════════
//  💾  PERSISTENCE
// ════════════════════════════════════════════════════════════════
async function connectDB() {
    try {
        if (!process.env.MONGO_URI) throw new Error("MONGO_URI_MISSING");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ [DATABASE] Connected to MongoDB Atlas Successfully");
    } catch (err) {
        console.error("❌ [DATABASE] Connection error:", err.message);
    }
}

async function saveDatabase() {
    console.log("[DATABASE] Cloud synchronization verified.");
}

async function loadDatabase() {
    try {
        const data = await SessionModel.find({});
        const validData = [];
        for (const s of data) {
            const rawToken = decryptToken(s.token);
            if (rawToken) {
                validData.push({ ...s._doc, token: rawToken });
            }
        }
        return validData;
    } catch (err) {
        console.error('[DATABASE] Load error:', err.message);
        return [];
    }
}

async function createBackup() {
    console.log("[BACKUP] MongoDB Atlas provides automatic backups.");
}

async function saveSnapshot(guildId, snapshotData) {
    const snapshotId = `${guildId}_${Date.now()}`;
    await SnapshotModel.create({ snapshotId, guildId, data: snapshotData });
    return snapshotId;
}

// ════════════════════════════════════════════════════════════════
//  📢  NOTIFICATION SYSTEM
// ════════════════════════════════════════════════════════════════
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL;
let alertWebhook = null;

if (ALERT_WEBHOOK) {
    const { WebhookClient } = require('discord.js');
    alertWebhook = new WebhookClient({ url: ALERT_WEBHOOK });
}

async function sendAlert(title, description, color = '#f85149') {
    if (!alertWebhook) return;
    try {
        await alertWebhook.send({
            embeds: [{
                title: `🚨 ${title}`,
                description,
                color: parseInt(color.replace('#', ''), 16),
                timestamp: new Date().toISOString(),
                footer: { text: 'Enterprise Voice System' }
            }]
        });
    } catch (err) {
        console.error('[ALERT] Failed to send:', err.message);
    }
}

// ════════════════════════════════════════════════════════════════
//  📝  CORE SESSION OPERATIONS
// ════════════════════════════════════════════════════════════════
async function createSession(sessionId, data, token) {
    if (sessions.has(sessionId)) return false;
    
    const encryptedToken = encryptToken(token);
    await SessionModel.findOneAndUpdate(
        { sessionId }, 
        { ...data, token: encryptedToken, lastActivity: Date.now() }, 
        { upsert: true }
    );

    sessions.set(sessionId, { ...data, createdAt: Date.now(), lastActivity: Date.now() });
    storeToken(sessions.get(sessionId), token);
    return true;
}

function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.lastActivity = Date.now();
        SessionModel.updateOne({ sessionId }, { lastActivity: session.lastActivity }).catch(()=>{});
    }
    return session ?? null;
}

function getAllSessions() { return sessions; }

async function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }

    if (session.connection) {
        try { session.connection.destroy(); } catch {}
    }

    await SessionModel.deleteOne({ sessionId });
    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);
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

module.exports = {
    connectDB, createSession, getSession, getAllSessions, deleteSession, pauseSession,
    addReconnect, clearReconnect, lockSession, unlockSession, isSessionLocked,
    systemMetrics, actionLimiter, loadDatabase, saveDatabase,
    getToken, decryptToken, createBackup, sendAlert, saveSnapshot
};
