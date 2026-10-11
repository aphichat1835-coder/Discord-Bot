"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { registerGatewayDiagnostics } = require("../core/gatewayDiagnostics");
const webhooks = require("../core/webhooks");

test("gateway diagnostics attach once and handle websocket lifecycle errors locally", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const client = new EventEmitter();
    const errors = [];
    const warnings = [];
    const logs = [];
    const dispatched = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalLog = console.log;
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;

    console.error = value => errors.push(String(value));
    console.warn = value => warnings.push(String(value));
    console.log = value => logs.push(String(value));
    webhooks.sendWebhookEvent = async event => {
        dispatched.push(event);
        return true;
    };

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
        client.emit("shardResume", 2, 4);

        const gatewayErrors = errors.filter(e => e.includes("[GATEWAY]"));
        const gatewayWarnings = warnings.filter(w => w.includes("[GATEWAY]"));
        const gatewayLogs = logs.filter(l => l.includes("[GATEWAY]"));

        assert.equal(gatewayErrors.length, 2);
        assert.match(gatewayErrors[0], /client=test-client context=test-session event=error/);
        assert.match(gatewayErrors[0], /521/);
        assert.equal(gatewayWarnings.length, 2);
        assert.match(gatewayWarnings[0], /event=shardDisconnect shard=2 code=1006/);
        assert.equal(gatewayWarnings[0].includes("sensitive reason"), false);
        assert.equal(gatewayLogs.length, 1);
        assert.match(gatewayLogs[0], /event=shardResume shard=2 replayed=4/);

        // Verify webhooks dispatched for gateway events
        assert.equal(dispatched.length, 5);
        assert.equal(dispatched[0].target, "ALERT"); // error -> ALERT
        assert.equal(dispatched[0].code, "gateway.error");
        assert.equal(dispatched[1].target, "ALERT"); // shardError -> ALERT
        assert.equal(dispatched[1].code, "gateway.shard_error");
        assert.equal(dispatched[2].target, "ALERT"); // shardDisconnect -> ALERT (warning)
        assert.equal(dispatched[2].code, "gateway.shard_disconnected");
        assert.equal(dispatched[3].target, "LOG"); // shardReconnecting -> LOG
        assert.equal(dispatched[3].code, "gateway.shard_reconnecting");
        assert.equal(dispatched[4].target, "ALERT"); // shardResume -> ALERT (RESOLVED)
        assert.equal(dispatched[4].code, "gateway.shard_resumed");
        assert.equal(dispatched[4].state, "RESOLVED");
        assert.equal(dispatched[4].severity, "SUCCESS");
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
        console.log = originalLog;
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
    }
});
