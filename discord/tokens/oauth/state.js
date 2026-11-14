"use strict";

const { DEFAULT_REFRESH_INTERVAL_MS } = require("./config");

const refreshLocks = new Map();

let backgroundTimer = null;
let backgroundIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
let isStarted = false;
let startPromise = null;
let refreshInFlight = false;
let inFlightRefreshPromise = null;
let backgroundOptions = {};

const diagnosticStats = {
    startedAt: null,
    stoppedAt: null,
    totalRefreshes: 0,
    successfulRefreshes: 0,
    failedRefreshes: 0,
    revokedCount: 0,
    conflictCount: 0,
    lastRefreshAt: null,
    lastRefreshSummary: null,
    lastError: null
};

function dispatchOAuthAlert(event, options = {}) {
    try {
        const { sendWebhookEvent } = require("../../core/webhooks");
        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                target: "ALERT",
                category: "TOKEN",
                ...event
            }, options).catch(() => {});
        }
    } catch {
        // webhooks module may not be present in isolated test runners
    }
}

function getDiagnostics() {
    return {
        running: isStarted,
        timerActive: !!backgroundTimer,
        inFlight: refreshInFlight,
        backgroundIntervalMs,
        activeRefreshLocks: refreshLocks.size,
        ...diagnosticStats
    };
}

function resetInternalStateForTesting() {
    if (backgroundTimer) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
    }
    isStarted = false;
    startPromise = null;
    refreshInFlight = false;
    inFlightRefreshPromise = null;
    backgroundOptions = {};
    refreshLocks.clear();
    diagnosticStats.totalRefreshes = 0;
    diagnosticStats.successfulRefreshes = 0;
    diagnosticStats.failedRefreshes = 0;
    diagnosticStats.revokedCount = 0;
    diagnosticStats.conflictCount = 0;
    diagnosticStats.lastRefreshAt = null;
    diagnosticStats.lastRefreshSummary = null;
    diagnosticStats.lastError = null;
}

module.exports = {
    refreshLocks,
    diagnosticStats,
    dispatchOAuthAlert,
    getDiagnostics,
    resetInternalStateForTesting,
    get backgroundTimer() { return backgroundTimer; },
    set backgroundTimer(val) { backgroundTimer = val; },
    get backgroundIntervalMs() { return backgroundIntervalMs; },
    set backgroundIntervalMs(val) { backgroundIntervalMs = val; },
    get isStarted() { return isStarted; },
    set isStarted(val) { isStarted = val; },
    get startPromise() { return startPromise; },
    set startPromise(val) { startPromise = val; },
    get refreshInFlight() { return refreshInFlight; },
    set refreshInFlight(val) { refreshInFlight = val; },
    get inFlightRefreshPromise() { return inFlightRefreshPromise; },
    set inFlightRefreshPromise(val) { inFlightRefreshPromise = val; },
    get backgroundOptions() { return backgroundOptions; },
    set backgroundOptions(val) { backgroundOptions = val; }
};
