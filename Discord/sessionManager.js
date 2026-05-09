// ════════════════════════════════════════════════════════════════════════════
//  🧠  SESSION MANAGER  —  ENTERPRISE EDITION
// ════════════════════════════════════════════════════════════════════════════
//  คลังจัดการข้อมูลเซสชันแบบ Thread-Safe พร้อมระบบป้องกัน Memory Leak
// ════════════════════════════════════════════════════════════════════════════

const sessions = new Map();
const reconnectTracking = new Map();
const sessionLocks = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  📊  METRICS COLLECTOR (ระบบเก็บสถิติ)
// ════════════════════════════════════════════════════════════════════════════
class MetricsCollector {
    constructor() {
        this.metrics = {
            sessionsStarted: 0,
            sessionsFailed: 0,
            reconnects: 0,
            uptime: Date.now(),
        };
    }

    increment(metric) {
        this.metrics[metric] = (this.metrics[metric] || 0) + 1;
    }

    getReport() {
        const total = this.metrics.sessionsStarted + this.metrics.sessionsFailed;
        return {
            ...this.metrics,
            uptimeHours: ((Date.now() - this.metrics.uptime) / 3600000).toFixed(2),
            successRate: total === 0 ? '0.00%' : ((this.metrics.sessionsStarted / total) * 100).toFixed(2) + '%',
        };
    }
}
const systemMetrics = new MetricsCollector();

// ════════════════════════════════════════════════════════════════════════════
//  📝  CORE SESSION OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * สร้างเซสชันใหม่ในระบบ
 * @param {string} sessionId - รหัสเซสชันเฉพาะ
 * @param {Object} data - ข้อมูลเซสชัน
 */
function createSession(sessionId, data) {
    if (sessions.has(sessionId)) {
        console.warn(`⚠️  [SESSION] Duplicate session creation attempt: ${sessionId}`);
        return false;
    }

    sessions.set(sessionId, {
        ...data,
        createdAt: Date.now(),
        lastActivity: Date.now(),
    });

    console.log(`✅ [SESSION] Created: ${sessionId}`);
    return true;
}

/**
 * ดึงข้อมูลเซสชัน
 * @param {string} sessionId - รหัสเซสชัน
 * @returns {Object|null} ข้อมูลเซสชัน หรือ null ถ้าไม่พบ
 */
function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.lastActivity = Date.now();
    }
    return session ?? null;
}

/**
 * ดึงข้อมูลเซสชันทั้งหมด
 * @returns {Map} Map ของเซสชันทั้งหมด
 */
function getAllSessions() {
    return sessions;
}

/**
 * ลบเซสชันออกจากระบบ พร้อม Cleanup
 * @param {string} sessionId - รหัสเซสชัน
 */
