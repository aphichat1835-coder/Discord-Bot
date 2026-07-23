const assert = require("node:assert/strict");
const test = require("node:test");
const { Colors } = require("discord.js");

const {
    getWebhookUrl,
    getOwnerDashboardBaseUrl,
    getWebhookDiagnostics,
    validateWebhookUrl,
    normalizeWebhookPayload,
    normalizeLegacyWebhookPayload,
    normalizeDiscordMediaUrl,
    getDiscordAvatarUrl,
    getDiscordGuildIconUrl,
    resolveWebhookEventTarget,
    buildWebhookEventPayload,
    sendWebhook,
    sendLogWebhook,
    sendAlertWebhook,
    sendWebhookEvent,
    flushWebhookQueue,
    WebhookDispatcher,
    buildStartupNotice
} = require("../core/webhooks");

const LOG_URL = "https://discord.com/api/webhooks/12345678901234567/abcdefghijklmnopqrstuvwxyzABCDE";
const ALERT_URL = "https://discord.com/api/webhooks/22345678901234567/abcdefghijklmnopqrstuvwxyzABCDE";

test("webhook target names map to separate environment variables", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const env = {
        WEBHOOK_LOG_URL: "log-url",
        ALERT_WEBHOOK_URL: "alert-url"
    };

    assert.equal(getWebhookUrl("LOG", env), "log-url");
    assert.equal(getWebhookUrl("ALERT", env), "alert-url");
});

test("webhook diagnostics detect missing and duplicated targets", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(getWebhookDiagnostics({}), {
        hasLog: false,
        hasAlert: false,
        logValid: false,
        alertValid: false,
        logCode: "missing",
        alertCode: "missing",
        sameTarget: false,
        logTarget: null,
        alertTarget: null
    });

    assert.deepEqual(getWebhookDiagnostics({
        WEBHOOK_LOG_URL: `${LOG_URL}/`,
        ALERT_WEBHOOK_URL: LOG_URL
    }), {
        hasLog: true,
        hasAlert: true,
        logValid: true,
        alertValid: true,
        logCode: "valid",
        alertCode: "valid",
        sameTarget: true,
        logTarget: "WEBHOOK_LOG_URL",
        alertTarget: "ALERT_WEBHOOK_URL"
    });
});

test("startup dashboard URL uses the canonical unified public origin", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(getOwnerDashboardBaseUrl({
        RENDER_EXTERNAL_URL: "https://retired-dashboard-public.example/",
        PUBLIC_BASE_URL: "https://owner-dashboard.example/",
        DASHBOARD_URL: "https://owner-dashboard.example"
    }), "https://owner-dashboard.example");

    assert.equal(getOwnerDashboardBaseUrl({
        DASHBOARD_URL: "https://dashboard-public.example/"
    }), "https://dashboard-public.example");

    assert.equal(getOwnerDashboardBaseUrl({
        RENDER_EXTERNAL_URL: "https://host-provided.example/"
    }), "https://host-provided.example");
    assert.equal(getOwnerDashboardBaseUrl({
        PUBLIC_BASE_URL: "https://owner-dashboard.example/retired/path?old=1#fragment"
    }), "https://owner-dashboard.example");
    assert.equal(getOwnerDashboardBaseUrl({}), null);
    assert.equal(getOwnerDashboardBaseUrl({ PUBLIC_BASE_URL: "not-a-url" }), null);
});

test("webhook payloads normalize strings and objects", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(normalizeWebhookPayload("hello"), { content: "hello", allowedMentions: { parse: [] } });
    assert.deepEqual(normalizeWebhookPayload({ content: "ok" }), { content: "ok", allowedMentions: { parse: [] } });
    assert.deepEqual(
        normalizeWebhookPayload({ content: "@everyone", allowedMentions: { parse: ["everyone"] } }).allowedMentions,
        { parse: [] }
    );
});

