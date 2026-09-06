'use strict';

const { abortableDelay, abortFailure } = require('./abortableDelay');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class RequestTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Request timed out after ${timeoutMs}ms`);
        this.name = 'RequestTimeoutError';
        this.code = 'ETIMEDOUT';
    }
}

function wait(ms, signal) {
    return abortableDelay(ms, signal);
}

async function waitForRetry(ms, signal, waitFn) {
    if (waitFn) return waitFn(ms, signal);
    return wait(ms, signal);
}

async function retryAfterMs(response) {
    const header = response.headers?.get?.('retry-after')
        ?? response.headers?.get?.('x-ratelimit-reset-after');
    const headerSeconds = Number.parseFloat(header);
    if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
        return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(headerSeconds * 1000));
    }

    try {
        const body = await response.clone().json();
        const seconds = Number(body?.retry_after);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
        }
    } catch {}
    return null;
}

async function fetchAttempt(fetchFn, url, options, timeoutMs) {
    const externalSignal = options.signal;
    if (externalSignal?.aborted) throw abortFailure();

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        return await fetchFn(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (externalSignal?.aborted) throw abortFailure();
        if (timedOut) throw new RequestTimeoutError(timeoutMs);
        throw error;
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', onAbort);
    }
}

function mayRetryUnsafeRequest(method, policy) {
    return SAFE_METHODS.has(method) || policy.retryUnsafe === true;
}

function shouldRetryResponse(response, method, policy) {
    if (response.status === 429) return policy.retryRateLimits !== false;
    if (response.status >= 500) return mayRetryUnsafeRequest(method, policy);
    return false;
}

function retryBackoffMs(attempt, baseDelayMs, random) {
    return Math.min(
        MAX_RETRY_DELAY_MS,
        baseDelayMs * (2 ** attempt) + Math.floor(random() * 250),
    );
}

async function consumeRetryableResponse(response, context) {
    const {
        attempt,
        maxRetries,
        method,
        policy,
        baseDelayMs,
        random,
        signal,
        waitFn,
    } = context;
    if (!shouldRetryResponse(response, method, policy) || attempt === maxRetries) {
        return true;
    }

    const rateLimitDelay = response.status === 429 ? await retryAfterMs(response) : null;
    await response.arrayBuffer().catch(() => {});
    await waitForRetry(
        rateLimitDelay ?? retryBackoffMs(attempt, baseDelayMs, random),
        signal,
        waitFn,
    );
    return false;
}

async function handleFetchFailure(error, context) {
    const {
        attempt,
        maxRetries,
        method,
        policy,
        baseDelayMs,
        random,
        signal,
        waitFn,
    } = context;
    if (signal?.aborted || error?.message === 'aborted') throw error;
    if (attempt === maxRetries || !mayRetryUnsafeRequest(method, policy)) throw error;
    await waitForRetry(retryBackoffMs(attempt, baseDelayMs, random), signal, waitFn);
    return error;
}

async function fetchWithRetry(url, options = {}, policy = {}) {
    const {
        fetchFn = globalThis.fetch,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxRetries = DEFAULT_MAX_RETRIES,
        baseDelayMs = 1000,
        random = Math.random,
        waitFn = null,
    } = policy;
    const method = String(options.method ?? 'GET').toUpperCase();
    const retryContext = {
        maxRetries,
        method,
        policy,
        baseDelayMs,
        random,
        signal: options.signal,
        waitFn,
    };

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchAttempt(fetchFn, url, options, timeoutMs);
            const done = await consumeRetryableResponse(response, { ...retryContext, attempt });
            if (done) return response;
        } catch (error) {
            lastError = await handleFetchFailure(error, { ...retryContext, attempt });
        }
    }
    throw lastError;
}

module.exports = {
    fetchWithRetry,
    RequestTimeoutError,
    wait
};
