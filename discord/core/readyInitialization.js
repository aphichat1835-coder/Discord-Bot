"use strict";

function createReadyInitializationController(options = {}) {
    if (typeof options.initialize !== "function") throw new TypeError("initialize must be a function");
    const isReady = options.isReady || (() => true);
    const isShuttingDown = options.isShuttingDown || (() => false);
    const onError = options.onError || (() => {});
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const requestedRetryMs = options.retryMs ?? 10000;
    const parsedRetryMs = Number(requestedRetryMs);
    const retryMs = Number.isFinite(parsedRetryMs)
        ? Math.max(100, parsedRetryMs)
        : 10000;
    let inFlight = null;
    let retryTimer = null;
    let completed = false;
    let stopped = false;
    let attempts = 0;
    let lastError = null;

    function clearRetry() {
        if (!retryTimer) return;
        clearTimer(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry() {
        if (stopped || completed || retryTimer || isShuttingDown()) return false;
        retryTimer = setTimer(() => {
            retryTimer = null;
            if (!stopped && !isShuttingDown() && isReady()) start();
        }, retryMs);
        retryTimer?.unref?.();
        return true;
    }

    function start() {
        if (stopped) return Promise.resolve(false);
        if (completed) return Promise.resolve(true);
        if (isShuttingDown() || !isReady()) return Promise.resolve(false);
        if (inFlight) return inFlight;
        attempts++;
        inFlight = Promise.resolve()
            .then(() => options.initialize())
            .then(() => {
                completed = true;
                lastError = null;
                clearRetry();
                return true;
            })
            .catch(error => {
                lastError = error;
                onError(error, attempts);
                scheduleRetry();
                return false;
            })
            .finally(() => {
                inFlight = null;
            });
        return inFlight;
    }

    function stop() {
        stopped = true;
        clearRetry();
    }

    function diagnostics() {
        return {
            completed,
            stopped,
            inFlight: Boolean(inFlight),
            retryScheduled: Boolean(retryTimer),
            retryMs,
            attempts,
            lastError: lastError?.code || lastError?.name || lastError?.message || null
        };
    }

    return { start, stop, diagnostics };
}

module.exports = { createReadyInitializationController };
