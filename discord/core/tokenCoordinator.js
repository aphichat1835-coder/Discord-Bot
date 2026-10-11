'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { safeError, sanitizeLogText } = require('./safeLogger');

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
        if (!token) return '';
        if (typeof token === 'string' && token.length === 64 && /^[0-9a-f]{64}$/i.test(token)) {
            return token.toLowerCase(); // Already a hash
        }
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    }

    _getOrCreateState(tokenHash) {
        let state = this.tokenStates.get(tokenHash);
        if (!state) {
            state = {
                tokenType: 'unknown',
                voice: null,
                quest: null,
                activities: new Map(),
                quarantine: null,
                backoffUntil: 0,
                rateLimiter: {
                    tokens: this.rateLimitConfig.capacity,
                    lastRefill: Date.now()
                },
                lastActivity: Date.now()
            };
            this.tokenStates.set(tokenHash, state);
        } else if (!state.activities) {
            state.activities = new Map();
        }
        return state;
    }

    /**
     * Set explicit token type ('user' | 'bot' | 'unknown')
     * @param {string} token
     * @param {'user'|'bot'|'unknown'} type
     */
    setTokenType(token, type) {
        const hash = this.hashToken(token);
        if (!hash) return;
        const state = this._getOrCreateState(hash);
        state.tokenType = type === 'bot' ? 'bot' : (type === 'user' ? 'user' : 'unknown');
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
        if (cached?.isBot || cached?.tokenType === 'bot' || cached?.category === 'bot') return 'bot';
        if (cached?.tokenType === 'user' || (cached && !cached.isBot)) return 'user';
        return this.tokenStates.get(hash)?.tokenType || 'unknown';
    }

    /**
     * Build appropriate Discord Authorization header based on token type
     * @param {string} token
     * @param {'user'|'bot'} [explicitType]
     * @returns {string}
     */
    formatAuthHeader(token, explicitType = null) {
        if (!token) return '';
        const trimmed = String(token).trim();
        if (trimmed.startsWith('Bot ')) return trimmed;
        const type = explicitType || this.getTokenType(trimmed);
        return type === 'bot' ? `Bot ${trimmed}` : trimmed;
    }

    /**
     * Dynamic Activity Registry: Acquire an activity slot for a token
     * @param {string} token
     * @param {string} subsystem
     * @param {object} [metadata]
     * @returns {boolean}
     */
    acquireActivity(token, subsystem, metadata = {}) {
        const hash = this.hashToken(token);
        if (!hash || !subsystem) return false;

        const state = this._getOrCreateState(hash);
        state.activities.set(String(subsystem), {
            ...metadata,
            startedAt: Date.now()
        });
        state.lastActivity = Date.now();

        // Backward compatibility mappings
        if (subsystem === 'voice') {
            state.voice = {
                guildId: String(metadata?.guildId || ''),
                channelId: String(metadata?.channelId || ''),
                sessionId: String(metadata?.sessionId || ''),
                activeAt: Date.now()
            };
        } else if (subsystem === 'quest') {
            state.quest = {
                startedAt: Date.now(),
                questId: metadata?.questId || null,
                mode: metadata?.mode || 'scheduled'
            };
        }

        this.emit('token:activity_start', { tokenHash: hash, subsystem, metadata });
        return true;
    }

    /**
     * Dynamic Activity Registry: Release an activity slot for a token
     * @param {string} token
     * @param {string} subsystem
     * @returns {boolean}
     */
    releaseActivity(token, subsystem) {
        const hash = this.hashToken(token);
        if (!hash || !subsystem) return false;

        const state = this.tokenStates.get(hash);
        if (!state) return false;

        const deleted = state.activities?.delete(String(subsystem));
        state.lastActivity = Date.now();

        // Backward compatibility mappings
        if (subsystem === 'voice') state.voice = null;
        if (subsystem === 'quest') state.quest = null;

        if ((!state.activities || state.activities.size === 0) && !state.voice && !state.quest && !state.quarantine) {
            this.tokenStates.delete(hash);
        }

        this.emit('token:activity_end', { tokenHash: hash, subsystem });
        return Boolean(deleted);
    }

    /**
     * Check if a token currently has a specific active activity
     * @param {string} token
     * @param {string} subsystem
     * @returns {boolean}
     */
    hasActivity(token, subsystem) {
        const hash = this.hashToken(token);
        if (!hash) return false;
        const state = this.tokenStates.get(hash);
        if (!state) return false;

        if (subsystem === 'voice') return Boolean(state.voice?.guildId && state.voice?.channelId);
        if (subsystem === 'quest') return Boolean(state.quest);
        return Boolean(state.activities?.has(String(subsystem)));
    }

    /**
     * Get all active activities for a token
     * @param {string} token
     * @returns {Array<{ subsystem: string, startedAt: number, metadata: object }>}
     */
    getActivities(token) {
        const hash = this.hashToken(token);
        if (!hash) return [];
        const state = this.tokenStates.get(hash);
        if (!state?.activities) return [];

        const list = [];
        for (const [sub, meta] of state.activities.entries()) {
            list.push({
                subsystem: sub,
                startedAt: meta?.startedAt || Date.now(),
                metadata: meta
            });
        }
        return list;
    }

    /**
     * Register that a token is actively connected to a Discord voice channel
     * @param {string} token
     * @param {{ guildId: string, channelId: string, sessionId?: string, client?: any }} details
     */
    registerVoiceActivity(token, details) {
        return this.acquireActivity(token, 'voice', details);
    }

    /**
     * Unregister voice activity for a token
     * @param {string} token
     */
    unregisterVoiceActivity(token) {
        return this.releaseActivity(token, 'voice');
    }

    /**
     * Check if a token currently has an active voice connection
     * @param {string} token
     * @returns {boolean}
     */
    isVoiceActive(token) {
        return this.hasActivity(token, 'voice');
    }

    /**
     * Get active voice details for a token
     * @param {string} token
     * @returns {{ guildId: string, channelId: string, sessionId: string, activeAt: number } | null}
     */
    getVoiceActivity(token) {
        const hash = this.hashToken(token);
        return this.tokenStates.get(hash)?.voice || null;
    }

    /**
     * Notify that quest execution has started on a token
     * @param {string} token
     * @param {object} [metadata]
     */
    notifyQuestStart(token, metadata = {}) {
        return this.acquireActivity(token, 'quest', metadata);
    }

    /**
     * Notify that quest execution has completed on a token
     * @param {string} token
     */
    notifyQuestEnd(token) {
        return this.releaseActivity(token, 'quest');
    }

    /**
     * Check if a quest is currently running for a token
     * @param {string} token
     * @returns {boolean}
     */
    isQuestActive(token) {
        return this.hasActivity(token, 'quest');
    }

    /**
     * Check if voice health check should apply grace debounce
     * (e.g. while quest is actively dispatching heartbeats)
     * @param {string} token
     * @returns {boolean}
     */
    shouldDebounceVoiceHealthCheck(token) {
        return this.isQuestActive(token);
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
        // Priority 1: Application ID heartbeat (safest, never touches voice state)
        if (quest?.applicationId) {
            return { application_id: quest.applicationId, terminal };
        }

        // Priority 2: Check if account is in guild voice
        const voice = this.getVoiceActivity(token);
        if (voice?.guildId && voice?.channelId) {
            return {
                stream_key: `guild:${voice.guildId}:${voice.channelId}`,
                terminal
            };
        }

        // Priority 3: Fallback for accounts not in guild voice
        return {
            stream_key: `call:${quest?.id || 'default'}:1`,
            terminal
        };
    }

    /**
     * Run an operation with token-level serialized mutual exclusion
     * to prevent race conditions and conflicting concurrent requests.
     * @param {string} token
     * @param {() => Promise<any>} operation
     * @returns {Promise<any>}
     */
    async withTokenLock(token, operation) {
        const hash = this.hashToken(token);
        if (!hash) return operation();

        const previous = this.tokenLocks.get(hash) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const queued = previous.then(() => gate);
        this.tokenLocks.set(hash, queued);

        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.tokenLocks.get(hash) === queued) {
                this.tokenLocks.delete(hash);
            }
        }
    }

    /**
     * Register a subsystem with the coordinator to receive lifecycle events
     * @param {{ name: string, onTokenQuarantined?: (tokenHash: string, reason: string, state: object) => void, onTokenActive?: (tokenHash: string, state: object) => void }} config
     */
    registerSubsystem(config) {
        if (!config?.name || typeof config.name !== 'string') {
            throw new TypeError('registerSubsystem requires a valid string name');
        }
        this.subsystems.set(config.name, {
            onTokenQuarantined: typeof config.onTokenQuarantined === 'function' ? config.onTokenQuarantined : null,
            onTokenActive: typeof config.onTokenActive === 'function' ? config.onTokenActive : null
        });
    }

    /**
     * Unregister a subsystem
     * @param {string} name
     * @returns {boolean}
     */
    unregisterSubsystem(name) {
        if (!name) return false;
        return this.subsystems.delete(String(name));
    }

    /**
     * Apply backoff to a token (e.g. from HTTP 429 Retry-After)
     * @param {string} token
     * @param {number} durationMs
     * @param {object|string} [options]
     */
    applyTokenBackoff(token, durationMs, options = {}) {
        const hash = this.hashToken(token);
        if (!hash) return;
        const subsystem = typeof options === 'string' ? options : (options?.subsystem || null);
        const reason = (typeof options === 'object' && options?.reason) || '429_backoff';
        const source = (typeof options === 'object' && options?.source) || 'rest_api';
        const state = this._getOrCreateState(hash);
        const until = Date.now() + Math.max(300, Number(durationMs) || 2000);
        state.backoffUntil = Math.max(state.backoffUntil || 0, until);
        const waitMs = Math.max(0, state.backoffUntil - Date.now());
        const backoffSeconds = Math.ceil(waitMs / 1000);
        this.emit('token:rate_limited', {
            tokenHash: hash,
            subsystem,
            backoffUntil: state.backoffUntil,
            waitMs,
            backoffSeconds,
            reason,
            source
        });

        if (backoffSeconds >= 15) {
            try {
                const { sendWebhookEvent } = require('./webhooks');
                if (typeof sendWebhookEvent === 'function') {
                    sendWebhookEvent({
                        target: 'ALERT',
                        severity: 'WARNING',
                        category: 'TOKEN',
                        code: 'token.rate_limit_backoff',
                        state: 'OPEN',
                        title: 'RATE LIMITED (429)',
                        description: `ตรวจพบการติด Rate Limit (429) ระบบทำการถอยรอชั่วคราว ${backoffSeconds} วินาที`,
                        fields: [
                            { name: 'สถานะ', value: 'OPEN' },
                            { name: 'ผลกระทบ', value: `กิจกรรมของโทเคนนี้จะหยุดพักชั่วคราว ${backoffSeconds} วินาที` },
                            { name: 'สิ่งที่ควรทำ', value: 'ระบบจะจัดการหน่วงเวลาและทำงานต่อให้อัตโนมัติ' },
                            { name: 'Token Hash', value: `\`${hash.slice(0, 16)}...\`` },
                            { name: 'Subsystem', value: String(subsystem || 'general') }
                        ],
                        dedupeKey: `token-429:${hash}`,
                        dedupeMs: 60 * 1000
                    }).catch(() => {});
                }
            } catch {}
        }
    }

    /**
     * Acquire a rate limit slot for a token using adaptive leaky bucket
     * @param {string} tokenHash
     * @param {{ maxWaitMs?: number, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND' }} [options]
     */
    async _acquireRateLimitSlot(tokenHash, options = {}) {
        if (!tokenHash) return;
        const maxWaitMs = options.maxWaitMs ?? 20000;
        const priority = String(options.priority || 'NORMAL').toUpperCase();
        const state = this._getOrCreateState(tokenHash);

        // Check if token is in 429 backoff pause
        const now = Date.now();
        if (state.backoffUntil && state.backoffUntil > now) {
            const backoffWaitMs = state.backoffUntil - now;
            if (backoffWaitMs > maxWaitMs) {
                const err = new Error(`RATE_LIMIT_BACKOFF: Token backoff wait ${backoffWaitMs}ms > max ${maxWaitMs}ms`);
                err.code = 'RATE_LIMIT_BACKOFF';
                throw err;
            }
            const jitter = Math.floor(Math.random() * 20) + 10;
            await new Promise((resolve) => setTimeout(resolve, backoffWaitMs + jitter));
        }

        const limiter = state.rateLimiter;
        const currentNow = Date.now();

        // Refill tokens
        const elapsedSec = (currentNow - limiter.lastRefill) / 1000;
        limiter.tokens = Math.min(
            this.rateLimitConfig.capacity,
            limiter.tokens + (elapsedSec * this.rateLimitConfig.refillRatePerSec)
        );
        limiter.lastRefill = currentNow;

        // CRITICAL priority (e.g. Voice session keepalive) bypasses wait if capacity has at least 0.5 slot
        if (priority === 'CRITICAL' && limiter.tokens >= 0.5) {
            limiter.tokens = Math.max(0, limiter.tokens - 1);
            return;
        }

        if (limiter.tokens >= 1) {
            limiter.tokens -= 1;
            return;
        }

        // Calculate needed wait time to refill 1 token
        const needed = 1 - limiter.tokens;
        const waitMs = Math.ceil((needed / this.rateLimitConfig.refillRatePerSec) * 1000);
        if (waitMs > maxWaitMs) {
            const err = new Error(`RATE_LIMIT_TIMEOUT: Token rate limit capacity exhausted (wait ${waitMs}ms > max ${maxWaitMs}ms)`);
            err.code = 'RATE_LIMIT_TIMEOUT';
            throw err;
        }

        // Micro-jitter to prevent thundering herd
        const jitter = Math.floor(Math.random() * 10) + 2;
        await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));

        // Double check after waking
        const postNow = Date.now();
        const postElapsed = (postNow - limiter.lastRefill) / 1000;
        limiter.tokens = Math.min(
            this.rateLimitConfig.capacity,
            limiter.tokens + (postElapsed * this.rateLimitConfig.refillRatePerSec)
        );
        limiter.tokens = Math.max(0, limiter.tokens - 1);
        limiter.lastRefill = postNow;
    }

    /**
     * Execute an operation safely with token rate limiting, quarantine guard,
     * adaptive 429 backoff retry, and automatic 401/403 detection.
     *
     * @param {string} token
     * @param {string} subsystem
     * @param {() => Promise<any>} operation
     * @param {{ maxWaitMs?: number, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', retryOn429?: boolean }} [options]
     * @returns {Promise<any>}
     */
    async executeWithToken(token, subsystem, operation, options = {}) {
        if (typeof operation !== 'function') {
            throw new TypeError('executeWithToken requires operation to be a function');
        }
        const hash = this.hashToken(token);
        if (!hash) {
            return operation();
        }

        if (this.isQuarantined(hash) && !options?.bypassQuarantine) {
            const details = this.getQuarantineDetails(hash);
            const err = new Error(`TOKEN_QUARANTINED: Token is quarantined (${details?.reason || 'Invalid/Revoked'})`);
            err.code = 'TOKEN_QUARANTINED';
            err.quarantine = details;
            throw err;
        }

        const maxAttempts = (options.retryOn429 !== false) ? 2 : 1;
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;
            await this._acquireRateLimitSlot(hash, options);

            try {
                const result = await operation();
                const state = this._getOrCreateState(hash);
                state.lastActivity = Date.now();
                return result;
            } catch (err) {
                const status = err?.status || err?.statusCode || err?.response?.status;
                const msg = String(err?.message || '');

                // Check HTTP 429 Too Many Requests
                const is429 = status === 429 || msg.includes('429') || msg.toLowerCase().includes('rate limit');
                if (is429) {
                    let waitSec = 2.5;
                    const headerVal = err?.response?.headers?.get?.('retry-after') || err?.headers?.['retry-after'];
                    if (headerVal && !isNaN(headerVal)) {
                        waitSec = parseFloat(headerVal);
                    } else if (err?.retry_after) {
                        waitSec = typeof err.retry_after === 'number' ? (err.retry_after > 100 ? err.retry_after / 1000 : err.retry_after) : 2.5;
                    }
                    const waitMs = Math.ceil(waitSec * 1000) + 100;
                    this.applyTokenBackoff(hash, waitMs, { subsystem, reason: '429_rate_limit', source: 'rest_api' });

                    if (attempt < maxAttempts) {
                        // Smooth pause and retry without dropping task
                        await new Promise((r) => setTimeout(r, waitMs));
                        continue;
                    }
                }

                // Check HTTP 401 Unauthorized / Invalid Token
                const is401 = status === 401 ||
                    msg.toLowerCase().includes('unauthorized') ||
                    msg.toLowerCase().includes('invalid token') ||
                    err?.code === 'TOKEN_INVALID';

                if (is401) {
                    this.quarantineToken(hash, `Detected by ${subsystem || 'unknown'}: ${msg || '401 Unauthorized'}`);
                }

                // Check HTTP 403 Forbidden / Locked Account
                const is403 = status === 403 || msg.includes('403') || msg.toLowerCase().includes('account locked');
                if (is403 && (msg.toLowerCase().includes('verification') || msg.toLowerCase().includes('locked'))) {
                    this.quarantineToken(hash, `Account Locked / Captcha Required: ${msg}`);
                }

                this.emit('token:error', { tokenHash: hash, subsystem, error: err });
                throw err;
            }
        }
    }

    /**
     * Universal Standard Task Runner for current and future subsystems
     * @param {string} token
     * @param {{ subsystem: string, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', timeoutMs?: number, retryOn429?: boolean, metadata?: object }} options
     * @param {() => Promise<any>} taskFn
     * @returns {Promise<any>}
     */
    async runTask(token, options, taskFn) {
        if (typeof taskFn !== 'function') {
            throw new TypeError('runTask requires taskFn to be a function');
        }
        const subsystem = options?.subsystem || 'genericTask';
        const timeoutMs = options?.timeoutMs ?? 30000;
        const hash = this.hashToken(token);

        if (hash) {
            this.acquireActivity(token, subsystem, options?.metadata || {});
        }

        let timeoutTimer;
        let timedOut = false;
        try {
            const taskPromise = this.executeWithToken(token, subsystem, taskFn, options);
            if (timeoutMs > 0) {
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutTimer = setTimeout(() => {
                        timedOut = true;
                        const err = new Error(`TASK_TIMEOUT: Subsystem ${subsystem} timed out after ${timeoutMs}ms`);
                        err.code = 'TASK_TIMEOUT';
                        reject(err);
                    }, timeoutMs);
                });
                taskPromise.catch(() => {}).finally(() => {
                    if (timedOut && hash) {
                        this.releaseActivity(token, subsystem);
                    }
                });
                return await Promise.race([taskPromise, timeoutPromise]);
            }
            return await taskPromise;
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (!timedOut && hash) {
                this.releaseActivity(token, subsystem);
            }
        }
    }

    /**
     * Quarantine a token across the entire system with alert throttling
     * @param {string} token
     * @param {string} [reason]
     * @returns {boolean}
     */
    quarantineToken(token, reason = 'Token Invalid or Revoked') {
        const hash = this.hashToken(token);
        if (!hash) return false;

        const safeReason = sanitizeLogText(String(reason || 'Token Invalid or Revoked'));
        const state = this._getOrCreateState(hash);
        const now = Date.now();
        state.quarantine = {
            quarantinedAt: now,
            reason: safeReason
        };
        state.lastActivity = now;

        // Invalidate cached profile
        this.profileCache.delete(hash);

        // Emit high-speed In-Memory event to all listeners
        this.emit('token:quarantined', { tokenHash: hash, reason: safeReason, state });

        // Notify registered subsystems to gracefully clean up
        for (const [subName, sub] of this.subsystems.entries()) {
            if (typeof sub?.onTokenQuarantined === 'function') {
                try {
                    sub.onTokenQuarantined(hash, safeReason, state);
                } catch {
                    // Safe swallow to avoid cascade
                }
            }
        }

        // Send alert webhook with throttling cooldown per token
        const lastAlert = this.alertHistory.get(hash) || 0;
        const shouldSendAlert = (now - lastAlert) > this.alertCooldownMs;

        if (shouldSendAlert) {
            this.alertHistory.set(hash, now);
            try {
                const { sendWebhookEvent } = require('./webhooks');
                if (typeof sendWebhookEvent === 'function') {
                    sendWebhookEvent({
                        target: 'ALERT',
                        severity: 'ERROR',
                        category: 'TOKEN',
                        code: 'token.quarantined',
                        state: 'OPEN',
                        title: 'QUARANTINED',
                        description: `ตรวจพบโทเคนหมดอายุหรือไม่ถูกต้อง ระบบได้กักกันและหยุดการทำงานที่เกี่ยวข้องอย่างปลอดภัย`,
                        fields: [
                            { name: 'สถานะ', value: 'OPEN' },
                            { name: 'ผลกระทบ', value: 'เซสชันหรือกิจกรรมที่ใช้โทเคนนี้จะถูกระงับชั่วคราว' },
                            { name: 'สิ่งที่ควรทำ', value: 'ตรวจสอบความถูกต้องของโทเคนหรือเปลี่ยนโทเคนใหม่ใน Dashboard' },
                            { name: 'Token Hash', value: `\`${hash.slice(0, 16)}...\`` },
                            { name: 'เหตุผล', value: safeReason }
                        ],
                        dedupeKey: `token-quarantine:${hash}`,
                        dedupeMs: this.alertCooldownMs
                    }).catch(() => {});
                }
            } catch {
                // Webhooks module not available in isolated unit tests
            }
        }

        return true;
    }

    /**
     * Release a token from quarantine
     * @param {string} token
     * @returns {boolean}
     */
    releaseQuarantine(token) {
        const hash = this.hashToken(token);
        if (!hash) return false;

        const state = this.tokenStates.get(hash);
        if (state) {
            state.quarantine = null;
            state.lastActivity = Date.now();
            this.alertHistory.delete(hash);
            this.emit('token:released', { tokenHash: hash });

            try {
                const { sendWebhookEvent } = require('./webhooks');
                if (typeof sendWebhookEvent === 'function') {
                    sendWebhookEvent({
                        target: 'LOG',
                        severity: 'SUCCESS',
                        category: 'TOKEN',
                        code: 'token.quarantine_released',
                        title: 'QUARANTINE RELEASED',
                        description: `ปลดการกักกันโทเคนสำเร็จ โทเคนสามารถกลับมาใช้งานได้ตามปกติ`,
                        fields: [
                            { name: 'ผู้ดำเนินการ', value: 'Token Coordinator' },
                            { name: 'เป้าหมาย', value: `\`${hash.slice(0, 16)}...\`` },
                            { name: 'การกระทำ', value: 'release quarantine' },
                            { name: 'ผลลัพธ์', value: 'ปลดกักกันสำเร็จ' }
                        ]
                    }).catch(() => {});
                }
            } catch {}

            if ((!state.activities || state.activities.size === 0) && !state.voice && !state.quest) {
                this.tokenStates.delete(hash);
            }
            return true;
        }
        return false;
    }

    /**
     * Check if a token is currently quarantined
     * @param {string} token
     * @returns {boolean}
     */
    isQuarantined(token) {
        const hash = this.hashToken(token);
        return Boolean(this.tokenStates.get(hash)?.quarantine);
    }

    /**
     * Get details of quarantine for a token
     * @param {string} token
     * @returns {{ quarantinedAt: number, reason: string } | null}
     */
    getQuarantineDetails(token) {
        const hash = this.hashToken(token);
        return this.tokenStates.get(hash)?.quarantine || null;
    }

    /**
     * Cache a token profile in memory with a TTL and bounded pruning
     * @param {string} token
     * @param {object} profile
     * @param {number} [ttlMs] Default: 20 minutes
     */
    cacheTokenProfile(token, profile, ttlMs = 20 * 60 * 1000) {
        const hash = this.hashToken(token);
        if (!hash || !profile) return;

        // Bounded pruning if cache grows over 2000 entries
        if (this.profileCache.size > 2000) {
            const now = Date.now();
            for (const [k, v] of this.profileCache.entries()) {
                if (v.expiresAt <= now) {
                    this.profileCache.delete(k);
                }
            }
        }

        this.profileCache.set(hash, {
            profile,
            cachedAt: Date.now(),
            expiresAt: Date.now() + ttlMs
        });

        const state = this._getOrCreateState(token);
        if (profile.isBot || profile.tokenType === 'bot' || profile.category === 'bot') {
            state.tokenType = 'bot';
            if (!profile.tokenType) profile.tokenType = 'bot';
        } else if (profile.tokenType === 'user' || profile.valid) {
            state.tokenType = 'user';
            if (!profile.tokenType) profile.tokenType = 'user';
        }
    }

    /**
     * Get cached token profile if present and not expired
     * @param {string} token
     * @returns {object | null}
     */
    getCachedTokenProfile(token) {
        const hash = this.hashToken(token);
        if (!hash) return null;

        const entry = this.profileCache.get(hash);
        if (!entry) return null;

        if (entry.expiresAt <= Date.now()) {
            this.profileCache.delete(hash);
            return null;
        }

        return entry.profile;
    }

    /**
     * Clear token profile cache (single token or all)
     * @param {string} [token]
     */
    clearTokenProfileCache(token = null) {
        if (token) {
            this.profileCache.delete(this.hashToken(token));
        } else {
            this.profileCache.clear();
        }
    }

    /**
     * Get status summary for monitoring and Owner Dashboard API
     * @returns {object}
     */
    getStatusSummary() {
        const states = Array.from(this.tokenStates.entries());
        const voiceSessions = states.filter(([_, s]) => Boolean(s.voice)).map(([hash, s]) => ({
            tokenHash: hash,
            guildId: s.voice.guildId,
            channelId: s.voice.channelId,
            sessionId: s.voice.sessionId,
            activeAt: s.voice.activeAt
        }));

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
        this.tokenStates.clear();
        this.tokenLocks.clear();
        this.subsystems.clear();
        this.profileCache.clear();
        this.alertHistory.clear();
        this.removeAllListeners();
        attachTelemetryListeners(this);
    }
}

