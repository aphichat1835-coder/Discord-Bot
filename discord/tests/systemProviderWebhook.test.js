"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("protected provider routes alerts through the shared outbound dispatcher", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const providerPath = require.resolve("../systemProvider");
    const webhooks = require("../core/webhooks");
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
    const originalAlertUrl = process.env.ALERT_WEBHOOK_URL;
    const originalLogUrl = process.env.WEBHOOK_LOG_URL;
    const dispatchedEvents = [];

    try {
        process.env.ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/12345678901234567/abcdefghijklmnopqrstuvwxyzABCDE";
        process.env.WEBHOOK_LOG_URL = "https://discord.com/api/webhooks/12345678901234568/abcdefghijklmnopqrstuvwxyzABCDE";

        webhooks.sendWebhookEvent = async event => {
            dispatchedEvents.push(event);
            return true;
        };

        delete require.cache[providerPath];
        const { ShadowEngine } = require("../systemProvider")._test;
        const engine = new ShadowEngine({ on() {} });

        // Activity / audit should route to LOG
        await engine.sendAlert("📡 COMMAND LOG: -intel", "description");

        // Incident / security should route to ALERT
        await engine.sendAlert("🚨 SECURITY ALERT — MEMBER REMOVED", "High risk member removed");

        // quickAlert should not dispatch to webhook
        await engine.quickAlert("quick feedback message");

        assert.equal(dispatchedEvents.length, 2);

        // Check command log routing
        assert.equal(dispatchedEvents[0].target, "LOG");
        assert.equal(dispatchedEvents[0].category, "OWNER");
        assert.equal(dispatchedEvents[0].title, "COMMAND EXECUTED");

        // Check security alert routing
        assert.equal(dispatchedEvents[1].target, "ALERT");
        assert.equal(dispatchedEvents[1].severity, "WARNING");
        assert.equal(dispatchedEvents[1].category, "SECURITY");
        assert.equal(dispatchedEvents[1].title, "PRIVILEGED MEMBER REMOVED");
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
        if (originalAlertUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
        else process.env.ALERT_WEBHOOK_URL = originalAlertUrl;
        if (originalLogUrl === undefined) delete process.env.WEBHOOK_LOG_URL;
        else process.env.WEBHOOK_LOG_URL = originalLogUrl;
        delete require.cache[providerPath];
    }
});
