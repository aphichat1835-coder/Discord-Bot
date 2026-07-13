"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { registerGatewayDiagnostics } = require("../core/gatewayDiagnostics");

test("gateway diagnostics attach once and handle websocket lifecycle errors locally", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const client = new EventEmitter();
    const errors = [];
    const warnings = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = value => errors.push(String(value));
    console.warn = value => warnings.push(String(value));

    try {
        assert.equal(registerGatewayDiagnostics(client, {
            clientName: "test-client",
            context: "test-session"
        }), true);
        assert.equal(registerGatewayDiagnostics(client), false);

        assert.doesNotThrow(() => client.emit("error", new Error("Unexpected server response: 521")));
        client.emit("shardError", new Error("gateway failed"), 2);
        client.emit("shardDisconnect", { code: 1006, reason: "sensitive reason is omitted" }, 2);
        client.emit("shardReconnecting", 2);

        assert.equal(errors.length, 2);
        assert.match(errors[0], /client=test-client context=test-session event=error/);
        assert.match(errors[0], /521/);
        assert.equal(warnings.length, 2);
        assert.match(warnings[0], /event=shardDisconnect shard=2 code=1006/);
        assert.equal(warnings[0].includes("sensitive reason"), false);
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
});