function attachTelemetryListeners(coordinator) {
    function getSessionEventRepo() {
        try {
            const db = require("../../database");
            return db?.repositories?.sessionEvent || null;
        } catch (_) {
            return null;
        }
    }

    coordinator.on("token:rate_limited", ({ tokenHash, subsystem, backoffSeconds, waitMs, reason, source }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                const retryAfter = backoffSeconds || (waitMs ? Math.ceil(waitMs / 1000) : 0);
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : "global",
                    eventType: "rate_limit_429",
                    priority: "P1",
                    metadata: {
                        source: source || "rest_api",
                        event: "rate_limit",
                        retryAfter,
                        subsystem: subsystem || "unknown",
                        backoffSeconds: retryAfter,
                        reason: sanitizeLogText(reason || "429_backoff")
                    }
                });
            }
        } catch (_) {}
    });

    coordinator.on("token:quarantined", ({ tokenHash, reason, state }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : "global",
                    eventType: "quarantined",
                    priority: "P1",
                    metadata: { reason: sanitizeLogText(reason || "quarantined"), state: state?.tokenType || "unknown" }
                });
            }
        } catch (_) {}
    });

    coordinator.on("token:released", ({ tokenHash }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : "global",
                    eventType: "quarantine_cleared",
                    metadata: {}
                });
            }
        } catch (_) {}
    });

    coordinator.on("token:error", ({ tokenHash, subsystem, error }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : "global",
                    eventType: "token_error",
                    metadata: { subsystem, error: safeError(error) }
                });
            }
        } catch (_) {}
    });
}

// Singleton instance across the unified runtime
const tokenCoordinator = new TokenCoordinator();
attachTelemetryListeners(tokenCoordinator);

module.exports = tokenCoordinator;
module.exports.TokenCoordinator = TokenCoordinator;
module.exports.attachTelemetryListeners = attachTelemetryListeners;
