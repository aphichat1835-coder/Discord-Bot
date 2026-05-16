const mongoose = require("mongoose");
const crypto = require("crypto");
const config = require("./config.json");

const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();

// ════════════════════════════════════════════════════════════════
//  🔐  SECURITY: TOKEN ENCRYPTION & WEAKMAP (คงเดิม 100%)
// ════════════════════════════════════════════════════════════════
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? 
    crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substring(0, 32) : 
    'default-key-change-me-32-chars!!';

// MongoDB Schema
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    token: String,
    serverId: String,
    voiceId: String,
    serverName: String,
    tokenTail: String,
    startedAt: { type: Number, default: Date.now }
});
const SessionModel = mongoose.model("Session", sessionSchema);

function encryptToken(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(text) {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
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
    console.warn('[SECURITY] ENCRYPTION_KEY not set. Using default key — this is insecure.');
}

// ════════════════════════════════════════════════════════════════
//  📊  METRICS & RATE LIMITER (คงเดิม 100%)
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
    canRequest(key, secondaryKey = null) {
        const now = Date.now();
        const keys = secondaryKey ? [key, secondaryKey, `${key}:${secondaryKey}`] : [key];
        for (const k of keys) {
            const userReqs = this.requests.get(k) || [];
            const validReqs = userReqs.filter(time => now - time < this.window);
            if (validReqs.length >= this.max) return false;
        }
        for (const k of keys) {
            const userReqs = this.requests.get(k) || [];
            const validReqs = userReqs.filter(time => now - time < this.window);
            validReqs.push(now);
            this.requests.set(k, validReqs);
        }
        return true;
    }
    cleanup() {
        const now = Date.now();
        for (const [key, timestamps] of this.requests) {
            const valid = timestamps.filter(t => now - t < this.window);
            if (valid.length === 0) this.requests.delete(key);
            else this.requests.set(key, valid);
        }
    }
}
const actionLimiter = new RateLimiter(config.limits.rateLimitRequests, config.limits.rateLimitWindowMs);

// ════════════════════════════════════════════════════════════════
//  💾  PERSISTENCE (MONGODB VERSION)
// ════════════════════════════════════════════════════════════════
async function connectDB() {
    try {
        if (!process.env.MONGO_URI) throw new Error("MONGO_URI_MISSING");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ [DATABASE] Connected to MongoDB Atlas");
    } catch (err) {
        console.error("❌ [DATABASE] Connection error:", err.message);
    }
}

async function saveDatabase() {
    // ในระบบ MongoDB เราบันทึกทันทีที่สร้างเซสชัน ฟังก์ชันนี้จึงทำหน้าที่เป็นตัวยืนยันสถานะ
    console.log("[DATABASE] Cloud Sync Complete");
}

async function loadDatabase() {
    try {
        const data = await SessionModel.find({});
        return data.map(s => ({
            ...s._doc,
            token: decryptToken(s.token)
        }));
    } catch (err) {
        console.error('[DATABASE] Load error:', err.message);
        return [];
    }
}

async function createBackup() {
    console.log("[BACKUP] MongoDB Atlas provides automatic backups.");
}

// ════════════════════════════════════════════════════════════════
//  📢  NOTIFICATION SYSTEM (คงเดิม 100%)
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
    } catch (err) { console.error('[ALERT] Failed to send:', err.message); }
}

// ════════════════════════════════════════════════════════════════
//  📝  CORE SESSION OPERATIONS (คงเดิม 100%)
// ════════════════════════════════════════════════════════════════
async function createSession(sessionId, data, token) {
    if (sessions.has(sessionId)) return false;
    
    // บันทึกลง MongoDB
    const encryptedToken = encryptToken(token);
    await SessionModel.findOneAndUpdate(
        { sessionId }, 
        { ...data, token: encryptedToken }, 
        { upsert: true }
    );

    sessions.set(sessionId, { ...data, createdAt: Date.now(), lastActivity: Date.now() });
    storeToken(sessions.get(sessionId), token);
    return true;
}

function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
    return session ?? null;
}

function getAllSessions() { return sessions; }

async function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.connection) try { session.connection.destroy(); } catch {}
    
    await SessionModel.deleteOne({ sessionId });
    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
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
function lockSession(sessionId) { if (sessionLocks.has(sessionId)) return false; sessionLocks.add(sessionId); return true; }
function unlockSession(sessionId) { sessionLocks.delete(sessionId); }
function isSessionLocked(sessionId) { return sessionLocks.has(sessionId); }

module.exports = {
    connectDB, createSession, getSession, getAllSessions, deleteSession,
    addReconnect, clearReconnect, lockSession, unlockSession, isSessionLocked,
    systemMetrics, actionLimiter, loadDatabase, saveDatabase,
    getToken, decryptToken, createBackup, sendAlert
};
