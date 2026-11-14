'use strict';

/**
 * Apply backoff to a token (e.g. from HTTP 429 Retry-After)
 * @param {object} coordinator
 * @param {string} token
 * @param {number} durationMs
 * @param {object|string} [options]
 */
function applyTokenBackoff(coordinator, token, durationMs, options = {}) {
    const hash = coordinator.hashToken(token);
    if (!hash) return;
    const subsystem = typeof options === 'string' ? options : (options?.subsystem || null);
    const reason = (typeof options === 'object' && options?.reason) || '429_backoff';
    const source = (typeof options === 'object' && options?.source) || 'rest_api';
    const state = coordinator._getOrCreateState(hash);
    const until = Date.now() + Math.max(300, Number(durationMs) || 2000);
    state.backoffUntil = Math.max(state.backoffUntil || 0, until);
    const waitMs = Math.max(0, state.backoffUntil - Date.now());
    const backoffSeconds = Math.ceil(waitMs / 1000);
    coordinator.emit('token:rate_limited', {
        tokenHash: hash,
        subsystem,
        backoffUntil: state.backoffUntil,
        waitMs,
        backoffSeconds,
        reason,
        source
    });

    // Repump queue to respect new backoff deadline
    if (state.rateLimiter) {
        _pumpRateLimitQueue(coordinator, hash);
    }

    if (backoffSeconds >= 15) {
        try {
            const { sendWebhookEvent } = require('../../core/webhooks');
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

function _refillTokens(coordinator, limiter) {
    const now = Date.now();
    const elapsedSec = (now - limiter.lastRefill) / 1000;
    if (elapsedSec > 0) {
        limiter.tokens = Math.min(
            coordinator.rateLimitConfig.capacity,
            limiter.tokens + (elapsedSec * coordinator.rateLimitConfig.refillRatePerSec)
        );
        limiter.lastRefill = now;
    }
}

function _processQueueHead(coordinator, limiter) {
    const head = limiter.queue[0];
    if (head.cancelled) {
        limiter.queue.shift();
        return { processed: true };
    }

    const isCritical = head.priority === 'CRITICAL';
    const cost = 1;
    const canAcquire = isCritical ? limiter.tokens >= 0.5 : limiter.tokens >= cost;

    if (canAcquire) {
        limiter.queue.shift();
        if (head.timer) clearTimeout(head.timer);
        limiter.tokens = Math.max(0, limiter.tokens - cost);
        head.resolve();
        return { processed: true };
    }

    const needed = (isCritical ? 0.5 : 1) - limiter.tokens;
    const waitMs = Math.max(10, Math.ceil((needed / coordinator.rateLimitConfig.refillRatePerSec) * 1000));
    return { processed: false, waitMs };
}

function _pumpRateLimitQueue(coordinator, tokenHash) {
    const state = coordinator.tokenStates.get(tokenHash);
    if (!state?.rateLimiter) return;
    const limiter = state.rateLimiter;
    if (limiter.pumpTimer) {
        clearTimeout(limiter.pumpTimer);
        limiter.pumpTimer = null;
    }

    const now = Date.now();
    if (state.backoffUntil && state.backoffUntil > now) {
        const waitMs = state.backoffUntil - now;
        limiter.pumpTimer = setTimeout(() => _pumpRateLimitQueue(coordinator, tokenHash), waitMs + 5);
        return;
    }

    _refillTokens(coordinator, limiter);

    while (limiter.queue && limiter.queue.length > 0) {
        const { processed, waitMs } = _processQueueHead(coordinator, limiter);
        if (!processed) {
            limiter.pumpTimer = setTimeout(() => _pumpRateLimitQueue(coordinator, tokenHash), waitMs);
            break;
        }
    }
}

/**
 * Acquire a rate limit slot for a token using queue-based reservation
 * @param {object} coordinator
 * @param {string} tokenHash
 * @param {{ maxWaitMs?: number, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', signal?: any }} [options]
 */
async function _acquireRateLimitSlot(coordinator, tokenHash, options = {}) {
    if (!tokenHash) return;
    const maxWaitMs = options.maxWaitMs ?? 20000;
    const priority = String(options.priority || 'NORMAL').toUpperCase();
    const state = coordinator._getOrCreateState(tokenHash);
    const limiter = state.rateLimiter;

    const now = Date.now();
    if (state.backoffUntil && state.backoffUntil > now) {
        const backoffWaitMs = state.backoffUntil - now;
        if (backoffWaitMs > maxWaitMs) {
            const err = new Error(`RATE_LIMIT_BACKOFF: Token backoff wait ${backoffWaitMs}ms > max ${maxWaitMs}ms`);
            err.code = 'RATE_LIMIT_BACKOFF';
            throw err;
        }
    }

    _refillTokens(coordinator, limiter);

    if (options?.signal?.aborted) {
        const abortErr = options.signal.reason || new Error('This operation was aborted');
        throw abortErr;
    }

    const inBackoff = Boolean(state.backoffUntil && state.backoffUntil > now);
    if (!inBackoff && (!limiter.queue || limiter.queue.length === 0)) {
        if (priority === 'CRITICAL' && limiter.tokens >= 0.5) {
            limiter.tokens = Math.max(0, limiter.tokens - 1);
            return;
        }
        if (limiter.tokens >= 1) {
            limiter.tokens -= 1;
            return;
        }
    }

    return new Promise((resolve, reject) => {
        let onAbort = null;
        const cleanupAbort = () => {
            if (options?.signal && onAbort) {
                try {
                    options.signal.removeEventListener('abort', onAbort);
                } catch {}
            }
        };

        const ticket = {
            resolve: () => {
                cleanupAbort();
                resolve();
            },
            reject: (err) => {
                cleanupAbort();
                reject(err);
            },
            priority,
            maxWaitMs,
            enqueuedAt: Date.now(),
            timer: null,
            cancelled: false
        };

        if (options?.signal) {
            onAbort = () => {
                ticket.cancelled = true;
                if (ticket.timer) clearTimeout(ticket.timer);
                if (limiter.queue) {
                    const idx = limiter.queue.indexOf(ticket);
                    if (idx !== -1) limiter.queue.splice(idx, 1);
                }
                ticket.reject(options.signal.reason || new Error('This operation was aborted'));
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
        }

        ticket.timer = setTimeout(() => {
            ticket.cancelled = true;
            cleanupAbort();
            if (limiter.queue) {
                const idx = limiter.queue.indexOf(ticket);
                if (idx !== -1) limiter.queue.splice(idx, 1);
            }
            const waitTime = Date.now() - ticket.enqueuedAt;
            const err = new Error(`RATE_LIMIT_TIMEOUT: Token rate limit capacity exhausted (wait ${waitTime}ms > max ${maxWaitMs}ms)`);
            err.code = 'RATE_LIMIT_TIMEOUT';
            reject(err);
        }, maxWaitMs);

        if (!limiter.queue) limiter.queue = [];
        const priorityWeight = { CRITICAL: 0, NORMAL: 1, BACKGROUND: 2 };
        const ticketWeight = priorityWeight[priority] ?? 1;
        let insertIdx = limiter.queue.length;
        for (let i = 0; i < limiter.queue.length; i++) {
            const existingWeight = priorityWeight[limiter.queue[i].priority] ?? 1;
            if (ticketWeight < existingWeight) {
                insertIdx = i;
                break;
            }
        }
        limiter.queue.splice(insertIdx, 0, ticket);

        _pumpRateLimitQueue(coordinator, tokenHash);
    });
}

function _extractHeaderRetryAfter(err) {
    const headerVal = err?.response?.headers?.get?.('retry-after') ||
        err?.headers?.['retry-after'] ||
        err?.headers?.['Retry-After'];
    if (headerVal === undefined || headerVal === null) {
        return null;
    }
    const parsed = Number.parseFloat(String(headerVal).trim());
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 60) : null;
}

function _extractBodyRetryAfter(err) {
    if (typeof err?.retryAfter === 'number' && Number.isFinite(err.retryAfter) && err.retryAfter >= 0) {
        return err.retryAfter / 1000;
    }
    const rawSec = err?.retry_after ?? err?.rawError?.retry_after;
    if (typeof rawSec === 'number' && Number.isFinite(rawSec) && rawSec >= 0) {
        return rawSec >= 20 ? rawSec / 1000 : rawSec;
    }
    return null;
}

function _parse429WaitMs(err) {
    const headerWait = _extractHeaderRetryAfter(err);
    const bodyWait = headerWait === null ? _extractBodyRetryAfter(err) : null;
    const waitSec = headerWait ?? bodyWait ?? 2.5;
    const calculatedMs = Math.max(300, Math.ceil(waitSec * 1000) + 100);
    return Math.min(calculatedMs, 60000);
}

function _is429Error(err) {
    if (err?.code === 'RATE_LIMIT_TIMEOUT' || err?.code === 'RATE_LIMIT_BACKOFF') {
        return false;
    }
    const status = err?.status || err?.statusCode || err?.response?.status;
    const msg = String(err?.message || '');
    return status === 429 || msg.includes('429') || (msg.toLowerCase().includes('rate limit') && !msg.startsWith('RATE_LIMIT_'));
}

module.exports = {
    applyTokenBackoff,
    _refillTokens,
    _processQueueHead,
    _pumpRateLimitQueue,
    _acquireRateLimitSlot,
    _parse429WaitMs,
    _is429Error
};
