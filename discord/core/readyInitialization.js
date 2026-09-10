"use strict";

function parseRetryDelay(requestedRetryMs) {
    const parsedRetryMs = Number(requestedRetryMs);
    return Number.isFinite(parsedRetryMs)
        ? Math.max(100, parsedRetryMs)
        : 10000;
}

class ReadyInitializationController {
    constructor(options = {}) {
        if (typeof options.initialize !== "function") throw new TypeError("initialize must be a function");
        this.initialize = options.initialize;
        this.isReady = options.isReady || (() => true);
        this.isShuttingDown = options.isShuttingDown || (() => false);
        this.onError = options.onError || (() => {});
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;
        this.retryMs = parseRetryDelay(options.retryMs ?? 10000);
        this.inFlight = null;
        this.retryTimer = null;
        this.completed = false;
        this.stopped = false;
        this.attempts = 0;
        this.lastError = null;
    }

    clearRetry() {
        if (!this.retryTimer) return;
        this.clearTimer(this.retryTimer);
        this.retryTimer = null;
    }

    canScheduleRetry() {
        return !this.stopped && !this.completed && !this.retryTimer && !this.isShuttingDown();
    }

    canStart() {
        return !this.stopped && !this.isShuttingDown() && this.isReady();
    }

    scheduleRetry() {
        if (!this.canScheduleRetry()) return false;
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            if (this.canStart()) this.start();
        }, this.retryMs);
        this.retryTimer?.unref?.();
        return true;
    }

    start() {
        if (this.stopped) return Promise.resolve(false);
        if (this.completed) return Promise.resolve(true);
        if (!this.canStart()) return Promise.resolve(false);
        if (this.inFlight) return this.inFlight;
        this.attempts++;
        this.inFlight = Promise.resolve()
            .then(() => this.initialize())
            .then(() => {
                this.completed = true;
                this.lastError = null;
                this.clearRetry();
                return true;
            })
            .catch(error => {
                this.lastError = error;
                this.onError(error, this.attempts);
                this.scheduleRetry();
                return false;
            })
            .finally(() => {
                this.inFlight = null;
            });
        return this.inFlight;
    }

    stop() {
        this.stopped = true;
        this.clearRetry();
    }

    diagnostics() {
        return {
            completed: this.completed,
            stopped: this.stopped,
            inFlight: Boolean(this.inFlight),
            retryScheduled: Boolean(this.retryTimer),
            retryMs: this.retryMs,
            attempts: this.attempts,
            lastError: this.lastError?.code || this.lastError?.name || this.lastError?.message || null
        };
    }
}

function createReadyInitializationController(options = {}) {
    const controller = new ReadyInitializationController(options);
    return {
        start: controller.start.bind(controller),
        stop: controller.stop.bind(controller),
        diagnostics: controller.diagnostics.bind(controller)
    };
}

module.exports = { createReadyInitializationController };
