const assert = require("node:assert/strict");
const test = require("node:test");
const { Colors } = require("discord.js");

const {
    getWebhookUrl,
    getOwnerDashboardBaseUrl,
    getWebhookDiagnostics,
    getWebhookDeliveryDiagnostics,
    validateWebhookUrl,
    normalizeWebhookPayload,
    normalizeLegacyWebhookPayload,
    normalizeDiscordMediaUrl,
    getDiscordAvatarUrl,
    getDiscordGuildIconUrl,
    resolveWebhookEventTarget,
    buildWebhookEventPayload,
    buildWebhookEventPayloads,
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

test("webhook payloads preserve private content and caller mention policy", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(normalizeWebhookPayload("hello"), { content: "hello" });
    assert.deepEqual(normalizeWebhookPayload({ content: "ok" }), { content: "ok" });
    assert.deepEqual(
        normalizeWebhookPayload({ content: "@everyone", allowedMentions: { parse: ["everyone"] } }).allowedMentions,
        { parse: ["everyone"] }
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
        context: {
            Session: "*admin* _spoof_ ||hidden|| > quote [label](https://example.com)\n`spoof`",
            Dashboard: "https://owner-dashboard.example/path_value"
        },
        timestamp: 1000
    });
    assert.equal(payload.embeds.length, 1);
    assert.match(payload.embeds[0].author.name, /ACTION REQUIRED/);
    assert.match(payload.embeds[0].title, /Session เชื่อมต่อกลับไม่ได้/);
    assert.match(payload.embeds[0].footer.text, /voice\.session\.dead/);
    assert.equal(payload.embeds[0].fields.some(field => field.name === "สิ่งที่ควรทำ"), true);
    assert.equal(payload.embeds[0].fields.some(field => field.value.includes("\n") || field.value.includes("`")), false);
    const sessionField = payload.embeds[0].fields.find(field => field.name === "Session");
    assert.equal(sessionField.value.includes("\\*admin\\*"), true);
    assert.equal(sessionField.value.includes("\\_spoof\\_"), true);
    assert.equal(sessionField.value.includes("\\|\\|hidden\\|\\|"), true);
    assert.equal(sessionField.value.includes("\\> quote"), true);
    const dashboardField = payload.embeds[0].fields.find(field => field.name === "Dashboard");
    assert.equal(dashboardField.value, "https://owner-dashboard.example/path_value");
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

test("private webhook events preserve full owner-visible credentials and IP values", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const token = `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(20)}`;
    const webhookUrl = `${LOG_URL}/unsafe`;
    const payload = normalizeWebhookPayload(buildWebhookEventPayload({
        severity: "ERROR",
        category: "SECURITY",
        code: "security.private-detail.test",
        title: "ทดสอบข้อมูลลับ",
        context: { IP: "203.0.113.7", Token: token, Webhook: webhookUrl }
    }));
    const text = JSON.stringify(payload);
    assert.equal(text.includes("203.0.113.7"), true);
    assert.equal(text.includes(token), true);
    assert.equal(text.includes(webhookUrl), true);
});