test("webhook events route by severity and render one consistent embed", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(resolveWebhookEventTarget({ severity: "SUCCESS" }), "LOG");
    assert.equal(resolveWebhookEventTarget({ severity: "WARNING" }), "LOG");
    assert.equal(resolveWebhookEventTarget({ severity: "ERROR" }), "ALERT");
    assert.equal(resolveWebhookEventTarget({ severity: "CRITICAL" }), "ALERT");
    assert.equal(resolveWebhookEventTarget({ severity: "WARNING", target: "ALERT" }), "ALERT");

    const payload = buildWebhookEventPayload({
        severity: "ERROR",
        category: "VOICE",
        code: "voice.session.dead",
        state: "OPEN",
        title: "Session เชื่อมต่อกลับไม่ได้",
        impact: "บัญชีหลุดจากห้องเสียง",
        action: "เริ่ม Session ใหม่",
        context: { Session: "vc_test\n`spoof`" },
        timestamp: 1000
    });
    assert.equal(payload.embeds.length, 1);
    assert.match(payload.embeds[0].author.name, /ACTION REQUIRED/);
    assert.match(payload.embeds[0].title, /Session เชื่อมต่อกลับไม่ได้/);
    assert.match(payload.embeds[0].footer.text, /voice\.session\.dead/);
    assert.equal(payload.embeds[0].fields.some(field => field.name === "สิ่งที่ควรทำ"), true);
    assert.equal(payload.embeds[0].fields.some(field => field.value.includes("\n") || field.value.includes("`")), false);
});

test("event profile images accept Discord CDN URLs and reject arbitrary hosts", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const avatar = "https://cdn.discordapp.com/avatars/123/hash.png";
    const icon = "https://media.discordapp.net/icons/456/hash.webp";
    assert.equal(normalizeDiscordMediaUrl(avatar), avatar);
    assert.equal(normalizeDiscordMediaUrl("https://example.com/tracker.png"), null);
    assert.equal(getDiscordAvatarUrl({ displayAvatarURL: () => avatar }), avatar);
    assert.equal(getDiscordGuildIconUrl({ iconURL: () => icon }), icon);

    const payload = buildWebhookEventPayload({
        severity: "INFO",
        category: "GUILD",
        code: "guild.profile.test",
        title: "ทดสอบโปรไฟล์",
        sourceIconUrl: icon,
        thumbnailUrl: avatar
    });
    assert.equal(payload.embeds[0].author.icon_url, icon);
    assert.equal(payload.embeds[0].thumbnail.url, avatar);
});

test("legacy text payloads receive the common event presentation", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const logPayload = normalizeLegacyWebhookPayload("LOG", "legacy log");
    const alertPayload = normalizeLegacyWebhookPayload("ALERT", { content: "legacy alert" });
    assert.match(logPayload.embeds[0].author.name, /ACTIVITY & AUDIT/);
    assert.match(logPayload.embeds[0].description, /legacy log/);
    assert.match(alertPayload.embeds[0].author.name, /ACTION REQUIRED/);
    assert.match(alertPayload.embeds[0].description, /legacy alert/);
});

test("event delivery normalization removes raw credentials and IP addresses", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const token = `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(20)}`;
    const webhookUrl = `${LOG_URL}/unsafe`;
    const payload = normalizeWebhookPayload(buildWebhookEventPayload({
        severity: "ERROR",
        category: "SECURITY",
        code: "security.redaction.test",
        title: "ทดสอบข้อมูลอ่อนไหว",
        context: { IP: "203.0.113.7", Token: token, Webhook: webhookUrl }
    }));
    const text = JSON.stringify(payload);
    assert.equal(text.includes("203.0.113.7"), false);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(webhookUrl), false);
    assert.match(text, /REDACTED_IP/);
    assert.match(text, /REDACTED_TOKEN|REDACTED_SECRET/);
    assert.match(text, /REDACTED_WEBHOOK/);
});

test("webhook URLs are restricted to HTTPS Discord webhook endpoints", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(validateWebhookUrl(LOG_URL).valid, true);
    assert.equal(validateWebhookUrl("http://discord.com/api/webhooks/123/token-token-token-token").code, "https_required");
    assert.equal(validateWebhookUrl("https://example.com/api/webhooks/123456/token-token-token-token").code, "host_not_allowed");
});

test("sendWebhook sends to the requested target and destroys the client", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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
        env: { WEBHOOK_LOG_URL: LOG_URL },
        WebhookClientClass: FakeWebhookClient
    });

    assert.equal(sent, true);
    assert.deepEqual(calls, [
        ["create", LOG_URL],
        ["send", { content: "hello", allowedMentions: { parse: [] } }],
        ["destroy"]
    ]);
});

test("sendWebhook returns false when missing URL or send fails", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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
        env: { WEBHOOK_LOG_URL: LOG_URL },
        WebhookClientClass: FailingWebhookClient
    });

    assert.equal(sent, false);
    assert.equal(destroyed, true);
});

