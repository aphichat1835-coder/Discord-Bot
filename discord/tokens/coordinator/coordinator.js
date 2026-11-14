'use strict';

const { EventEmitter } = require('node:events');
const tokenState = require('./tokenState');
const activityRegistry = require('./activityRegistry');
const rateLimiter = require('./rateLimiter');
const execution = require('./execution');
const quarantine = require('./quarantine');
const profileCache = require('./profileCache');
const questHeartbeat = require('./questHeartbeat');
const telemetry = require('./telemetry');

function _clearRateLimitTicket(ticket, resetErr) {
    ticket.cancelled = true;
    if (ticket.timer) clearTimeout(ticket.timer);
    if (typeof ticket.reject === 'function') {
        try {
            ticket.reject(resetErr);
        } catch {}
    }
}

function _clearStateRateLimiter(rateLimiter, resetErr) {
    if (!rateLimiter) return;
    if (rateLimiter.pumpTimer) {
        clearTimeout(rateLimiter.pumpTimer);
        rateLimiter.pumpTimer = null;
    }
    if (rateLimiter.queue) {
        for (const ticket of rateLimiter.queue) {
            _clearRateLimitTicket(ticket, resetErr);
        }
        rateLimiter.queue = [];
    }
}

/**
 * TokenCoordinator (Universal Token Hub & Master Controller)
 *
 * Central coordinator managing token lifecycle, cross-subsystem activity,
 * rate limit safety, concurrency smoothing, and conflict prevention across:
 * 1. 24/7 Voice Channel Sessions (voiceWorker)
 * 2. Scheduled & Automated Discord Quests (questRunner)
 * 3. Token checking and validation workflows (tokenChecker)
 * 4. Extensible Plugins and Future Subsystems
 */