test("webhook events send single primary payload by default and support explicit continuation", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field-${index}`, `${index}:${"x".repeat(500)}`]));
    context.boolean = true;
    context.number = 42;
    const event = { severity: "ERROR", category: "SECURITY", title: "รายละเอียด", context };

    const defaultPayloads = buildWebhookEventPayloads(event);
    assert.equal(defaultPayloads.length, 1);
    assert.match(defaultPayloads[0].embeds[0].title, /SECURITY · รายละเอียด/);

    const explicitPayloads = buildWebhookEventPayloads(event, { includeContinuation: true });
    assert.ok(explicitPayloads.length > 1);
    const continuation = explicitPayloads.slice(1)
        .flatMap(payload => payload.embeds[0].fields)
        .map(field => field.value)
        .join("");
    assert.deepEqual(JSON.parse(continuation), event);
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
        ["send", { content: "hello" }],
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

test("sendWebhookEvent preserves event-level summary metadata for duplicate reports", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const calls = [];
    const dispatcher = { enqueue: async (target, payload) => { calls.push({ target, payload }); return true; } };
    const event = {
        severity: "WARNING",
        category: "COMMAND",
        code: "commands.fallback",
        title: "เหตุการณ์ทดสอบ",
        dedupeKey: "event-summary-metadata",
        dedupeMs: 60_000,
        summaryCategory: "SECURITY",
        eventCode: "security.owner_mismatch"
    };

    await sendWebhookEvent(event, { dispatcher });
    await sendWebhookEvent(event, { dispatcher });
    await flushWebhookQueue(20);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls.length, 2);
    const duplicateEmbed = calls[1].payload.embeds[0];
    assert.match(duplicateEmbed.title, /สรุปเหตุการณ์ที่เกิดซ้ำ/);
    assert.equal(duplicateEmbed.description, "เหตุการณ์ทดสอบ");
    assert.match(duplicateEmbed.footer.text, /SECURITY/);
    assert.match(duplicateEmbed.footer.text, /security\.owner_mismatch\.repeated/);
});

test("normalization enforces Discord payload limits without overriding mentions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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
    assert.equal(payload.allowedMentions, undefined);
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
    assert.match(text, /BOT READY/);
    assert.match(text, /Dashboard/);
    assert.match(text, /Shadow Portal/);
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


test("timed-out webhook operations reconcile a late success without a duplicate send", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let release;
    let sends = 0;
    class LateSuccessClient {
        async send() {
            sends++;
            await new Promise(resolve => { release = resolve; });
        }
        destroy() {}
    }
    const dispatcher = new WebhookDispatcher({
        WebhookClientClass: LateSuccessClient,
        env: { WEBHOOK_LOG_URL: LOG_URL },
        maxAttempts: 3,
        timeoutMs: 100
    });

    assert.equal(await dispatcher.enqueue("LOG", "late success"), true);
    let stats = dispatcher.stats();
    assert.equal(sends, 1);
    assert.equal(stats.targets.LOG.timedOut, 1);
    assert.equal(stats.targets.LOG.pendingTimedOut, 1);
    assert.equal(stats.pendingReconciliations, 1);
    assert.equal(stats.targets.LOG.failed, 0);

    release();
    assert.equal(await dispatcher.flush(500), true);
    stats = dispatcher.stats();
    assert.equal(sends, 1);
    assert.equal(stats.targets.LOG.pendingTimedOut, 0);
    assert.equal(stats.targets.LOG.lateSucceeded, 1);
    assert.equal(stats.targets.LOG.sent, 1);
    assert.equal(stats.targets.LOG.failed, 0);
    assert.equal(stats.recentOperations.at(-1).state, "late_succeeded");
    await dispatcher.shutdown();
});

test("timed-out webhook operations reconcile a late failure and keep flush bounded", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let rejectSend;
    class LateFailureClient {
        async send() {
            return new Promise((_, reject) => { rejectSend = reject; });
        }
        destroy() {}
    }
    const dispatcher = new WebhookDispatcher({
        WebhookClientClass: LateFailureClient,
        env: { WEBHOOK_LOG_URL: LOG_URL },
        maxAttempts: 2,
        timeoutMs: 100
    });

    assert.equal(await dispatcher.enqueue("LOG", "late failure"), true);
    assert.equal(await dispatcher.flush(120), false);
    rejectSend(Object.assign(new Error("late network failure"), { status: 503 }));
    assert.equal(await dispatcher.flush(500), true);
    const stats = dispatcher.stats();
    assert.equal(stats.targets.LOG.lateFailed, 1);
    assert.equal(stats.targets.LOG.failed, 1);
    assert.equal(stats.targets.LOG.pendingTimedOut, 0);
    assert.equal(stats.recentOperations.at(-1).state, "late_failed");
    assert.equal(stats.recentOperations.at(-1).failureCode, "http_503");
    await dispatcher.shutdown();
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

test("delivery diagnostics expose one canonical dedupe count", () => {
    const diagnostics = getWebhookDeliveryDiagnostics();
    assert.equal(diagnostics.dedupeKeys, diagnostics.routineDedupeKeys);
    assert.equal(Object.hasOwn(diagnostics, "eventDedupeKeys"), false);
});

test("Phase 1 Webhook Renovation: complete severity routing contracts", () => {
    assert.equal(resolveWebhookEventTarget({ severity: "INFO" }), "LOG");
    assert.equal(resolveWebhookEventTarget({ severity: "SUCCESS" }), "LOG");
    assert.equal(resolveWebhookEventTarget({ severity: "WARNING" }), "LOG");
    assert.equal(resolveWebhookEventTarget({ severity: "WARNING", actionRequired: true }), "ALERT");
    assert.equal(resolveWebhookEventTarget({ severity: "ERROR" }), "ALERT");
    assert.equal(resolveWebhookEventTarget({ severity: "CRITICAL" }), "ALERT");
    assert.equal(resolveWebhookEventTarget({ severity: "INFO", target: "ALERT" }), "ALERT");
    assert.equal(resolveWebhookEventTarget({ severity: "ERROR", target: "LOG" }), "LOG");
});

test("Phase 1 Webhook Renovation: unified visual system and title formatting", () => {
    const logPayload = buildWebhookEventPayload({
        severity: "SUCCESS",
        category: "SYSTEM",
        code: "system.ready",
        title: "BOT READY"
    });
    assert.equal(logPayload.embeds[0].author.name, "PHOMUEANGTAI • ACTIVITY & AUDIT");
    assert.equal(logPayload.embeds[0].title, "🟢 SYSTEM · BOT READY");
    assert.equal(logPayload.embeds[0].footer.text, "SYSTEM · system.ready");

    const alertPayload = buildWebhookEventPayload({
        severity: "CRITICAL",
        category: "RUNTIME",
        code: "runtime.uncaught_exception",
        title: "UNCAUGHT EXCEPTION"
    });
    assert.equal(alertPayload.embeds[0].author.name, "PHOMUEANGTAI • ACTION REQUIRED");
    assert.equal(alertPayload.embeds[0].title, "🚨 RUNTIME · UNCAUGHT EXCEPTION");
    assert.equal(alertPayload.embeds[0].footer.text, "RUNTIME · runtime.uncaught_exception");

    // Test stripping redundant emojis and prefixes
    const strippedPayload = buildWebhookEventPayload({
        severity: "WARNING",
        category: "SECURITY",
        code: "security.trace_approval",
        title: "SHADOW REPORT: TRACE APPROVAL REQUIRED"
    });
    assert.equal(strippedPayload.embeds[0].title, "🟠 SECURITY · TRACE APPROVAL REQUIRED");
});

test("Phase 1 Webhook Renovation: canonical field layouts for LOG and ALERT", () => {
    const logPayload = buildWebhookEventPayload({
        target: "LOG",
        severity: "SUCCESS",
        category: "MODERATION",
        code: "moderation.ban",
        title: "MEMBER BANNED",
        actor: "AdminUser",
        server: "Community Guild",
        targetUser: "SpammerUser",
        actionName: "Ban Member",
        result: "Banned permanently",
        details: "Violation of rule 1"
    });
    const logFields = logPayload.embeds[0].fields.map(f => f.name);
    assert.deepEqual(logFields, [
        "ผู้ดำเนินการ",
        "เซิร์ฟเวอร์",
        "เป้าหมาย",
        "การกระทำ",
        "ผลลัพธ์",
        "รายละเอียด"
    ]);

    const alertPayload = buildWebhookEventPayload({
        target: "ALERT",
        severity: "ERROR",
        category: "DATABASE",
        code: "database.connection_lost",
        title: "CONNECTION LOST",
        state: "OPEN",
        impact: "ระบบอาจไม่สามารถบันทึกข้อมูลได้",
        action: "ระบบกำลังพยายามเชื่อมต่อใหม่",
        server: "Primary Cluster",
        errorCode: "ECONNREFUSED",
        details: "Heartbeat timeout"
    });
    const alertFields = alertPayload.embeds[0].fields.map(f => f.name);
    assert.deepEqual(alertFields, [
        "สถานะ",
        "ผลกระทบ",
        "สิ่งที่ควรทำ",
        "เซิร์ฟเวอร์",
        "รหัสข้อผิดพลาด",
        "รายละเอียด"
    ]);
});

test("Phase 1 Webhook Renovation: renders explicit event.fields with dedupe and precedence", () => {
    // 1. Test explicit fields in ALERT
    const alertWithFields = buildWebhookEventPayload({
        target: "ALERT",
        severity: "ERROR",
        category: "VOICE_ADMIN",
        code: "voiceadmin.enforcement_failed",
        title: "ENFORCEMENT FAILED",
        state: "OPEN",
        fields: [
            { name: "สถานะ", value: "OPEN" },
            { name: "ผลกระทบ", value: "lock ยังคงอยู่แต่ไมค์ยังไม่ถูกปิด" },
            { name: "สิ่งที่ควรทำ", value: "ตรวจสิทธิ์บอท" },
            { name: "เซิร์ฟเวอร์", value: "Voice Guild" },
            { name: "เป้าหมาย", value: "Target User" },
            { name: "รหัสข้อผิดพลาด", value: "50013" },
            { name: "User ID", value: "123456789" },
            { name: "ประเภท", value: "mute" }
        ]
    });

    const alertEmbed = alertWithFields.embeds[0];
    assert.equal(alertEmbed.title, "🔴 VOICE ADMIN · ENFORCEMENT FAILED");
    assert.equal(alertEmbed.footer.text, "VOICE ADMIN · voiceadmin.enforcement_failed");

    const alertFieldNames = alertEmbed.fields.map(f => f.name);
    // Canonical fields come first, custom fields appended after
    assert.deepEqual(alertFieldNames, [
        "สถานะ",
        "ผลกระทบ",
        "สิ่งที่ควรทำ",
        "เซิร์ฟเวอร์",
        "เป้าหมาย",
        "รหัสข้อผิดพลาด",
        "User ID",
        "ประเภท"
    ]);

    // Check that field values are preserved accurately
    assert.equal(alertEmbed.fields[0].value, "OPEN");
    assert.equal(alertEmbed.fields[6].name, "User ID");
    assert.equal(alertEmbed.fields[6].value, "123456789");

    // 2. Test explicit fields in LOG with dedupe
    const logWithFields = buildWebhookEventPayload({
        target: "LOG",
        severity: "SUCCESS",
        category: "GATEWAY",
        code: "gateway.shard_resumed",
        title: "GATEWAY SHARD RESUMED",
        actor: "Discord Gateway",
        fields: [
            { name: "ผู้ดำเนินการ", value: "Discord Gateway" },
            { name: "เป้าหมาย", value: "Shard 0 (discord)" },
            { name: "การกระทำ", value: "shard resume" },
            { name: "ผลลัพธ์", value: "สำเร็จ (4 events)" }
        ]
    });

    const logEmbed = logWithFields.embeds[0];
    assert.equal(logEmbed.title, "🟢 GATEWAY · SHARD RESUMED");
    assert.equal(logEmbed.footer.text, "GATEWAY · gateway.shard_resumed");

    const logFieldNames = logEmbed.fields.map(f => f.name);
    assert.deepEqual(logFieldNames, [
        "ผู้ดำเนินการ",
        "เป้าหมาย",
        "การกระทำ",
        "ผลลัพธ์"
    ]);
    assert.equal(logFieldNames.filter(name => name === "ผู้ดำเนินการ").length, 1, "Duplicate field must be deduped");
});

test("Phase 2 Webhook Renovation: Field deduplication edge cases (Case A, B, C, D and whitespace/casing)", () => {
    // Case A: explicit field vs top-level value -> explicit field wins
    const payloadCaseA = buildWebhookEventPayload({
        target: "LOG",
        severity: "INFO",
        category: "SYSTEM",
        code: "test.case_a",
        actor: "System",
        fields: [
            { name: "ผู้ดำเนินการ", value: "Admin" }
        ]
    });
    const embedA = payloadCaseA.embeds[0];
    const actorFieldsA = embedA.fields.filter(f => f.name === "ผู้ดำเนินการ");
    assert.equal(actorFieldsA.length, 1, "Only one actor field should be rendered");
    assert.equal(actorFieldsA[0].value, "Admin", "Explicit field value must take precedence over top-level actor");

    // Case B: duplicate fields within event.fields -> first non-empty value wins
    const payloadCaseB = buildWebhookEventPayload({
        target: "ALERT",
        severity: "ERROR",
        category: "SYSTEM",
        code: "test.case_b",
        fields: [
            { name: "สถานะ", value: "A" },
            { name: "สถานะ", value: "B" }
        ]
    });
    const embedB = payloadCaseB.embeds[0];
    const stateFieldsB = embedB.fields.filter(f => f.name === "สถานะ");
    assert.equal(stateFieldsB.length, 1, "Duplicate fields in event.fields must be deduped");
    assert.equal(stateFieldsB[0].value, "A", "First non-empty value must win");

    // Case C: explicit field vs context -> explicit field wins and deletes from context
    const payloadCaseC = buildWebhookEventPayload({
        target: "ALERT",
        severity: "ERROR",
        category: "SYSTEM",
        code: "test.case_c",
        fields: [
            { name: "สถานะ", value: "A" }
        ],
        context: {
            "สถานะ": "B"
        }
    });
    const embedC = payloadCaseC.embeds[0];
    const stateFieldsC = embedC.fields.filter(f => f.name === "สถานะ");
    assert.equal(stateFieldsC.length, 1, "Field in context matching explicit field must not be duplicated");
    assert.equal(stateFieldsC[0].value, "A", "Explicit field value must win over context");

    // Case D: top-level value vs context -> top-level canonical consumes and eliminates context duplicate
    const payloadCaseD = buildWebhookEventPayload({
        target: "ALERT",
        severity: "ERROR",
        category: "SYSTEM",
        code: "test.case_d",
        state: "OPEN",
        context: {
            "สถานะ": "custom"
        }
    });
    const embedD = payloadCaseD.embeds[0];
    const stateFieldsD = embedD.fields.filter(f => f.name === "สถานะ");
    assert.equal(stateFieldsD.length, 1, "Top-level canonical must eliminate duplicate in context");
    assert.equal(stateFieldsD[0].value, "เกิดปัญหา", "Canonical state label should be rendered");

    // Case E: Case and whitespace duplicate between fields and context
    const payloadCaseE = buildWebhookEventPayload({
        target: "LOG",
        severity: "INFO",
        category: "SYSTEM",
        code: "test.case_e",
        fields: [
            { name: "  เซิร์ฟเวอร์  ", value: "Alpha Server" }
        ],
        context: {
            "เซิร์ฟเวอร์": "Beta Server",
            " เซิร์ฟเวอร์ ": "Gamma Server"
        }
    });
    const embedE = payloadCaseE.embeds[0];
    const serverFieldsE = embedE.fields.filter(f => f.name.trim() === "เซิร์ฟเวอร์");
    assert.equal(serverFieldsE.length, 1, "Whitespace and case variation must be deduped");
    assert.equal(serverFieldsE[0].value, "Alpha Server");

    // Case F: duplicate custom fields in event.fields -> first non-empty value wins
    const payloadCaseF = buildWebhookEventPayload({
        target: "ALERT",
        severity: "WARNING",
        category: "SYSTEM",
        code: "test.case_f",
        fields: [
            { name: "Region", value: "US-West" },
            { name: "Region", value: "EU-Central" }
        ]
    });
    const embedF = payloadCaseF.embeds[0];
    const regionFieldsF = embedF.fields.filter(f => f.name === "Region");
    assert.equal(regionFieldsF.length, 1, "Duplicate custom fields must be deduped");
    assert.equal(regionFieldsF[0].value, "US-West", "First custom field value wins");

    // Case G: duplicate context entries -> first non-empty value wins
    const payloadCaseG = buildWebhookEventPayload({
        target: "ALERT",
        severity: "INFO",
        category: "SYSTEM",
        code: "test.case_g",
        context: {
            "Memory": "250MB",
            " memory ": "350MB"
        }
    });
    const embedG = payloadCaseG.embeds[0];
    const memFieldsG = embedG.fields.filter(f => f.name.toLowerCase() === "memory");
    assert.equal(memFieldsG.length, 1, "Context whitespace/casing duplicate must be deduped");
    assert.equal(memFieldsG[0].value, "250MB", "First context entry wins");
});

test("Phase 2 Webhook Renovation: Redundant category prefixes in titles are cleanly stripped", () => {
    const titlesToCheck = [
        { category: "DATABASE", title: "DATABASE CONNECTION LOST", expected: "🚨 DATABASE · CONNECTION LOST", severity: "CRITICAL" },
        { category: "TOKEN", title: "TOKEN QUARANTINED", expected: "🔴 TOKEN · QUARANTINED", severity: "ERROR" },
        { category: "MODERATION", title: "MODERATION ACTION FAILED", expected: "🔴 MODERATION · ACTION FAILED", severity: "ERROR" },
        { category: "GATEWAY", title: "GATEWAY SHARD ERROR", expected: "🔴 GATEWAY · SHARD ERROR", severity: "ERROR" },
        { category: "GATEWAY", title: "GATEWAY CONNECTION ERROR", expected: "🔴 GATEWAY · CONNECTION ERROR", severity: "ERROR" },
        { category: "VERIFICATION", title: "VERIFICATION MAINTENANCE FAILED", expected: "🟠 VERIFICATION · MAINTENANCE FAILED", severity: "WARNING" }
    ];

    for (const item of titlesToCheck) {
        const payload = buildWebhookEventPayload({
            target: "ALERT",
            severity: item.severity,
            category: item.category,
            code: "test.title_dedupe",
            title: item.title
        });
        assert.equal(payload.embeds[0].title, item.expected, `Expected clean title for ${item.title}`);
    }
});

test("Phase 2 Webhook Renovation: actor/operator alias collision is deduplicated", () => {
    // 1. Both ผู้ดำเนินการ and ผู้สั่งการ in event.fields -> only 1 canonical actor field rendered (first wins)
    const payloadBoth = buildWebhookEventPayload({
        severity: "INFO",
        category: "MODERATION",
        fields: [
            { name: "ผู้ดำเนินการ", value: "Admin A" },
            { name: "ผู้สั่งการ", value: "Admin B" }
        ]
    });
    const fieldsBoth = payloadBoth.embeds[0].fields;
    const actorFieldsBoth = fieldsBoth.filter(f => f.name === "ผู้ดำเนินการ" || f.name === "ผู้สั่งการ");
    assert.equal(actorFieldsBoth.length, 1, "Only one canonical actor field should be rendered");
    assert.equal(actorFieldsBoth[0].name, "ผู้ดำเนินการ");
    assert.equal(actorFieldsBoth[0].value, "Admin A");

    // 2. Explicit ผู้สั่งการ in fields takes precedence over top-level actor
    const payloadAliasExplicit = buildWebhookEventPayload({
        severity: "INFO",
        category: "MODERATION",
        actor: "System",
        fields: [
            { name: "ผู้สั่งการ", value: "Admin B" }
        ]
    });
    const fieldsAlias = payloadAliasExplicit.embeds[0].fields;
    const actorFieldsAlias = fieldsAlias.filter(f => f.name === "ผู้ดำเนินการ" || f.name === "ผู้สั่งการ");
    assert.equal(actorFieldsAlias.length, 1);
    assert.equal(actorFieldsAlias[0].name, "ผู้ดำเนินการ");
    assert.equal(actorFieldsAlias[0].value, "Admin B");

    // 3. Top-level actor eliminates alias ผู้สั่งการ from context
    const payloadContextAlias = buildWebhookEventPayload({
        severity: "INFO",
        category: "MODERATION",
        actor: "Admin A",
        context: {
            "ผู้สั่งการ": "Admin B"
        }
    });
    const fieldsContext = payloadContextAlias.embeds[0].fields;
    const actorFieldsContext = fieldsContext.filter(f => f.name === "ผู้ดำเนินการ" || f.name === "ผู้สั่งการ");
    assert.equal(actorFieldsContext.length, 1);
    assert.equal(actorFieldsContext[0].name, "ผู้ดำเนินการ");
    assert.equal(actorFieldsContext[0].value, "Admin A");
});

test("sendDedupedWebhook recovers from failed pending delivery without infinite recursion", async () => {
    let attempts = 0;
    let releaseFirst;
    const calls = [];

    const mockDispatcher = {
        enqueue: async (target, payload) => {
            attempts++;
            calls.push({ attempt: attempts, target, payload });
            if (attempts === 1) {
                // First attempt hangs until we let it fail
                await new Promise(resolve => { releaseFirst = resolve; });
                return false; // Fails delivery
            }
            return true; // Subsequent attempt succeeds
        }
    };

    const options = {
        dispatcher: mockDispatcher,
        dedupeKey: "fail-recovery-test",
        dedupeMs: 10_000,
        summaryLabel: "test event"
    };

    // Caller 1 starts sending (attempt 1)
    const promise1 = sendLogWebhook("message 1", options);
    await new Promise(resolve => setImmediate(resolve));

    // Caller 2 enters while attempt 1 is still in-flight
    const promise2 = sendLogWebhook("message 2", options);
    await new Promise(resolve => setImmediate(resolve));

    // Now fail attempt 1
    releaseFirst();

    const [res1, res2] = await Promise.all([promise1, promise2]);

    assert.equal(res1, false, "First delivery attempt should report false on failure");
    assert.equal(res2, true, "Second delivery attempt should take over and succeed without recursion");
    assert.equal(attempts, 2, "Exactly 2 attempts should have been made");
    await flushWebhookQueue(20);
});

test("WEBHOOK_LOG_URL visual renovation: vibrant category neon colors and emojis", () => {
    const { _test } = require("../core/webhooks");

    // 1. Verify category-specific neon colors for target: LOG with severity: INFO
    const categoriesToTest = [
        { category: "GUILD", expectedColor: 0x00F5D4, expectedEmoji: "🏰" },
        { category: "MODERATION", expectedColor: 0xFF5722, expectedEmoji: "⚖️" },
        { category: "OWNER", expectedColor: 0xFFD700, expectedEmoji: "👑" },
        { category: "ADMIN", expectedColor: 0xFFA000, expectedEmoji: "⚙️" },
        { category: "QUEST", expectedColor: 0x9D4EDD, expectedEmoji: "🚀" },
        { category: "TOKEN", expectedColor: 0x00BBF9, expectedEmoji: "🔑" },
        { category: "SECURITY", expectedColor: 0xF72585, expectedEmoji: "🛡️" },
        { category: "VOICE", expectedColor: 0x38B6FF, expectedEmoji: "🔊" },
        { category: "VERIFICATION", expectedColor: 0x48CAE4, expectedEmoji: "📋" },
        { category: "COMMAND", expectedColor: 0x7209B7, expectedEmoji: "⚡" },
        { category: "DATABASE", expectedColor: 0x06D6A0, expectedEmoji: "💾" },
        { category: "GATEWAY", expectedColor: 0x4361EE, expectedEmoji: "🌐" },
        { category: "SYSTEM", expectedColor: 0x00D2FF, expectedEmoji: "✨" }
    ];

    for (const item of categoriesToTest) {
        const payload = buildWebhookEventPayload({
            target: "LOG",
            severity: "INFO",
            category: item.category,
            code: `${item.category.toLowerCase()}.event`,
            title: "EVENT TRIGGERED"
        });
        const embed = payload.embeds[0];
        assert.equal(embed.color, item.expectedColor, `Color mismatch for ${item.category}`);
        assert.equal(embed.title, `${item.expectedEmoji} ${item.category} · EVENT TRIGGERED`, `Emoji mismatch for ${item.category}`);
    }

    // 2. Verify severity SUCCESS in LOG uses vibrant emerald green and green circle
    const successPayload = buildWebhookEventPayload({
        target: "LOG",
        severity: "SUCCESS",
        category: "SYSTEM",
        code: "system.ok",
        title: "ONLINE"
    });
    assert.equal(successPayload.embeds[0].color, 0x00E676);
    assert.equal(successPayload.embeds[0].title, "🟢 SYSTEM · ONLINE");

    // 3. Verify event.reason maps cleanly to canonical รายละเอียด field
    const reasonPayload = buildWebhookEventPayload({
        target: "LOG",
        severity: "INFO",
        category: "MODERATION",
        code: "moderation.warn",
        title: "MEMBER WARNED",
        actor: "Moderator",
        targetUser: "BadActor",
        reason: "Repeated spam in chat"
    });
    const detailField = reasonPayload.embeds[0].fields.find(f => f.name === "รายละเอียด");
    assert.ok(detailField, "รายละเอียด field must be present when reason is provided");
    assert.equal(detailField.value, "Repeated spam in chat");
});



