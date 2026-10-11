/* eslint-disable complexity -- Voice/session lifecycle is behavior-sensitive; refactor separately. */
/**
 * Voice Worker Compatibility Entry Point
 * - Network timeouts, retry thresholds, and operation queue concurrency limits.
 * - SIGTERM graceful shutdown coordination and forward export to voiceWorker/index.
 */

module.exports = require("./voiceWorker/index");
