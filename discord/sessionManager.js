const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const config = require("./config.json");

const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  🔐  SECURITY: TOKEN ENCRYPTION & WEAKMAP
// ════════════════════════════════════════════════════════════════════════════
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? 
    crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substring(0, 32) : 
    'default-key-change-me-32-chars!!';

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

// ════════════════════════════════════════════════════════════════════════════
//  📊  METRICS & RATE LIMITER
// ════════════════════════════════════════════════════════════════════════════
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
            if (valid.length === 0) {
                this.requests.delete(key);
            } else {
                this.requests.set(key, valid);
            }
        }
    }
}
const actionLimiter = new RateLimiter(config.limits.rateLimitRequests, config.limits.rateLimitWindowMs);

// ════════════════════════════════════════════════════════════════════════════
//  💾  PERSISTENCE (ATOMIC DATABASE & BACKUP)
// ════════════════════════════════════════════════════════════════════════════
let isSaving = false;
let pendingSave = false;

async function saveDatabase() {
    if (isSaving) {
        pendingSave = true;
        return;
    }
    isSaving = true;
    try {
        const data = [...sessions.values()].map(s => ({
            token: encryptToken(getToken(s)),
            serverId: s.serverId,
            voiceId: s.voiceId,
            startedAt: s.startedAt
        }));

        const tempFile = config.system.databaseFile + '.tmp';
        await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
        await fs.rename(tempFile, config.system.databaseFile);
    } catch (err) {
        console.error("[DATABASE] Save error:", err.message);
    } finally {
        isSaving = false;
        if (pendingSave) {
            pendingSave = false;
            saveDatabase();
        }
    }
}

async function loadDatabase() {
    try {
        const data = await fs.readFile(config.system.databaseFile, "utf8");
        return JSON.parse(data);
    } catch {
        return [];
    }
}

const MAX_BACKUPS = 24;
async function createBackup() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = `./backups/database-${timestamp}.json`;

        await fs.mkdir('./backups', { recursive: true });
        await fs.copyFile(config.system.databaseFile, backupFile);
        console.log(`[BACKUP] Created: ${backupFile}`);

        const backups = await fs.readdir('./backups');
        const sorted = backups.filter(f => f.startsWith('database-')).sort().reverse();

        for (let i = MAX_BACKUPS; i < sorted.length; i++) {
            await fs.unlink(`./backups/${sorted[i]}`);
            console.log(`[BACKUP] Deleted old backup: ${sorted[i]}`);
        }
    } catch (err) {
        console.error('[BACKUP] Error:', err.message);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  📢  NOTIFICATION SYSTEM
// ════════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════════
//  📝  CORE SESSION OPERATIONS
// ════════════════════════════════════════════════════════════════════════════
function createSession(sessionId, data, token) {
    if (sessions.has(sessionId)) return false;
    sessions.set(sessionId, { ...data, createdAt: Date.now(), lastActivity: Date.now() });
    storeToken(sessions.get(sessionId), token);
    saveDatabase();
    return true;
}

function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
    return session ?? null;
}

function getAllSessions() { return sessions; }

function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }

    if (session.connection) {
        try { session.connection.destroy(); } catch {}
    }

    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);
    saveDatabase();
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
    createSession, getSession, getAllSessions, deleteSession,
    addReconnect, clearReconnect, lockSession, unlockSession, isSessionLocked,
    systemMetrics, actionLimiter, loadDatabase, saveDatabase,
    getToken, decryptToken, createBackup, sendAlert
};