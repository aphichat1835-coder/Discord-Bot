/* eslint-disable complexity -- Voice/session lifecycle is behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT MODIFY: MAX_RECONNECT_ATTEMPTS, CONNECTION_TIMEOUT, LOGIN_TIMEOUT.
DO NOT REMOVE: isShuttingDown flag — critical for SIGTERM safety (เฟส 8+18).
DO NOT SIMPLIFY: OperationQueue concurrency — prevents IP ban from Discord.
================================================================================
*/

const crypto = require("node:crypto");
const { delay, withTimeoutValue, withTimeoutReject } = require("../core/timers");
const config = require("../config.json");
const { readFiniteInteger } = require("../core/numbers");

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 1: CONFIG
// ════════════════════════════════════════════════════════════════════════════
const voiceWorkerConfig = config.voice_worker ?? {};
const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: readFiniteInteger(voiceWorkerConfig.maxReconnectAttempts, { fallback: 7, min: 1, max: 50 }),
    LOGIN_TIMEOUT: readFiniteInteger(voiceWorkerConfig.loginTimeout, { fallback: 35000, min: 5000, max: 120000 }),
    CONNECTION_TIMEOUT: readFiniteInteger(voiceWorkerConfig.connectionTimeout, { fallback: 15000, min: 3000, max: 60000 }),
    DM_THROTTLE_MS: readFiniteInteger(voiceWorkerConfig.dmThrottleMs, { fallback: 20000, min: 1000, max: 10 * 60 * 1000 }),
};
const LOGIN_QUEUE_MAX_SIZE = readFiniteInteger(voiceWorkerConfig.loginQueueMaxSize, { fallback: 100, min: 1, max: 1000 });
const RECOVERY_QUEUE_MAX_SIZE = readFiniteInteger(voiceWorkerConfig.recoveryQueueMaxSize, { fallback: 200, min: 1, max: 2000 });
const TOKEN_LOGIN_COOLDOWN_TTL_MS = 10 * 60 * 1000;
const TOKEN_LOGIN_COOLDOWN_MAX_SIZE = 5000;
const DM_THROTTLE_MAX_SIZE = readFiniteInteger(voiceWorkerConfig.dmThrottleMaxSize, { fallback: 5000, min: 100, max: 50000 });
const VOICE_LOG_MAX = readFiniteInteger(
    process.env.VOICE_LOG_MAX ?? voiceWorkerConfig.voiceLogMax,
    { fallback: 200, min: 20, max: 2000 }
);

const SELF_CLIENT_CACHE_LIMITS = {
    MessageManager: readFiniteInteger(process.env.VOICE_SELF_MESSAGE_CACHE_MAX, { fallback: 20, min: 0, max: 1000 }),
    GuildMemberManager: readFiniteInteger(process.env.VOICE_SELF_MEMBER_CACHE_MAX, { fallback: 100, min: 10, max: 5000 }),
    UserManager: readFiniteInteger(process.env.VOICE_SELF_USER_CACHE_MAX, { fallback: 500, min: 50, max: 10000 }),
    ReactionManager: 0
};
const SELF_CLIENT_CACHE_CLEANUP_TTL_MS = readFiniteInteger(
    process.env.VOICE_SELF_CACHE_CLEANUP_TTL_MS,
    { fallback: 10 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000 }
);
const VOICE_LEAN_MODE = String(process.env.VOICE_LEAN_MODE ?? "true").trim().toLowerCase() !== "false";
const VOICE_LEAN_KEEP_TARGET_GUILD = String(process.env.VOICE_LEAN_KEEP_TARGET_GUILD ?? "true").trim().toLowerCase() !== "false";
const VOICE_LEAN_CLEANUP_INTERVAL_MS = readFiniteInteger(
    process.env.VOICE_LEAN_CLEANUP_INTERVAL_MS,
    { fallback: 60 * 1000, min: 30 * 1000, max: 60 * 60 * 1000 }
);
const VOICE_LEAN_LOG = String(process.env.VOICE_LEAN_LOG || "false").trim().toLowerCase() === "true";

const RECOVERY_COOLDOWN_MS = 60000;

function randomInt(min, max) {
    return crypto.randomInt(min, max);
}

function randomJitter(rangeMs) {
    return randomInt(-rangeMs, rangeMs + 1);
}

module.exports = {
    CONFIG,
    LOGIN_QUEUE_MAX_SIZE,
    RECOVERY_QUEUE_MAX_SIZE,
    TOKEN_LOGIN_COOLDOWN_TTL_MS,
    TOKEN_LOGIN_COOLDOWN_MAX_SIZE,
    DM_THROTTLE_MAX_SIZE,
    VOICE_LOG_MAX,
    SELF_CLIENT_CACHE_LIMITS,
    SELF_CLIENT_CACHE_CLEANUP_TTL_MS,
    VOICE_LEAN_MODE,
    VOICE_LEAN_KEEP_TARGET_GUILD,
    VOICE_LEAN_CLEANUP_INTERVAL_MS,
    VOICE_LEAN_LOG,
    RECOVERY_COOLDOWN_MS,
    randomInt,
    randomJitter,
    delay,
    withTimeoutValue,
    withTimeoutReject,
    config,
};
