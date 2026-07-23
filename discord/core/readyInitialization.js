"use strict";

function createReadyInitializationController(options = {}) {
    if (typeof options.initialize !== "function") throw new TypeError("initialize must be a function");
    const isReady = options.isReady || (() => true);
    const isShuttingDown = options.isShuttingDown || (() => false);
    const onError = options.onError || (() => {});
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const retryMs = Math.max(100, Number(options.retryMs || 10000));
    let inFlight = null, retryTimer = null, completed = false, attempts = 0, lastError = null;

    function clearRetry() {
        if (!retryTimer) return;
        clearTimer(retryTimer); retryTimer = null;
    }
    function scheduleRetry() {
        if (completed || retryTimer || isShuttingDown()) return false;
        retryTimer = setTimer(() => {
  retryTimer = null;
  if (!isShuttingDown() && isReady()) start();
        }, retryMs);
        retryTimer?.unref?.();
        return true;
    }
    function start() {
        if (completed) return Promise.resolve(true);
        if (isShuttingDown() || !isReady()) return Promise.resolve(false);
        if (inFlight) return inFlight;
        attempts++;
        inFlight = Promise.resolve().then(() => options.initialize()).then(() => {
  completed = true; lastError = null; clearRetry(); return true;
        }).catch(error => {
  lastError = error; onError(error, attempts); scheduleRetry(); return false;
        }).finally(() => { inFlight = null; });
        return inFlight;
    }
    function stop() { clearRetry(); }
    function diagnostics() {
        return { completed, inFlight: Boolean(inFlight), retryScheduled: Boolean(retryTimer), attempts,
  lastError: lastError?.code || lastError?.name || lastError?.message || null };
    }
    return { start, stop, diagnostics };
}

module.exports = { createReadyInitializationController };