function deleteSession(sessionId) {
    if (!sessions.has(sessionId)) {
        console.warn(`⚠️  [SESSION] Delete attempt on non-existent session: ${sessionId}`);
        return false;
    }

    const session = sessions.get(sessionId);

    // Cleanup connection
    if (session?.connection) {
        try {
            session.connection.destroy();
        } catch (err) {
            console.error(`❌ [SESSION] Connection cleanup error: ${err.message}`);
        }
    }

    // Cleanup bot instance
    if (session?.bot) {
        try {
            session.bot.removeAllListeners();
            session.bot.destroy();
        } catch (err) {
            console.error(`❌ [SESSION] Bot cleanup error: ${err.message}`);
        }
    }

    // Clear timers
    if (session?.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
    }

    sessions.delete(sessionId);
    reconnectTracking.delete(sessionId);
    sessionLocks.delete(sessionId);

    console.log(`✅ [SESSION] Deleted: ${sessionId}`);
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔄  RECONNECT TRACKING SYSTEM
// ════════════════════════════════════════════════════════════════════════════

/**
 * บันทึกการ Reconnect และคืนจำนวนครั้งใน 60 วินาที
 * @param {string} sessionId - รหัสเซสชัน
 * @returns {number} จำนวนครั้งที่ Reconnect ใน 60 วินาทีล่าสุด
 */
function addReconnect(sessionId) {
    const now = Date.now();
    const WINDOW = 60_000; // 60 seconds

    let history = reconnectTracking.get(sessionId) ||[];
    history = history.filter((timestamp) => now - timestamp < WINDOW);
    history.push(now);

    reconnectTracking.set(sessionId, history);
    systemMetrics.increment('reconnects'); // เก็บสถิติ

    console.log(`📊 [RECONNECT] Session ${sessionId}: ${history.length} attempts in last 60s`);
    return history.length;
}

/**
 * ล้างประวัติการ Reconnect
 * @param {string} sessionId - รหัสเซสชัน
 */
function clearReconnect(sessionId) {
    reconnectTracking.delete(sessionId);
    console.log(`🧹 [RECONNECT] Cleared history for session ${sessionId}`);
}

/**
 * ดูจำนวนครั้งการ Reconnect โดยไม่เพิ่มค่า
 * @param {string} sessionId - รหัสเซสชัน
 * @returns {number} จำนวนครั้ง
 */
function getReconnectCount(sessionId) {
    const now = Date.now();
    const WINDOW = 60_000;

    let history = reconnectTracking.get(sessionId) ||[];
    history = history.filter((timestamp) => now - timestamp < WINDOW);
    reconnectTracking.set(sessionId, history);

    return history.length;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔒  SESSION LOCK MECHANISM
// ════════════════════════════════════════════════════════════════════════════

/**
 * ล็อกเซสชันเพื่อป้องกัน Race Condition
 * @param {string} sessionId - รหัสเซสชัน
 * @returns {boolean} true ถ้าล็อกสำเร็จ, false ถ้ามีการล็อกอยู่แล้ว
 */
function lockSession(sessionId) {
    if (sessionLocks.has(sessionId)) {
        return false;
    }
    sessionLocks.add(sessionId);
    return true;
}

/**
 * ปลดล็อกเซสชัน
 * @param {string} sessionId - รหัสเซสชัน
 */
function unlockSession(sessionId) {
    sessionLocks.delete(sessionId);
}

/**
 * ตรวจสอบว่าเซสชันถูกล็อกอยู่หรือไม่
 * @param {string} sessionId - รหัสเซสชัน
 * @returns {boolean}
 */
function isSessionLocked(sessionId) {
    return sessionLocks.has(sessionId);
}

// ════════════════════════════════════════════════════════════════════════════
//  🧹  MAINTENANCE & CLEANUP
// ════════════════════════════════════════════════════════════════════════════

/**
 * ตรวจสอบและลบเซสชันที่ไม่มีการใช้งาน (Idle Timeout)
 * @param {number} maxIdleTime - เวลาไม่มีกิจกรรมสูงสุด (milliseconds)
 * @returns {number} จำนวนเซสชันที่ถูกลบ
 */
function cleanupIdleSessions(maxIdleTime = 3600_000) {
    const now = Date.now();
    let cleanedCount = 0;

    for (const[sessionId, session] of sessions) {
        if (now - session.startedAt > maxIdleTime) {
            console.log(`🧹 [CLEANUP] Removing stale session: ${sessionId}`);
            deleteSession(sessionId);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        console.log(`✅ [CLEANUP] Removed ${cleanedCount} stale session(s)`);
    }

    return cleanedCount;
}

// ════════════════════════════════════════════════════════════════════════════
//  📤  MODULE EXPORTS
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
    // Core Operations
    createSession,
    getSession,
    getAllSessions,
    deleteSession,

    // Reconnect Tracking
    addReconnect,
    clearReconnect,
    getReconnectCount,

    // Session Locking
    lockSession,
    unlockSession,
    isSessionLocked,

    // Maintenance & Metrics
    cleanupIdleSessions,
    systemMetrics,
};