test("dispatcher retries transient failures and exposes bounded delivery metrics", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let attempts = 0;
    class RetryClient {
        async send() {
            attempts++;
            if (attempts === 1) {
                const error = new Error("temporary");
                error.status = 503;
                throw error;
            }
        }
        destroy() {}
    }
    const dispatcher = new WebhookDispatcher({
        WebhookClientClass: RetryClient,
        env: { WEBHOOK_LOG_URL: LOG_URL, ALERT_WEBHOOK_URL: ALERT_URL },
        maxAttempts: 2,
        delayFn: async () => {}
    });
    assert.equal(await dispatcher.enqueue("LOG", { content: "retry" }), true);
    assert.equal(attempts, 2);
    assert.equal(dispatcher.stats().targets.LOG.retried, 1);
    assert.equal(dispatcher.stats().targets.LOG.sent, 1);
    assert.equal(await dispatcher.shutdown(), true);
});

test("routine dedupe remains isolated per dispatcher and summaries use the original target", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const firstCalls = [];
    const secondCalls = [];
    const firstDispatcher = { enqueue: async (target, payload) => { firstCalls.push({ target, payload }); return true; } };
    const secondDispatcher = { enqueue: async (target, payload) => { secondCalls.push({ target, payload }); return true; } };
    const options = { dedupeKey: "same-event", dedupeMs: 60_000, summaryLabel: "same event" };

    await sendLogWebhook("first", { ...options, dispatcher: firstDispatcher });
    await sendLogWebhook("duplicate", { ...options, dispatcher: firstDispatcher });
    await sendLogWebhook("second destination", { ...options, dispatcher: secondDispatcher });
    await flushWebhookQueue(20);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(firstCalls.length, 2);
    assert.match(firstCalls[1].payload.embeds[0].title, /สรุปเหตุการณ์ที่เกิดซ้ำ/);
    assert.equal(firstCalls[1].payload.embeds[0].fields.some(field => /1 ครั้ง/.test(field.value)), true);
    assert.equal(secondCalls.length, 1);
    assert.match(secondCalls[0].payload.embeds[0].description, /second destination/);
});

test("deduplication applies independently to alert events", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const calls = [];
    const dispatcher = { enqueue: async (target, payload) => { calls.push({ target, payload }); return true; } };
    const options = {
        dispatcher,
        dedupeKey: "critical-event",
        dedupeMs: 60_000,
        summaryLabel: "critical event",
        summaryCategory: "SYSTEM",
        eventCode: "runtime.critical"
    };
    await sendAlertWebhook("first", options);
    await sendAlertWebhook("duplicate", options);
    await flushWebhookQueue(20);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls.length, 2);
    assert.equal(calls.every(call => call.target === "ALERT"), true);
    assert.match(calls[1].payload.embeds[0].footer.text, /runtime\.critical\.repeated/);
});

test("sendWebhookEvent selects the destination and keeps the event code", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const calls = [];
    const dispatcher = { enqueue: async (target, payload) => { calls.push({ target, payload }); return true; } };
    await sendWebhookEvent({
        severity: "ERROR",
        category: "COMMAND",
        code: "commands.registration.degraded",
        title: "ลงทะเบียนคำสั่งไม่สำเร็จ"
    }, { dispatcher });
    assert.equal(calls[0].target, "ALERT");
    assert.match(calls[0].payload.embeds[0].footer.text, /commands\.registration\.degraded/);
});

test("normalization enforces Discord payload limits without enabling mentions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const payload = normalizeWebhookPayload({
        content: "x".repeat(3000),
        embeds: [{
            title: "t".repeat(500),
            description: "d".repeat(5000),
            fields: Array.from({ length: 30 }, (_, index) => ({ name: `name-${index}`, value: "v".repeat(1500) }))
        }]
    });
    assert.equal(payload.content.length, 2000);
    assert.ok(payload.embeds[0].title.length <= 256);
    assert.ok(payload.embeds[0].description.length <= 4096);
    assert.ok(payload.embeds[0].fields.length <= 25);
    const totalEmbedText = payload.embeds.reduce((sum, embed) => sum +
        String(embed.title || "").length + String(embed.description || "").length +
        String(embed.footer?.text || "").length + String(embed.author?.name || "").length +
        (embed.fields || []).reduce((fieldSum, field) => fieldSum + field.name.length + field.value.length, 0), 0);
    assert.ok(totalEmbedText <= 6000);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("critical alerts preempt queued routine logs when the bounded queue is full", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sent = [];
    let releaseFirst;
    class BlockingClient {
        async send(payload) {
            sent.push(payload.content);
            if (payload.content === "first") {
                await new Promise(resolve => { releaseFirst = resolve; });
            }
        }
        destroy() {}
    }
    const dispatcher = new WebhookDispatcher({
        WebhookClientClass: BlockingClient,
        env: { WEBHOOK_LOG_URL: LOG_URL, ALERT_WEBHOOK_URL: ALERT_URL },
        maxDepth: 2,
        concurrency: 1,
        maxAttempts: 1
    });
    const first = dispatcher.enqueue("LOG", "first");
    await new Promise(resolve => setImmediate(resolve));
    const routine = dispatcher.enqueue("LOG", "routine");
    const alert = dispatcher.enqueue("ALERT", "alert");
    releaseFirst();

    assert.deepEqual(await Promise.all([first, routine, alert]), [true, false, true]);
    assert.deepEqual(sent, ["first", "alert"]);
    assert.equal(dispatcher.stats().targets.LOG.lastFailureCode, "preempted_by_alert");
    await dispatcher.shutdown();
});

