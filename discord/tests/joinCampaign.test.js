const fs = require("node:fs");
const test = require("node:test");

const joinCampaign = require("../features/joinCampaign");
const {
    listJoinCampaignTargets,
    resolveJoinCampaignTarget
} = require("../index/joinCampaignRoutes");
const { streamCandidates, countEligibleCandidates } = require("../features/joinCampaign/services/candidateQueryService");
const { sanitizeUserFacingError, isValidDiscordWebhookUrl } = require("../features/joinCampaign/worker/batchLogger");
const joinCampaignService = require("../features/joinCampaign/services/joinCampaignService");

test("candidateQueryService: countEligibleCandidates accurately counts and filters target members", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const fakeCandidates = [
        { userId: "100", tokenField: "oauth", scope: "identify guilds.join" },
        { userId: "200", tokenField: "adminOAuth", scope: "identify guilds guilds.join" },
        { userId: "300", tokenField: "oauth", scope: "identify email" },
        { userId: "400", tokenField: "oauth", scope: "identify guilds.join" }
    ];

    const fakeTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: fakeCandidates,
            hasMore: false,
            nextCursor: null
        })
    };

    // User 100 is already in target guild
    const targetMemberIds = new Set(["100"]);

    const readyCount = await countEligibleCandidates({
        mode: { requiresSource: false },
        baseConfig: { targetGuildId: "123456789012345678" },
        tokenManager: fakeTokenManager,
        targetMemberIds
    });

    // 200, 300, 400 not in target guild. Total non-target candidates = 3.
    t.assert.equal(readyCount, 3);
});

test("joinCampaign: stageCampaign applies guild validation without an activation setting", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const result = await joinCampaignService.stageCampaign({
        client: { guilds: { cache: new Map() } },
        repository: {},
        mode: joinCampaign.getMode("ALL_TO_TARGET"),
        baseConfig: { targetGuildId: "invalid" }
    });

    t.assert.equal(result.ok, false);
    t.assert.match(result.error, /17–22 หลัก/);
});

test("join campaign config has no activation setting and preserves guild allowlist behavior", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const defaults = joinCampaign.getJoinCampaignConfig({});
    t.assert.equal(Object.hasOwn(defaults, "enabled"), false);
    t.assert.equal(defaults.allowedGuilds.size, 0);

    // Unconfigured allowlist permits valid snowflake
    t.assert.equal(joinCampaign.isGuildAllowed("123456789012345678", {
        allowedGuilds: new Set()
    }), true);

    // Configured allowlist restricts to allowlist entries
    t.assert.equal(joinCampaign.isGuildAllowed("123456789012345678", {
        allowedGuilds: new Set(["999999999999999999"])
    }), false);
    t.assert.equal(joinCampaign.isGuildAllowed("999999999999999999", {
        allowedGuilds: new Set(["999999999999999999"])
    }), true);
});

test("join campaign route helpers list and resolve allowed target guilds", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const oldAllowed = process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS;
    process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS = "111111111111111111";

    try {
        const cache = new Map([
            ["111111111111111111", { id: "111111111111111111", name: "Allowed", memberCount: 10 }],
            ["222222222222222222", { id: "222222222222222222", name: "Blocked", memberCount: 20 }]
        ]);
        const client = { guilds: { cache } };

        const targets = listJoinCampaignTargets(client);
        t.assert.equal(targets.length, 1);
        t.assert.equal(targets[0].id, "111111111111111111");

        t.assert.equal(resolveJoinCampaignTarget(client, "111111111111111111").ok, true);
        t.assert.equal(resolveJoinCampaignTarget(client, "222222222222222222").status, 403);
        t.assert.equal(resolveJoinCampaignTarget(client, "333333333333333333").status, 403);
    } finally {
        if (oldAllowed === undefined) delete process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS;
        else process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS = oldAllowed;
    }
});

