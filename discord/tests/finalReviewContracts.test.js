"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function source(name) {
    switch (name) {
        case "system":
            // nosemgrep -- fixed repository-relative fixture; no user-controlled path reaches the filesystem.
            return fs.readFileSync("discord/index/system.js", "utf8");
        case "oauthStart":
            // nosemgrep -- fixed repository-relative fixture; no user-controlled path reaches the filesystem.
            return fs.readFileSync("discord/verification/routes/oauthStart.js", "utf8");
        case "guild":
            // nosemgrep -- fixed repository-relative fixture; no user-controlled path reaches the filesystem.
            return fs.readFileSync("discord/verification/routes/guild.js", "utf8");
        case "runtimeLifecycle":
            return fs.readFileSync("discord/core/runtimeLifecycle.js", "utf8");
        case "http":
            return fs.readFileSync("discord/core/http.js", "utf8");
        case "index":
            return fs.readFileSync("discord/index.js", "utf8");
        case "views":
            return fs.readFileSync("discord/index/views.js", "utf8");
        case "joinCampaignPage":
            return fs.readFileSync("discord/index/joinCampaignPage.js", "utf8");
        case "moderation":
            return fs.readFileSync("discord/commands/moderation.js", "utf8");
        default:
            throw new Error(`Unknown source fixture: ${name}`);
    }
}

function createElement() {
    return { disabled: false, value: "", textContent: "", className: "", style: {} };
}

function createFeatureDashboardContext(fetchImpl) {
    const ids = [
        "naturalEnabled", "naturalInterval", "naturalDuration", "natSave", "natDot", "natTxt", "natBadge", "natRetry", "natMsg",
        "autoDeafEnabled", "autoDeafInterval", "autoDeafOpenDuration", "adSave", "adDot", "adTxt", "adBadge", "adRetry", "adMsg"
    ];
    const elements = new Map(ids.map(id => [id, createElement()]));
    const page = source("views");
    const start = page.indexOf("const FEATURE_CONTROL_IDS=");
    const end = page.indexOf("async function saveAutoDeaf", start);
    assert.ok(start >= 0 && end > start, "dashboard feature script markers must exist");
    const context = {
        document: { getElementById: id => elements.get(id) || null },
        fetch: fetchImpl,
        clearTimeout() {},
        setTimeout() { return { unref() {} }; }
    };
    vm.runInNewContext(page.slice(start, end), context);
    return { context, elements };
}

function createCampaignDashboardContext(fetchImpl) {
    const page = source("joinCampaignPage");
    const start = page.indexOf("function esc(v){");
    const end = page.indexOf("async function dryRun()", start);
    assert.ok(start >= 0 && end > start, "campaign polling script markers must exist");
    const freshness = createElement();
    const context = {
        document: { getElementById: id => id === "campaignFreshness" ? freshness : createElement() },
        fetch: fetchImpl,
        Date: class extends Date { static now() { return 0; } }
    };
    vm.runInNewContext(page.slice(start, end), context);
    return { context, freshness };
}

