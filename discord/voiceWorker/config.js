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
const config = require("../config.json");

// ════════════════════════════════════════════════════════════════════════════
//  ⚙️  REGION 1: CONFIG
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    MAX_RECONNECT_ATTEMPTS: config.voice_worker.maxReconnectAttempts || 7,
    LOGIN_TIMEOUT: config.voice_worker.loginTimeout || 35000,
    CONNECTION_TIMEOUT: config.voice_worker.connectionTimeout || 15000,
    DM_THROTTLE_MS: config.voice_worker.dmThrottleMs || 20000,
};
const LOGIN_QUEUE_MAX_SIZE = config.voice_worker.loginQueueMaxSize || 100;
const RECOVERY_QUEUE_MAX_SIZE = config.voice_worker.recoveryQueueMaxSize || 200;
const TOKEN_LOGIN_COOLDOWN_TTL_MS = 10 * 60 * 1000;
const TOKEN_LOGIN_COOLDOWN_MAX_SIZE = 5000;
const DM_THROTTLE_MAX_SIZE = config.voice_worker.dmThrottleMaxSize || 5000;
const VOICE_LOG_MAX = Math.max(
    20,
    Math.min(2000, Number(process.env.VOICE_LOG_MAX || config.voice_worker.voiceLogMax || 200) || 200)
);

const SELF_CLIENT_CACHE_LIMITS = {
    MessageManager: Math.max(0, Number(process.env.VOICE_SELF_MESSAGE_CACHE_MAX || 20) || 20),
    GuildMemberManager: Math.max(10, Number(process.env.VOICE_SELF_MEMBER_CACHE_MAX || 100) || 100),
    UserManager: Math.max(50, Number(process.env.VOICE_SELF_USER_CACHE_MAX || 500) || 500),
    ReactionManager: 0
};
const SELF_CLIENT_CACHE_CLEANUP_TTL_MS = Math.max(
    60 * 1000,
    Number(process.env.VOICE_SELF_CACHE_CLEANUP_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000
);
const VOICE_LEAN_MODE = String(process.env.VOICE_LEAN_MODE ?? "true").trim().toLowerCase() !== "false";
const VOICE_LEAN_KEEP_TARGET_GUILD = String(process.env.VOICE_LEAN_KEEP_TARGET_GUILD ?? "true").trim().toLowerCase() !== "false";
const VOICE_LEAN_CLEANUP_INTERVAL_MS = Math.max(
    30 * 1000,
    Number(process.env.VOICE_LEAN_CLEANUP_INTERVAL_MS || 60 * 1000) || 60 * 1000
);
const VOICE_LEAN_LOG = String(process.env.VOICE_LEAN_LOG || "false").trim().toLowerCase() === "true";

const RECOVERY_COOLDOWN_MS = 60000;

function randomInt(min, max) {
    return crypto.randomInt(min, max);
}

function randomJitter(rangeMs) {
    return randomInt(-rangeMs, rangeMs + 1);
}

function delay(ms, value = undefined) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(value), ms);
        timer.unref?.();
    });
}

async function withTimeoutValue(promise, timeoutMs, timeoutValue) {
    let timer = null;
    try {
        return await Promise.race([
            Promise.resolve(promise).finally(() => {
                if (timer) clearTimeout(timer);
            }),
            new Promise(resolve => {
                timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
                timer.unref?.();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function withTimeoutReject(promise, timeoutMs, message) {
    let timer = null;
    try {
        return await Promise.race([
            Promise.resolve(promise).finally(() => {
                if (timer) clearTimeout(timer);
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                timer.unref?.();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
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