test("dispatcher flush is bounded and shutdown rejects new work", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let release;
    class BlockingClient {
        async send() {
            await new Promise(resolve => { release = resolve; });
        }
        destroy() {}
    }
    const dispatcher = new WebhookDispatcher({
        WebhookClientClass: BlockingClient,
        env: { WEBHOOK_LOG_URL: LOG_URL },
        maxAttempts: 1
    });
    const delivery = dispatcher.enqueue("LOG", "pending");
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(await dispatcher.flush(20), false);
    release();
    assert.equal(await delivery, true);
    assert.equal(await dispatcher.shutdown(), true);
    assert.equal(await dispatcher.enqueue("LOG", "late"), false);
    assert.equal(dispatcher.stats().targets.LOG.lastFailureCode, "dispatcher_stopping");
});

test("startup notice only includes dashboard and optional shadow portal links", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const notice = buildStartupNotice({
        clientTag: "Bot#0001",
        baseUrl: "https://example.com",
        timestamp: Date.UTC(2026, 5, 12, 9, 6, 40)
    });

    const text = JSON.stringify(notice);
    assert.match(text, /บอทพร้อมใช้งานแล้ว/);
    assert.match(text, /Dashboard/);
    assert.match(text, /เครื่องมือขั้นสูง/);
    assert.match(text, /https:\/\/example\.com\/shadow/);
    assert.equal(text.includes("telemetry/snapshot"), false);
    assert.equal(text.includes("คู่มือ"), false);
    assert.equal(text.includes("Health"), false);
    assert.equal(text.includes("Ping"), false);
});

test("startup notice never emits a fake link when public URL is missing", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const notice = buildStartupNotice({ clientTag: "Bot#0001", baseUrl: "" });

    const text = JSON.stringify(notice);
    assert.match(text, /ยังไม่ได้ตั้งค่า public URL/);
    assert.equal(text.includes("your-app.onrender.com"), false);
    assert.equal(text.includes("เครื่องมือขั้นสูง"), false);
});

test("startup notice omits Shadow link when its router did not mount", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const notice = buildStartupNotice({
        clientTag: "Bot#0001",
        baseUrl: "https://example.com",
        includeShadowPortal: false
    });

    const text = JSON.stringify(notice);
    assert.match(text, /https:\/\/example\.com/);
    assert.equal(text.includes("เครื่องมือขั้นสูง"), false);
    assert.equal(text.includes("/shadow"), false);
});

test("webhook dispatcher never retries a send_timeout because the original request may still complete", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { _test } = require("../core/webhooks");
    assert.equal(_test.retryable({ code: "send_timeout" }), false);
    assert.equal(_test.retryable({ status: 503 }), true);
    assert.equal(_test.retryable({ status: 429 }), true);
});

test("event token normalization bounds hostile input without changing webhook colors", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { _test } = require("../core/webhooks");
    const hostileToken = `A${"_".repeat(100_000)}B`;
    const hostileCode = `a${".".repeat(100_000)}b`;

    assert.equal(_test.normalizeEventToken(hostileToken, "SYSTEM"), "A");
    assert.equal(_test.normalizeWebhookEventCode(hostileCode), "a");
    assert.equal(buildWebhookEventPayload({ severity: "WARNING" }).embeds[0].color, Colors.Yellow);
    assert.equal(buildWebhookEventPayload({ severity: "ERROR" }).embeds[0].color, Colors.Red);
    assert.equal(buildWebhookEventPayload({ severity: "CRITICAL" }).embeds[0].color, Colors.DarkRed);
});