test("runtime uses one explicit graceful-shutdown coordinator without import-time replacement", () => {
    const system = source("system");
    const runtimeLifecycle = source("runtimeLifecycle");
    assert.match(runtimeLifecycle, /function registerShutdownHandlers\(options = \{\}\)/);
    assert.match(runtimeLifecycle, /processRef\.on\("SIGTERM"/);
    assert.match(runtimeLifecycle, /processRef\.on\("SIGINT"/);
    assert.doesNotMatch(runtimeLifecycle, /installShutdownCoordinator/);
    assert.doesNotMatch(system, /function initShutdown/);
    assert.doesNotMatch(source("http"), /runtimeLifecycle/);
    assert.match(source("index"), /registerShutdownHandlers\(\{/);
    assert.match(runtimeLifecycle, /forceTimeoutMs = 50000/);
});

test("the retired voicekickall implementation is absent from production moderation source", () => {
    const moderation = source("moderation");
    assert.doesNotMatch(moderation, /voicekickall/);
    assert.doesNotMatch(moderation, /handleVoiceKickAll/);
    assert.doesNotMatch(moderation, /activeVoiceKicks/);
});

test("dashboard polling exposes unavailable or stale data instead of swallowing it", () => {
    const views = source("views");
    const campaign = source("joinCampaignPage");
    assert.match(views, /showFeatureLoadFailure\('nat','Natural Blink',e\)/);
    assert.match(views, /showFeatureLoadFailure\('ad','Auto Deaf',e\)/);
    assert.match(views, /id="natSave"[^>]*disabled/);
    assert.match(views, /id="adSave"[^>]*disabled/);
    assert.match(campaign, /id="campaignFreshness"/);
    assert.match(campaign, /ข้อมูลด้านล่างอาจเก่า/);
});

test("Natural Blink and Auto Deaf controls remain disabled on failed loads and recover after retry", async () => {
    const scenarios = [
        async () => ({ ok: false, status: 500, json: async () => ({}) }),
        async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } }),
        async () => { throw new Error("network rejected"); }
    ];
    for (const failedFetch of scenarios) {
        const { context, elements } = createFeatureDashboardContext(failedFetch);
        await context.loadNatural();
        await context.loadAutoDeaf();
        for (const id of ["naturalEnabled", "naturalInterval", "naturalDuration", "natSave", "autoDeafEnabled", "autoDeafInterval", "autoDeafOpenDuration", "adSave"]) assert.equal(elements.get(id).disabled, true);
        assert.match(elements.get("natTxt").textContent, /โหลดสถานะ Natural Blink ไม่ได้/);
        assert.match(elements.get("adTxt").textContent, /โหลดสถานะ Auto Deaf ไม่ได้/);
        assert.equal(elements.get("natBadge").textContent, "ข้อมูลอาจเก่า");
        assert.equal(elements.get("adBadge").textContent, "ข้อมูลอาจเก่า");
    }

    const { context, elements } = createFeatureDashboardContext(async path => ({
        ok: true,
        status: 200,
        json: async () => path.includes("natural")
            ? { success: true, settings: { enabled: true, intervalMs: 120000, durationMs: 9000, activeTimers: 2 } }
            : { success: true, settings: { enabled: false, intervalMs: 180000, openDurationMs: 12000, activeTimers: 3 } }
    }));
    await context.loadNatural();
    await context.loadAutoDeaf();
    assert.equal(elements.get("naturalEnabled").disabled, false);
    assert.equal(elements.get("autoDeafEnabled").disabled, false);
    assert.equal(elements.get("naturalInterval").value, "120000");
    assert.equal(elements.get("autoDeafInterval").value, "180000");
    assert.equal(elements.get("natRetry").style.display, "none");
    assert.equal(elements.get("adRetry").style.display, "none");
});

test("Join Campaign polling marks retained values as stale on failure and clears the warning after recovery", async () => {
    const failed = createCampaignDashboardContext(async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } }));
    await failed.context.refreshStatus();
    assert.equal(failed.freshness.textContent, "⚠️ โหลดสถานะไม่ได้ — ข้อมูลด้านล่างอาจเก่า");
    assert.equal(failed.freshness.style.color, "var(--yellow2)");

    const recovered = createCampaignDashboardContext(async () => ({ ok: true, status: 200, json: async () => ({ success: true, status: { active: { status: "running" } } }) }));
    await recovered.context.refreshStatus();
    assert.match(recovered.freshness.textContent, /^อัปเดตล่าสุด:/);
    assert.equal(recovered.freshness.style.color, "var(--text3)");
});

test("OAuth start uses the dedicated handler instead of an unreachable duplicate route", () => {
    const oauthStart = source("oauthStart");
    assert.match(oauthStart, /function createOAuthStartHandler/);
    assert.match(oauthStart, /try \{/);
    assert.match(oauthStart, /catch \(error\)/);
    assert.match(oauthStart, /https:\/\/discord\.com\/oauth2\/authorize/);
    assert.equal(source("oauthStart").includes("router.get('/auth/start'"), false);
});

test("privacy deletion response uses the verified manifest deletedCount", () => {
    const guild = source("guild");
    assert.match(guild, /deletedCount: Number\(deletion\.manifest\?\.deletedCount \|\| 0\)/);
    assert.doesNotMatch(guild, /deletedCount: Object\.values\(deletion\.manifest/);
});