test("join campaign follows database cursor batches until every OAuth user is scanned", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const calls = [];
    const batches = [
        [
            { _id: "1", userId: "100", tokenField: "oauth" },
            { _id: "2", userId: "200", tokenField: "oauth" }
        ],
        [
            { _id: "3", userId: "300", tokenField: "oauth" }
        ]
    ];

    const fakeTokenManager = {
        listAccessTokenCandidates: async (opts) => {
            calls.push(opts);
            const idx = calls.length - 1;
            const candidates = batches[idx] || [];
            const hasMore = idx < batches.length - 1;
            const nextCursor = candidates.length > 0 ? candidates[candidates.length - 1]._id : null;
            return { candidates, hasMore, nextCursor };
        }
    };

    const stream = streamCandidates({
        mode: { requiresSource: false },
        baseConfig: { targetGuildId: "123456789012345678" },
        tokenManager: fakeTokenManager,
        batchSize: 2
    });

    const gathered = [];
    for await (const item of stream) {
        gathered.push(item.candidate.userId);
    }

    t.assert.deepEqual(gathered, ["100", "200", "300"]);
    t.assert.equal(calls.length, 2);
    t.assert.equal(calls[1].afterId, "2");
});

test("batchLogger: sanitizeUserFacingError prevents technical leakage", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const techError = sanitizeUserFacingError("MongoNetworkError: failed to connect to [127.0.0.1:27017]");
    t.assert.match(techError, /ฐานข้อมูล/);
    t.assert.equal(techError.includes("127.0.0.1"), false);

    const discordError = sanitizeUserFacingError("DiscordAPIError[30005]: Maximum number of guilds reached");
    t.assert.match(discordError, /เซิร์ฟเวอร์/);
});

test("batchLogger: isValidDiscordWebhookUrl strictly validates Discord webhook patterns", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    t.assert.equal(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123456789012345678/token_abc-123"), true);
    t.assert.equal(isValidDiscordWebhookUrl("https://discordapp.com/api/webhooks/123456789012345678/token_abc-123"), true);
    t.assert.equal(isValidDiscordWebhookUrl("https://malicious.site/api/webhooks/123/abc"), false);
    t.assert.equal(isValidDiscordWebhookUrl("not-a-url"), false);
});

test("join campaign has no Sync Roles UI or route surface", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const runtimeSurface = [
        fs.readFileSync("discord/index/joinCampaignPage.js", "utf8"),
        fs.readFileSync("discord/index/joinCampaignRoutes.js", "utf8"),
        fs.readFileSync("discord/features/joinCampaign.js", "utf8"),
        fs.readFileSync("discord/verification/guildPage.js", "utf8"),
        fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8"),
        fs.readFileSync("discord/verification/routes/guild.js", "utf8")
    ].join("\n");

    t.assert.equal(/sync-roles/i.test(runtimeSurface), false);
    t.assert.equal(/syncRoles/.test(runtimeSurface), false);
    t.assert.equal(/Sync Roles/.test(runtimeSurface), false);
});

test("join campaign owner dashboard is strictly read-only monitoring without mutating controls", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const pageSource = fs.readFileSync("discord/index/joinCampaignPage.js", "utf8");
    const routesSource = fs.readFileSync("discord/index/joinCampaignRoutes.js", "utf8");

    // No mutation action buttons in UI
    t.assert.equal(pageSource.includes("btnStartCampaign"), false);
    t.assert.equal(pageSource.includes("btnDryRun"), false);
    t.assert.equal(pageSource.includes("btnStopCampaign"), false);
    t.assert.equal(pageSource.includes("startCampaign()"), false);

    // No POST mutating endpoints in routes
    t.assert.equal(routesSource.includes('app.post("/api/join-campaign/start"'), false);
    t.assert.equal(routesSource.includes('app.post("/api/join-campaign/dry-run"'), false);
    t.assert.equal(routesSource.includes('app.post("/api/join-campaign/stop"'), false);
    t.assert.equal(routesSource.includes('app.get("/api/join-campaign/history"'), true);
    t.assert.equal(routesSource.includes('app.get("/api/join-campaign/metrics"'), true);
});
