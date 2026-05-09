const fs = require("fs").promises;
const config = require("./config.json");

const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();

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
        const userReqs = this.requests.get(key) ||[];
        const validReqs = userReqs.filter(time => now - time < this.window);
        if (validReqs.length >= this.max) return false;
        validReqs.push(now);
        this.requests.set(key, validReqs);
        return true;
    }
}
const actionLimiter = new RateLimiter(config.limits.rateLimitRequests, config.limits.rateLimitWindowMs);

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
            token: s.token,
            serverId: s.serverId,
            voiceId: s.voiceId,
            startedAt: s.startedAt
        }));
        await fs.writeFile(config.system.databaseFile, JSON.stringify(data, null, 2));
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
        return[];
    }
}

function createSession(sessionId, data) {
    if (sessions.has(sessionId)) return false;
    sessions.set(sessionId, { ...data, createdAt: Date.now(), lastActivity: Date.now() });
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

    if (session.connection) {
        try { session.connection.destroy(); } catch {}
    }
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);
    saveDatabase();
    return true;
}

function addReconnect(sessionId) {
    const now = Date.now();
    let history = reconnectTracking.get(sessionId) ||[];
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
    systemMetrics, actionLimiter, loadDatabase, saveDatabase
};