"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("protected provider routes alerts through the shared outbound dispatcher", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const webhooksPath = require.resolve("../core/webhooks");
    const providerPath = require.resolve("../systemProvider");
    const webhooks = require("../core/webhooks");
    const originalSendAlertWebhook = webhooks.sendAlertWebhook;
    const originalAlertUrl = process.env.ALERT_WEBHOOK_URL;
    const deliveries = [];

    try {
        process.env.ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/12345678901234567/abcdefghijklmnopqrstuvwxyzABCDE";
        webhooks.sendAlertWebhook = async payload => {
            deliveries.push(payload);
            return true;
        };
        delete require.cache[providerPath];
        const { ShadowEngine } = require("../systemProvider")._test;
        const engine = new ShadowEngine({ on() {} });

        await engine.sendAlert("test", "description");
        await engine.quickAlert("quick");

        assert.equal(deliveries.length, 2);
        assert.equal(deliveries[0].embeds.length, 1);
        assert.match(deliveries[1].content, /quick/);
    } finally {
        webhooks.sendAlertWebhook = originalSendAlertWebhook;
        if (originalAlertUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
        else process.env.ALERT_WEBHOOK_URL = originalAlertUrl;
        delete require.cache[providerPath];
    }
});
