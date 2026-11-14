'use strict';

const { safeError, sanitizeLogText } = require('../../core/safeLogger');

function getSessionEventRepo() {
    try {
        const db = require('../../../database');
        return db?.repositories?.sessionEvent || null;
    } catch (err) {
        // Ignored: database repository is optional during isolated token coordinator tests
        if (process.env.DEBUG_TELEMETRY) {
            console.debug('[TokenCoordinator] SessionEvent repository unavailable:', err.message);
        }
        return null;
    }
}

function attachTelemetryListeners(coordinator) {
    coordinator.on('token:rate_limited', ({ tokenHash, subsystem, backoffSeconds, waitMs, reason, source }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                const retryAfter = backoffSeconds || (waitMs ? Math.ceil(waitMs / 1000) : 0);
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : 'global',
                    eventType: 'rate_limit_429',
                    priority: 'P1',
                    metadata: {
                        source: source || 'rest_api',
                        event: 'rate_limit',
                        retryAfter,
                        subsystem: subsystem || 'unknown',
                        backoffSeconds: retryAfter,
                        reason: sanitizeLogText(reason || '429_backoff')
                    }
                });
            }
        } catch (err) {
            // Silently ignore telemetry failure during rate limit recording
        }
    });

    coordinator.on('token:quarantined', ({ tokenHash, reason, state }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : 'global',
                    eventType: 'quarantined',
                    priority: 'P1',
                    metadata: { reason: sanitizeLogText(reason || 'quarantined'), state: state?.tokenType || 'unknown' }
                });
            }
        } catch (err) {
            // Silently ignore telemetry failure during quarantine recording
        }
    });

    coordinator.on('token:released', ({ tokenHash }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : 'global',
                    eventType: 'quarantine_cleared',
                    metadata: {}
                });
            }
        } catch (err) {
            // Silently ignore telemetry failure during release recording
        }
    });

    coordinator.on('token:error', ({ tokenHash, subsystem, error }) => {
        try {
            const repo = getSessionEventRepo();
            if (repo) {
                repo.record({
                    sessionId: tokenHash ? tokenHash.slice(0, 16) : 'global',
                    eventType: 'token_error',
                    metadata: { subsystem, error: safeError(error) }
                });
            }
        } catch (err) {
            // Silently ignore telemetry failure during token error recording
        }
    });
}

module.exports = {
    getSessionEventRepo,
    attachTelemetryListeners
};