class TokenCoordinator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.tokenStates = new Map(); // tokenHash -> { voice: null, quest: null, activities: Map, quarantine: null, backoffUntil: number, rateLimiter, lastActivity: number }
        this.tokenLocks = new Map();  // tokenHash -> Promise (FIFO mutex queue)
        this.subsystems = new Map();  // name -> { onTokenQuarantined, onTokenActive }
        this.profileCache = new Map(); // tokenHash -> { profile, cachedAt, expiresAt }
        this.alertHistory = new Map(); // tokenHash -> lastAlertTimestamp (throttling duplicate alerts)
        this.alertCooldownMs = Number.isFinite(options.alertCooldownMs) ? options.alertCooldownMs : 5 * 60 * 1000;
        this.rateLimitConfig = {
            capacity: Number.isFinite(options.capacity) ? options.capacity : 4,
            refillRatePerSec: Number.isFinite(options.refillRatePerSec) ? options.refillRatePerSec : 2
        };
        this.startTime = Date.now();
    }

    /**
     * Compute SHA-256 hash of a token
     * @param {string} token
     * @returns {string}
     */
    hashToken(token) {
        return tokenState.hashToken(token);
    }

    _getOrCreateState(tokenHash) {
        return tokenState.getOrCreateTokenState(this.tokenStates, tokenHash, this.rateLimitConfig.capacity);
    }

    /**
     * Set explicit token type ('user' | 'bot' | 'unknown')
     * @param {string} token
     * @param {'user'|'bot'|'unknown'} type
     */
    setTokenType(token, type) {
        const hash = this.hashToken(token);
        if (!hash) return;
        tokenState.setTokenType(this.tokenStates, hash, type, this.rateLimitConfig.capacity);
    }

    /**
     * Get token type from profile cache or state
     * @param {string} token
     * @returns {'user'|'bot'|'unknown'}
     */
    getTokenType(token) {
        const hash = this.hashToken(token);
        if (!hash) return 'unknown';
        const cached = this.getCachedTokenProfile(token);
        return tokenState.getTokenType(this.tokenStates, hash, cached);
    }

    /**
     * Build appropriate Discord Authorization header based on token type
     * @param {string} token
     * @param {'user'|'bot'} [explicitType]
     * @returns {string}
     */
    formatAuthHeader(token, explicitType = null) {
        const inferredType = explicitType ? null : this.getTokenType(token);
        return tokenState.formatAuthHeader(token, explicitType, inferredType);
    }

    /**
     * Dynamic Activity Registry: Acquire an activity slot for a token
     * @param {string} token
     * @param {string} subsystem
     * @param {object} [metadata]
     * @returns {boolean}
     */
    acquireActivity(token, subsystem, metadata = {}) {
        return activityRegistry.acquireActivity(this, token, subsystem, metadata);
    }

    _releaseSpecificVoiceSession(hash, state, targetSessionId, options) {
        return activityRegistry._releaseSpecificVoiceSession(this, hash, state, targetSessionId, options);
    }

    _releaseLegacyVoiceSession(state) {
        return activityRegistry._releaseLegacyVoiceSession(state);
    }

    _handleVoiceRelease(hash, state, options) {
        return activityRegistry._handleVoiceRelease(this, hash, state, options);
    }

    _cleanupInactiveTokenState(hash, state) {
        return activityRegistry._cleanupInactiveTokenState(this, hash, state);
    }

    /**
     * Dynamic Activity Registry: Release an activity slot for a token
     * @param {string} token
     * @param {string} subsystem
     * @param {object|string} [options]
     * @returns {boolean}
     */
    releaseActivity(token, subsystem, options = {}) {
        return activityRegistry.releaseActivity(this, token, subsystem, options);
    }

    /**
     * Check if a token currently has a specific active activity
     * @param {string} token
     * @param {string} subsystem
     * @param {object|string} [options]
     * @returns {boolean}
     */
    hasActivity(token, subsystem, options = {}) {
        return activityRegistry.hasActivity(this, token, subsystem, options);
    }

    /**
     * Get all active activities for a token
     * @param {string} token
     * @returns {Array<{ subsystem: string, startedAt: number, metadata: object }>}
     */
    getActivities(token) {
        return activityRegistry.getActivities(this, token);
    }

    /**
     * Register that a token is actively connected to a Discord voice channel
     * @param {string} token
     * @param {{ guildId: string, channelId: string, sessionId?: string, client?: any }} details
     */
    registerVoiceActivity(token, details) {
        return activityRegistry.registerVoiceActivity(this, token, details);
    }

    /**
     * Unregister voice activity for a token
     * @param {string} token
     * @param {object|string} [options] Optional sessionId or { sessionId, guildId }
     */
    unregisterVoiceActivity(token, options = {}) {
        return activityRegistry.unregisterVoiceActivity(this, token, options);
    }

    /**
     * Check if a token currently has an active voice connection
     * @param {string} token
     * @param {object|string} [options] Optional sessionId or { sessionId, guildId }
     * @returns {boolean}
     */
    isVoiceActive(token, options = {}) {
        return activityRegistry.isVoiceActive(this, token, options);
    }

    /**
     * Get active voice details for a token
     * @param {string} token
     * @param {object|string} [options] Optional sessionId or { sessionId, guildId }
     * @returns {{ guildId: string, channelId: string, sessionId: string, activeAt: number } | null}
     */
    getVoiceActivity(token, options = {}) {
        return activityRegistry.getVoiceActivity(this, token, options);
    }

    /**
     * Notify that quest execution has started on a token
     * @param {string} token
     * @param {object} [metadata]
     */
    notifyQuestStart(token, metadata = {}) {
        return activityRegistry.notifyQuestStart(this, token, metadata);
    }

    /**
     * Notify that quest execution has completed on a token
     * @param {string} token
     */
    notifyQuestEnd(token) {
        return activityRegistry.notifyQuestEnd(this, token);
    }

    /**
     * Check if a quest is currently running for a token
     * @param {string} token
     * @returns {boolean}
     */
    isQuestActive(token) {
        return activityRegistry.isQuestActive(this, token);
    }

    /**
     * Check if voice health check should apply grace debounce
     * (e.g. while quest is actively dispatching heartbeats)
     * @param {string} token
     * @returns {boolean}
     */
    shouldDebounceVoiceHealthCheck(token) {
        return activityRegistry.shouldDebounceVoiceHealthCheck(this, token);
    }

    /**
     * Generate safe Heartbeat body for Quest execution.
     * Prevents Discord from interpreting heartbeat as a 1-to-1 Call Stream,
     * which causes Discord to disconnect the account from Guild Voice!
     *
     * @param {string} token
     * @param {object} quest
     * @param {boolean} terminal
     * @returns {object} Payload to send to POST /quests/{id}/heartbeat
     */
    getSafeQuestHeartbeatPayload(token, quest, terminal = false) {
        return questHeartbeat.getSafeQuestHeartbeatPayload(this, token, quest, terminal);
    }

    /**
     * Run an operation with token-level serialized mutual exclusion
     * to prevent race conditions and conflicting concurrent requests.
     * @param {string} token
     * @param {() => Promise<any>} operation
     * @returns {Promise<any>}
     */
    async withTokenLock(token, operation) {
        return execution.withTokenLock(this, token, operation);
    }

    /**
     * Register a subsystem with the coordinator to receive lifecycle events
     * @param {{ name: string, onTokenQuarantined?: (tokenHash: string, reason: string, state: object) => void, onTokenActive?: (tokenHash: string, state: object) => void }} config
     */
    registerSubsystem(config) {
        return quarantine.registerSubsystem(this, config);
    }

    /**
     * Unregister a subsystem
     * @param {string} name
     * @returns {boolean}
     */
    unregisterSubsystem(name) {
        return quarantine.unregisterSubsystem(this, name);
    }

    /**
     * Apply backoff to a token (e.g. from HTTP 429 Retry-After)
     * @param {string} token
     * @param {number} durationMs
     * @param {object|string} [options]
     */
    applyTokenBackoff(token, durationMs, options = {}) {
        return rateLimiter.applyTokenBackoff(this, token, durationMs, options);
    }

    _refillTokens(limiter) {
        return rateLimiter._refillTokens(this, limiter);
    }

    _processQueueHead(limiter) {
        return rateLimiter._processQueueHead(this, limiter);
    }

    _pumpRateLimitQueue(tokenHash) {
        return rateLimiter._pumpRateLimitQueue(this, tokenHash);
    }

    /**
     * Acquire a rate limit slot for a token using queue-based reservation
     * @param {string} tokenHash
     * @param {{ maxWaitMs?: number, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', signal?: any }} [options]
     */
    async _acquireRateLimitSlot(tokenHash, options = {}) {
        return rateLimiter._acquireRateLimitSlot(this, tokenHash, options);
    }

    _parse429WaitMs(err) {
        return rateLimiter._parse429WaitMs(err);
    }

    _is429Error(err) {
        return rateLimiter._is429Error(err);
    }

    _checkAndQuarantineOnAuthError(hash, subsystem, err) {
        return execution._checkAndQuarantineOnAuthError(this, hash, subsystem, err);
    }

    async _executeTokenAttempt(hash, operation, options) {
        return execution._executeTokenAttempt(this, hash, operation, options);
    }

    async executeWithToken(token, subsystem, operation, options = {}) {
        return execution.executeWithToken(this, token, subsystem, operation, options);
    }

    /**
     * Universal Standard Task Runner for current and future subsystems
     * @param {string} token
     * @param {{ subsystem: string, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', timeoutMs?: number, retryOn429?: boolean, metadata?: object, signal?: any }} options
     * @param {() => Promise<any>} taskFn
     * @returns {Promise<any>}
     */
    async runTask(token, options, taskFn) {
        return execution.runTask(this, token, options, taskFn);
    }

    /**
     * Quarantine a token across the entire system with alert throttling
     * @param {string} token
     * @param {string} [reason]
     * @returns {boolean}
     */
    quarantineToken(token, reason = 'Token Invalid or Revoked') {
        return quarantine.quarantineToken(this, token, reason);
    }

    /**
     * Release a token from quarantine
     * @param {string} token
     * @returns {boolean}
     */
    releaseQuarantine(token) {
        return quarantine.releaseQuarantine(this, token);
    }

    /**
     * Check if a token is currently quarantined
     * @param {string} token
     * @returns {boolean}
     */
    isQuarantined(token) {
        return quarantine.isQuarantined(this, token);
    }

    /**
     * Get details of quarantine for a token
     * @param {string} token
     * @returns {{ quarantinedAt: number, reason: string } | null}
     */
    getQuarantineDetails(token) {
        return quarantine.getQuarantineDetails(this, token);
    }

    /**
     * Cache a token profile in memory with a TTL and bounded pruning
     * @param {string} token
     * @param {object} profile
     * @param {number} [ttlMs] Default: 20 minutes
     */
    cacheTokenProfile(token, profile, ttlMs = 20 * 60 * 1000) {
        return profileCache.cacheTokenProfile(
            this.profileCache,
            this.tokenStates,
            (t) => this.hashToken(t),
            (h) => this._getOrCreateState(h),
            token,
            profile,
            ttlMs
        );
    }

    /**
     * Get cached token profile if present and not expired
     * @param {string} token
     * @returns {object | null}
     */
    getCachedTokenProfile(token) {
        return profileCache.getCachedTokenProfile(this.profileCache, (t) => this.hashToken(t), token);
    }

    /**
     * Clear token profile cache (single token or all)
     * @param {string} [token]
     */
    clearTokenProfileCache(token = null) {
        return profileCache.clearTokenProfileCache(this.profileCache, (t) => this.hashToken(t), token);
    }

    /**
     * Get status summary for monitoring and Owner Dashboard API
     * @returns {object}
     */
    getStatusSummary() {
        const states = Array.from(this.tokenStates.entries());
        const voiceSessions = [];
        for (const [hash, s] of states) {
            if (s.voiceSessions && s.voiceSessions.size > 0) {
                for (const vs of s.voiceSessions.values()) {
                    voiceSessions.push({
                        tokenHash: hash,
                        guildId: vs.guildId,
                        channelId: vs.channelId,
                        sessionId: vs.sessionId,
                        activeAt: vs.activeAt
                    });
                }
            } else if (s.voice) {
                voiceSessions.push({
                    tokenHash: hash,
                    guildId: s.voice.guildId,
                    channelId: s.voice.channelId,
                    sessionId: s.voice.sessionId,
                    activeAt: s.voice.activeAt
                });
            }
        }

        const questSessions = states.filter(([_, s]) => Boolean(s.quest)).map(([hash, s]) => ({
            tokenHash: hash,
            questId: s.quest.questId,
            mode: s.quest.mode,
            startedAt: s.quest.startedAt
        }));

        const quarantinedTokens = states.filter(([_, s]) => Boolean(s.quarantine)).map(([hash, s]) => ({
            tokenHash: hash,
            reason: s.quarantine.reason,
            quarantinedAt: s.quarantine.quarantinedAt
        }));

        const dynamicActivities = [];
        for (const [hash, s] of states) {
            if (s.activities && s.activities.size > 0) {
                for (const [sub, meta] of s.activities.entries()) {
                    dynamicActivities.push({
                        tokenHash: hash,
                        subsystem: sub,
                        startedAt: meta?.startedAt || s.lastActivity
                    });
                }
            }
        }

        return {
            activeTokens: this.tokenStates.size,
            voiceSessionsCount: voiceSessions.length,
            voiceSessions,
            questSessionsCount: questSessions.length,
            questSessions,
            quarantinedCount: quarantinedTokens.length,
            quarantinedTokens,
            dynamicActivitiesCount: dynamicActivities.length,
            dynamicActivities,
            cachedProfilesCount: this.profileCache.size,
            registeredSubsystems: Array.from(this.subsystems.keys()),
            uptimeMs: Date.now() - this.startTime
        };
    }

    /**
     * Reset all internal states (useful for testing or full cleanup)
     */
    reset() {
        const resetErr = new Error('Token coordinator reset: rate limit ticket cancelled');
        resetErr.code = 'COORDINATOR_RESET';
        for (const state of this.tokenStates.values()) {
            _clearStateRateLimiter(state.rateLimiter, resetErr);
        }
        this.tokenStates.clear();
        this.tokenLocks.clear();
        this.subsystems.clear();
        this.profileCache.clear();
        this.alertHistory.clear();
        this.removeAllListeners();
        telemetry.attachTelemetryListeners(this);
    }
}

module.exports = {
    TokenCoordinator
};
