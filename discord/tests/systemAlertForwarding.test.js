"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const webhooks = require("../core/webhooks");
const { registerGatewayDiagnostics } = require("../core/gatewayDiagnostics");

test("systemAlertForwarding: shardResume emits green RESOLVED card to ALERT_WEBHOOK_URL", () => {
    const client = new EventEmitter();
    const dispatched = [];
    const origSend = webhooks.sendWebhookEvent;
    webhooks.sendWebhookEvent = async (event) => {
        dispatched.push(event);
        return true;
    };

    try {
        registerGatewayDiagnostics(client, { clientName: "test-bot", context: "unit-test" });
        client.emit("shardResume", 0, 5);

        assert.equal(dispatched.length, 1);
        const alert = dispatched[0];
        assert.equal(alert.target, "ALERT");
        assert.equal(alert.severity, "SUCCESS");
        assert.equal(alert.state, "RESOLVED");
        assert.equal(alert.code, "gateway.shard_resumed");
        assert.equal(alert.title, "GATEWAY RECONNECTED (RESOLVED)");
        assert.ok(alert.description.includes("Shard 0"));
        assert.ok(alert.fields.some(f => f.name === "สถานะ" && f.value === "แก้ไขแล้ว"));
    } finally {
        webhooks.sendWebhookEvent = origSend;
    }
});

test("systemAlertForwarding: command unhandled error forwards to ALERT_WEBHOOK_URL", async () => {
    const commands = require("../commands");
    const dispatched = [];
    const origSend = webhooks.sendWebhookEvent;
    webhooks.sendWebhookEvent = async (event) => {
        dispatched.push(event);
        return true;
    };

    const mockInteraction = {
        commandName: "broken-command",
        user: { id: "123456789012345678", tag: "tester#0001" },
        guild: { id: "987654321098765432", name: "Test Guild" },
        guildId: "987654321098765432",
        channelId: "111222333444555666",
        isChatInputCommand: () => {
            throw new Error("Simulated unexpected crash in command handler");
        },
        replied: false,
        deferred: false,
        reply: async () => {},
        followUp: async () => {},
        editReply: async () => {}
    };

    try {
        await commands.handleInteraction(mockInteraction, null, null);

        assert.equal(dispatched.length, 1);
        const alert = dispatched[0];
        assert.equal(alert.target, "ALERT");
        assert.equal(alert.severity, "ERROR");
        assert.equal(alert.category, "COMMAND");
        assert.equal(alert.code, "command.unhandled_error");
        assert.equal(alert.state, "OPEN");
        assert.ok(alert.description.includes("Simulated unexpected crash"));
        assert.equal(alert.context["คำสั่ง / ID"], "broken-command");
    } finally {
        webhooks.sendWebhookEvent = origSend;
    }
});

test("systemAlertForwarding: payload builder preserves RESOLVED state and green color for alert webhooks", () => {
    const payload = webhooks.buildWebhookEventPayload({
        target: "ALERT",
        severity: "SUCCESS",
        category: "GATEWAY",
        code: "gateway.shard_resumed",
        state: "RESOLVED",
        title: "GATEWAY RECONNECTED (RESOLVED)",
        description: "Shard 0 เชื่อมต่อกลับมาสำเร็จแล้ว",
        fields: [
            { name: "สถานะ", value: "แก้ไขแล้ว" },
            { name: "Shard ID", value: "0" }
        ]
    });

    assert.ok(payload.embeds && payload.embeds.length === 1);
    const embed = payload.embeds[0];
    assert.equal(embed.color, 0x57F287); // Colors.Green
    assert.match(embed.title, /GATEWAY/);
    assert.match(embed.author.name, /PHOMUEANGTAI • ACTION REQUIRED/);
    assert.ok(embed.fields.some(f => f.name === "สถานะ" && f.value === "แก้ไขแล้ว"));
});

test("systemAlertForwarding: initLogCapture forwards console.error and console.warn to ALERT_WEBHOOK_URL", () => {
    const system = require("../index/system");
    const dispatched = [];
    const origSendAlert = webhooks.sendAlertWebhook;
    webhooks.sendAlertWebhook = async (payload) => {
        dispatched.push(payload);
        return true;
    };

    const origConsoleError = console.error;
    const origConsoleWarn = console.warn;
    const origConsoleLog = console.log;

    try {
        system.initLogCapture(100);

        console.error("[DATABASE] ❌ Failed to load approved guilds: Connection timeout");
        console.warn("[WORKER] ⚠️ VoiceConnection socket error for vc_12345: ETIMEDOUT");

        assert.equal(dispatched.length, 2);

        // Error payload verification
        const errPayload = dispatched[0];
        assert.ok(errPayload.embeds && errPayload.embeds.length === 1);
        const errEmbed = errPayload.embeds[0];
        assert.equal(errEmbed.color, 0xED4245); // Red
        assert.match(errEmbed.title, /DATABASE.*ERROR DETECTED/);
        assert.ok(errEmbed.description.includes("Failed to load approved guilds"));

        // Warning payload verification
        const warnPayload = dispatched[1];
        assert.ok(warnPayload.embeds && warnPayload.embeds.length === 1);
        const warnEmbed = warnPayload.embeds[0];
        assert.equal(warnEmbed.color, 0xFEE75C); // Yellow
        assert.match(warnEmbed.title, /VOICE.*WARNING DETECTED/);
        assert.ok(warnEmbed.description.includes("VoiceConnection socket error"));
    } finally {
        console.error = origConsoleError;
        console.warn = origConsoleWarn;
        console.log = origConsoleLog;
        webhooks.sendAlertWebhook = origSendAlert;
    }
});

