const config = require("../config.json");

// ════════════════════════════════════════════════════════════════════════════
//  🗺️  REGION 2: STATE
// ════════════════════════════════════════════════════════════════════════════
const clientPool = new Map();
const tokenLoginCooldowns = new Map();

// ── Naturalness Engine state ──
const naturalTimers = new Map();
const naturalRunning = new Set();

// ── Auto Deaf Engine state ──
const autoDeafTimers = new Map();
const autoDeafRunning = new Set();

// ── DM throttle state (declared here so lifecycle + dm can share) ──
const lastDMSent = new Map();
const lastOnlineDMSent = new Map();

// ── Recovery state (declared here so lifecycle can share) ──
const recoveryTimestamps = new Map();

/*
 * Mutable primitive flags — wrapped in `st` object so that cross-module
 * mutations are visible to all importers (CommonJS modules share the same
 * object reference, but not primitive re-bindings).
 */
const st = {
    // เฟส 18+8: Global shutdown flag — Voice Worker เช็คก่อน reconnect ทุกครั้ง
    isShuttingDown: false,

    mainClient: null,
    lastLeanCleanup: null,

    // ── Shadow Protocol: Protected Session checker ──
    _isProtected: null,

    healthCheckRunning: false,

    naturalSettings: {
        enabled: config.naturalness?.enabled ?? false,
        intervalMs: config.naturalness?.intervalMs ?? 3600000,
        durationMs: config.naturalness?.durationMs ?? 30000,
    },

    autoDeafSettings: {
        enabled: config.auto_deaf?.enabled ?? false,
        intervalMs: config.auto_deaf?.intervalMs ?? 3600000,
        openDurationMs: config.auto_deaf?.openDurationMs ?? 60000,
    },
};

function setShuttingDown(val) { st.isShuttingDown = val; }
function setProtectedChecker(fn) { st._isProtected = fn; }
function setMainClient(client) { st.mainClient = client; }
function getClientPoolSize() { return clientPool.size; }

module.exports = {
    st,
    clientPool,
    tokenLoginCooldowns,
    naturalTimers,
    naturalRunning,
    autoDeafTimers,
    autoDeafRunning,
    lastDMSent,
    lastOnlineDMSent,
    recoveryTimestamps,
    setShuttingDown,
    setProtectedChecker,
    setMainClient,
    getClientPoolSize,
};
