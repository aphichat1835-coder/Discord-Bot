'use strict';

const { TokenCoordinator } = require('./coordinator');
const { attachTelemetryListeners, getSessionEventRepo } = require('./telemetry');

// Singleton instance across the unified runtime
const tokenCoordinator = new TokenCoordinator();
attachTelemetryListeners(tokenCoordinator);

module.exports = tokenCoordinator;
module.exports.TokenCoordinator = TokenCoordinator;
module.exports.attachTelemetryListeners = attachTelemetryListeners;
module.exports.getSessionEventRepo = getSessionEventRepo;
