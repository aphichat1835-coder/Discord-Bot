"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const voiceWorker = require("../voiceWorker");
const { st } = require("../voiceWorker/state");
const { isInvalidTokenError } = require("../voiceWorker/lifecycle");

test("voice diagnostics distinguish initializing, ready, and stopping", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const originalClient = st.mainClient;
    const originalShuttingDown = st.isShuttingDown;
    try {
        st.mainClient = null;
        st.isShuttingDown = false;
        let diagnostics = voiceWorker.getWorkerDiagnostics();
        assert.deepEqual({ ready: diagnostics.ready, status: diagnostics.status }, {
            ready: false,
            status: "initializing"
        });

        st.mainClient = {};
        diagnostics = voiceWorker.getWorkerDiagnostics();
        assert.deepEqual({ ready: diagnostics.ready, status: diagnostics.status }, {
            ready: true,
            status: "ready"
        });

        st.isShuttingDown = true;
        diagnostics = voiceWorker.getWorkerDiagnostics();
        assert.deepEqual({ ready: diagnostics.ready, status: diagnostics.status }, {
            ready: false,
            status: "stopping"
        });
    } finally {
        st.mainClient = originalClient;
        st.isShuttingDown = originalShuttingDown;
    }
});

test("voice login classifies Discord invalid-token responses as terminal", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    assert.equal(isInvalidTokenError(new Error("An invalid token was provided.")), true);
    assert.equal(isInvalidTokenError({ code: 4004, message: "Authentication failed" }), true);
    assert.equal(isInvalidTokenError({ code: 4014, message: "Disallowed intent(s)." }), false);
    assert.equal(isInvalidTokenError(new Error("Temporary gateway timeout")), false);
});
