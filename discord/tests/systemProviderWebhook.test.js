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

test("protected provider extracts payload attributes, handles failure text, and merges options accurately", async () => {
    const providerPath = require.resolve("../systemProvider");
    const webhooks = require("../core/webhooks");
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
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

        // 1. SILENCE ACTIVATED with failure text -> severity WARNING
        await engine.sendAlert("SILENCE ACTIVATED", "การทำงานล้มเหลว 2 รายการ");

        // 2. SILENCE ACTIVATED with "ล้มเหลว 0" -> severity SUCCESS
        await engine.sendAlert("SILENCE ACTIVATED", "ตรวจสอบเสร็จสิ้น ล้มเหลว 0 รายการ");

        // 3. SILENCE ACTIVATED with empty/nullish text -> severity SUCCESS
        await engine.sendAlert("SILENCE ACTIVATED", null);

        // 4. Object description with metadata and fields overridden by options
        await engine.sendAlert(
            "ROLE REPORT",
            {
                description: "Initial role summary",
                actor: "Operator1",
                server: "ServerA",
                fields: [{ name: "Field1", value: "Val1" }]
            },
            "#2b2d31",
            {
                actor: "OperatorOverride",
                fields: [{ name: "FieldOverride", value: "ValOverride" }],
                context: "ContextVal"
            }
        );

        // 5. Options with falsy attributes must not override truthy description attributes
        await engine.sendAlert(
            "ROLE REPORT",
            {
                description: "Preserved summary",
                actor: "OriginalActor",
                server: "OriginalServer"
            },
            "#2b2d31",
            {
                actor: "", // falsy, should not override OriginalActor
                server: null // falsy, should not override OriginalServer
            }
        );

        assert.equal(dispatchedEvents.length, 5);

        // Check 1: failure text
        assert.equal(dispatchedEvents[0].severity, "WARNING");

        // Check 2: "ล้มเหลว 0"
        assert.equal(dispatchedEvents[1].severity, "SUCCESS");

        // Check 3: nullish
        assert.equal(dispatchedEvents[2].severity, "SUCCESS");

        // Check 4: override
        assert.equal(dispatchedEvents[3].actor, "OperatorOverride");
        assert.equal(dispatchedEvents[3].server, "ServerA");
        assert.equal(dispatchedEvents[3].context, "ContextVal");
        assert.equal(dispatchedEvents[3].fields.length, 1);
        assert.equal(dispatchedEvents[3].fields[0].name, "FieldOverride");

        // Check 5: falsy option doesn't override
        assert.equal(dispatchedEvents[4].actor, "OriginalActor");
        assert.equal(dispatchedEvents[4].server, "OriginalServer");
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
        delete require.cache[providerPath];
    }
});
