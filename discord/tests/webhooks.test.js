const assert = require("node:assert/strict");
const test = require("node:test");

const {
    DEFAULT_OWNER_DASHBOARD_URL,
    getWebhookUrl,
    getOwnerDashboardBaseUrl,
    getWebhookDiagnostics,
    normalizeWebhookPayload,
    sendWebhook,
    buildStartupNotice
} = require("../core/webhooks");

test("webhook target names map to separate environment variables", () => {
    const env = {
        WEBHOOK_LOG_URL: "log-url",
        ALERT_WEBHOOK_URL: "alert-url"
    };

    assert.equal(getWebhookUrl("LOG", env), "log-url");
    assert.equal(getWebhookUrl("ALERT", env), "alert-url");
});

test("webhook diagnostics detect missing and duplicated targets", () => {
    assert.deepEqual(getWebhookDiagnostics({}), {
        hasLog: false,
        hasAlert: false,
        sameTarget: false,
        logTarget: null,
        alertTarget: null
    });

    assert.deepEqual(getWebhookDiagnostics({
        WEBHOOK_LOG_URL: "https://discord.com/api/webhooks/log/",
        ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/log"
    }), {
        hasLog: true,
        hasAlert: true,
        sameTarget: true,
        logTarget: "WEBHOOK_LOG_URL",
        alertTarget: "ALERT_WEBHOOK_URL"
    });
});

test("startup dashboard URL prefers the main owner service", () => {
    assert.equal(getOwnerDashboardBaseUrl({
        RENDER_EXTERNAL_URL: "https://owner-dashboard.example/",
        DASHBOARD_URL: "https://dashboard-public.example"
    }), "https://owner-dashboard.example");

    assert.equal(getOwnerDashboardBaseUrl({
        DASHBOARD_URL: "https://dashboard-public.example/"
    }), "https://dashboard-public.example");

    assert.equal(getOwnerDashboardBaseUrl({}), DEFAULT_OWNER_DASHBOARD_URL);
    assert.equal(DEFAULT_OWNER_DASHBOARD_URL, "https://your-app.onrender.com");
});

test("webhook payloads normalize strings and objects", () => {
    assert.deepEqual(normalizeWebhookPayload("hello"), { content: "hello" });
    assert.deepEqual(normalizeWebhookPayload({ content: "ok" }), { content: "ok" });
});

test("sendWebhook sends to the requested target and destroys the client", async () => {
    const calls = [];

    class FakeWebhookClient {
        constructor(options) {
            this.options = options;
            calls.push(["create", options.url]);
        }

        async send(payload) {
            calls.push(["send", payload]);
        }

        destroy() {
            calls.push(["destroy"]);
        }
    }

    const sent = await sendWebhook("LOG", "hello", {
        env: { WEBHOOK_LOG_URL: "log-url" },
        WebhookClientClass: FakeWebhookClient
    });

    assert.equal(sent, true);
    assert.deepEqual(calls, [
        ["create", "log-url"],
        ["send", { content: "hello" }],
        ["destroy"]
    ]);
});

test("sendWebhook returns false when missing URL or send fails", async () => {
    assert.equal(await sendWebhook("LOG", "hello", { env: {} }), false);

    let destroyed = false;
    class FailingWebhookClient {
        async send() {
            throw new Error("send failed");
        }

        destroy() {
            destroyed = true;
        }
    }

    const sent = await sendWebhook("LOG", "hello", {
        env: { WEBHOOK_LOG_URL: "log-url" },
        WebhookClientClass: FailingWebhookClient
    });

    assert.equal(sent, false);
    assert.equal(destroyed, true);
});

test("startup notice only includes dashboard and optional shadow portal links", () => {
    const notice = buildStartupNotice({
        clientTag: "Bot#0001",
        baseUrl: "https://example.com",
        timestamp: Date.UTC(2026, 5, 12, 9, 6, 40)
    });

    assert.match(notice.content, /Bot พร้อมแล้ว/);
    assert.match(notice.content, /Dashboard/);
    assert.match(notice.content, /Shadow Portal/);
    assert.equal(notice.content.includes("คู่มือ"), false);
    assert.equal(notice.content.includes("Health"), false);
    assert.equal(notice.content.includes("Ping"), false);
});
