'use strict';

/**
 * Run an operation with token-level serialized mutual exclusion
 * to prevent race conditions and conflicting concurrent requests.
 * @param {object} coordinator
 * @param {string} token
 * @param {() => Promise<any>} operation
 * @returns {Promise<any>}
 */
async function withTokenLock(coordinator, token, operation) {
    const hash = coordinator.hashToken(token);
    if (!hash) return operation();

    const previous = coordinator.tokenLocks.get(hash) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => gate);
    coordinator.tokenLocks.set(hash, queued);

    await previous.catch(() => {});
    try {
        return await operation();
    } finally {
        release();
        if (coordinator.tokenLocks.get(hash) === queued) {
            coordinator.tokenLocks.delete(hash);
        }
    }
}

function _checkAndQuarantineOnAuthError(coordinator, hash, subsystem, err) {
    const status = err?.status || err?.statusCode || err?.response?.status;
    const msg = String(err?.message || '');

    const is401 = status === 401 ||
        msg.toLowerCase().includes('unauthorized') ||
        msg.toLowerCase().includes('invalid token') ||
        err?.code === 'TOKEN_INVALID';

    if (is401) {
        coordinator.quarantineToken(hash, `Detected by ${subsystem || 'unknown'}: ${msg || '401 Unauthorized'}`);
        return;
    }

    const is403 = status === 403 || msg.includes('403') || msg.toLowerCase().includes('account locked');
    if (is403 && (msg.toLowerCase().includes('verification') || msg.toLowerCase().includes('locked'))) {
        coordinator.quarantineToken(hash, `Account Locked / Captcha Required: ${msg}`);
    }
}

async function _executeTokenAttempt(coordinator, hash, operation, options) {
    await coordinator._acquireRateLimitSlot(hash, options);
    const result = await operation();
    const state = coordinator._getOrCreateState(hash);
    state.lastActivity = Date.now();
    return result;
}

async function _handle429Retry(coordinator, hash, subsystem, operation, options, firstErr) {
    const rawWaitMs = coordinator._parse429WaitMs(firstErr);
    const waitMs = Number.isFinite(rawWaitMs) && rawWaitMs >= 0
        ? Math.max(300, Math.min(Math.floor(rawWaitMs), 60000))
        : 2500;
    coordinator.applyTokenBackoff(hash, waitMs, { subsystem, reason: '429_rate_limit', source: 'rest_api' });
    await new Promise((r) => setTimeout(r, waitMs));
    if (options?.signal?.aborted) {
        const abortErr = options.signal.reason || new Error('This operation was aborted');
        throw abortErr;
    }
    try {
        return await _executeTokenAttempt(coordinator, hash, operation, options);
    } catch (retryErr) {
        _checkAndQuarantineOnAuthError(coordinator, hash, subsystem, retryErr);
        coordinator.emit('token:error', { tokenHash: hash, subsystem, error: retryErr });
        throw retryErr;
    }
}

/**
 * Execute an operation safely with token rate limiting, quarantine guard,
 * adaptive 429 backoff retry, and automatic 401/403 detection.
 *
 * @param {object} coordinator
 * @param {string} token
 * @param {string} subsystem
 * @param {() => Promise<any>} operation
 * @param {{ maxWaitMs?: number, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', retryOn429?: boolean, bypassQuarantine?: boolean }} [options]
 * @returns {Promise<any>}
 */
async function executeWithToken(coordinator, token, subsystem, operation, options = {}) {
    if (typeof operation !== 'function') {
        throw new TypeError('executeWithToken requires operation to be a function');
    }
    const hash = coordinator.hashToken(token);
    if (!hash) {
        return operation();
    }

    if (coordinator.isQuarantined(hash) && !options?.bypassQuarantine) {
        const details = coordinator.getQuarantineDetails(hash);
        const err = new Error(`TOKEN_QUARANTINED: Token is quarantined (${details?.reason || 'Invalid/Revoked'})`);
        err.code = 'TOKEN_QUARANTINED';
        err.quarantine = details;
        throw err;
    }

    const canRetry = options.retryOn429 !== false;

    try {
        return await _executeTokenAttempt(coordinator, hash, operation, options);
    } catch (firstErr) {
        if (canRetry && coordinator._is429Error(firstErr)) {
            return await _handle429Retry(coordinator, hash, subsystem, operation, options, firstErr);
        }

        _checkAndQuarantineOnAuthError(coordinator, hash, subsystem, firstErr);
        coordinator.emit('token:error', { tokenHash: hash, subsystem, error: firstErr });
        throw firstErr;
    }
}

/**
 * Universal Standard Task Runner for current and future subsystems
 * @param {object} coordinator
 * @param {string} token
 * @param {{ subsystem: string, priority?: 'CRITICAL'|'NORMAL'|'BACKGROUND', timeoutMs?: number, retryOn429?: boolean, metadata?: object, signal?: any }} options
 * @param {() => Promise<any>} taskFn
 * @returns {Promise<any>}
 */
async function runTask(coordinator, token, options, taskFn) {
    if (typeof taskFn !== 'function') {
        throw new TypeError('runTask requires taskFn to be a function');
    }
    const subsystem = options?.subsystem || 'genericTask';
    const timeoutMs = options?.timeoutMs ?? 30000;
    const hash = coordinator.hashToken(token);

    if (hash) {
        coordinator.acquireActivity(token, subsystem, options?.metadata || {});
    }

    let timeoutTimer = null;
    let timedOut = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (options?.signal && controller) {
        if (options.signal.aborted) {
            controller.abort(options.signal.reason);
        } else {
            options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
        }
    }

    try {
        const wrappedFn = () => {
            if (taskFn.length > 0) {
                return taskFn({ signal: controller?.signal });
            }
            return taskFn();
        };

        const executionOptions = controller?.signal
            ? { ...options, signal: controller.signal }
            : options;
        const taskPromise = coordinator.executeWithToken(token, subsystem, wrappedFn, executionOptions);
        if (timeoutMs > 0) {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutTimer = setTimeout(() => {
                    timedOut = true;
                    const err = new Error(`TASK_TIMEOUT: Subsystem ${subsystem} timed out after ${timeoutMs}ms`);
                    err.code = 'TASK_TIMEOUT';
                    if (controller) controller.abort(err);
                    reject(err);
                }, timeoutMs);
                timeoutTimer?.unref?.();
            });
            taskPromise.catch(() => {}).finally(() => {
                if (timedOut && hash) {
                    coordinator.releaseActivity(token, subsystem);
                }
            });
            return await Promise.race([taskPromise, timeoutPromise]);
        }
        return await taskPromise;
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (!timedOut && hash) {
            coordinator.releaseActivity(token, subsystem);
        }
    }
}

module.exports = {
    withTokenLock,
    _checkAndQuarantineOnAuthError,
    _executeTokenAttempt,
    executeWithToken,
    runTask
};
