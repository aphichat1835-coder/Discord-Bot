const fs = require("node:fs");
const test = require("node:test");

const joinCampaign = require("../features/joinCampaign");
const {
    listJoinCampaignTargets,
    resolveJoinCampaignTarget
} = require("../index/joinCampaignRoutes");

test("join campaign candidate summary uses only tokens with guilds.join", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const docs = [
        {
            discord: { userId: "100" },
            oauth: {
                encryptedRefreshToken: "verify-refresh",
                scope: "identify guilds.join"
            }
        },
        {
            discord: { userId: "200" },
            adminOAuth: {
                encryptedRefreshToken: "admin-refresh",
                scope: "identify guilds guilds.join"
            }
        },
        {
            discord: { userId: "300" },
            oauth: {
                encryptedRefreshToken: "verify-refresh-2",
                scope: "identify email"
            }
        },
        {
            discord: { userId: "200" },
            oauth: {
                encryptedRefreshToken: "duplicate-refresh",
                scope: "identify guilds.join"
            }
        }
    ];

    const summary = joinCampaign.summarizeJoinCandidates(docs);

    t.assert.equal(summary.scannedRecords, 4);
    t.assert.equal(summary.uniqueUsers, 3);
    t.assert.equal(summary.usableUsers, 2);
    t.assert.equal(summary.missingScope, 1);
    t.assert.equal(summary.byTokenField.oauth, 1);
    t.assert.equal(summary.byTokenField.adminOAuth, 1);
});

test("join campaign refreshes expiring token before adding member", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const updates = [];
    const joined = [];
    const docs = [
        {
            _id: "doc1",
            discord: { userId: "100" },
            oauth: {
                encryptedAccessToken: "old-access",
                encryptedRefreshToken: "old-refresh",
                expiresAt: 1,
                scope: "identify guilds.join",
                refreshFailCount: 0
            }
        }
    ];

    const fakeModel = {
        updateOne: async (filter, update) => {
            updates.push({ filter, update });
        }
    };
    const fakeDiscord = {
        getGuildMemberWithBot: async () => null,
        refreshToken: async (refreshToken, redirectUri) => {
            t.assert.equal(refreshToken, "old-refresh");
            t.assert.match(redirectUri, /\/auth\/callback$/);
            return {
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 604800,
                scope: "identify guilds.join",
                token_type: "Bearer"
            };
        },
        addMemberToGuild: async (guildId, userId, accessToken) => {
            joined.push({ guildId, userId, accessToken });
            return { ok: true, status: 201 };
        }
    };

    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        targetGuildName: "Target",
        candidateDocs: docs,
        OAuthUserModel: fakeModel,
        discordApi: fakeDiscord,
        config: {
            enabled: true,
            allowedGuilds: new Set(["123456789012345678"]),
            maxUsers: 10,
            delayMs: 0,
            progressEvery: 50,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        decryptToken: value => value === "enc:new-access" ? "new-access" : null,
        prepareTokenStorage: tokenData => ({
            encryptedAccessToken: `enc:${tokenData.access_token}`,
            encryptedRefreshToken: `enc:${tokenData.refresh_token}`,
            expiresAt: 999999,
            scope: tokenData.scope,
            tokenType: tokenData.token_type
        }),
        sendWebhook: async () => true,
        sleep: async () => {}
    });

    t.assert.equal(summary.joined, 1);
    t.assert.equal(summary.refreshed, 1);
    t.assert.equal(summary.failed, 0);
    t.assert.equal(joined.length, 1);
    t.assert.deepEqual(joined[0], {
        guildId: "123456789012345678",
        userId: "100",
        accessToken: "new-access"
    });
    t.assert.equal(updates.length, 1);
    t.assert.equal(updates[0].update.$set.oauth.encryptedAccessToken, "enc:new-access");
});

test("Thai join campaign log summarizes counts without raw tokens", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const payload = joinCampaign.formatThaiJoinCampaignLog({
        campaignId: "join_test",
        targetGuildId: "123456789012345678",
        targetGuildName: "ปลายทาง",
        dryRun: false,
        status: "finished",
        scannedRecords: 10,
        uniqueUsers: 8,
        usableUsers: 7,
        joined: 5,
        alreadyMember: 1,
        failed: 1,
        refreshed: 2,
        refreshFailed: 0,
        missingScope: 1,
        tokenInvalid: 0,
        botMissingPermission: 0,
        rateLimited: 0,
        errors: [{ userId: "100", reason: "discord_error", detail: "no token value here" }]
    }, "finish");

    t.assert.match(payload.content, /งานดึงสมาชิกเข้าเซิร์ฟเวอร์เสร็จแล้ว/);
    t.assert.match(payload.content, /ดึงเข้าสำเร็จ: 5/);
    t.assert.equal(payload.content.includes("new-access"), false);
    t.assert.equal(payload.content.includes("old-refresh"), false);
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

test("startJoinCampaign rejects disabled config before creating an active job", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    joinCampaign._test.runningState.active = null;
    joinCampaign._test.runningState.last = null;
    joinCampaign._test.runningState.stopRequested = false;

    const result = joinCampaign.startJoinCampaign({
        targetGuildId: "123456789012345678",
        config: {
            enabled: false,
            allowedGuilds: new Set(),
            maxUsers: 10,
            delayMs: 0,
            progressEvery: 10,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        }
    });

    t.assert.equal(result.ok, false);
    t.assert.equal(result.error, "campaign_disabled");
    t.assert.equal(joinCampaign.getJoinCampaignStatus().active, null);
});

test("join campaign allows every bot guild when allowlist is empty", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    t.assert.equal(joinCampaign.isGuildAllowed("123456789012345678", {
        enabled: true,
        allowedGuilds: new Set()
    }), true);

    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        candidateDocs: [],
        config: {
            enabled: true,
            allowedGuilds: new Set(),
            maxUsers: 10,
            delayMs: 0,
            progressEvery: 10,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        sendWebhook: async () => true
    });
    t.assert.equal(summary.status, "finished");
    t.assert.equal(summary.scannedRecords, 0);
});

test("join campaign follows database cursor batches until every OAuth user is scanned", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const calls = [];
    const batches = [
        [
            { _id: "1", discord: { userId: "100" }, oauth: { encryptedRefreshToken: "a", scope: "guilds.join" } },
            { _id: "2", discord: { userId: "200" }, oauth: { encryptedRefreshToken: "b", scope: "guilds.join" } }
        ],
        [{ _id: "3", discord: { userId: "200" }, oauth: { encryptedRefreshToken: "duplicate", scope: "guilds.join" } }]
    ];
    const model = {
        find(filter) {
            calls.push(filter);
            const docs = batches.shift() || [];
            const query = {
                select: () => query,
                sort: () => query,
                limit: () => query,
                lean: async () => docs
            };
            return query;
        }
    };
    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        OAuthUserModel: model,
        dryRun: true,
        config: {
            enabled: true,
            allowedGuilds: new Set(),
            batchSize: 2,
            delayMs: 0,
            progressEvery: 10,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        sendWebhook: async () => true
    });

    t.assert.equal(summary.scannedRecords, 3);
    t.assert.equal(summary.uniqueUsers, 2);
    t.assert.equal(summary.usableUsers, 2);
    t.assert.equal(summary.missingScope, 0);
    t.assert.equal(summary.batches, 2);
    t.assert.equal(calls.length, 2);
    t.assert.deepEqual(calls[1].$and.at(-1), { _id: { $gt: "2" } });
});

test("join campaign has no Sync Roles UI or route surface", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const runtimeSurface = [
        fs.readFileSync("discord/index/joinCampaignPage.js", "utf8"),
        fs.readFileSync("discord/index/joinCampaignRoutes.js", "utf8"),
        fs.readFileSync("discord/features/joinCampaign.js", "utf8"),
        fs.readFileSync("discord/verification/views/guild.html", "utf8"),
        fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8"),
        fs.readFileSync("discord/verification/routes/guild.js", "utf8")
    ].join("\n");

    t.assert.equal(/sync-roles/i.test(runtimeSurface), false);
    t.assert.equal(/syncRoles/.test(runtimeSurface), false);
    t.assert.equal(/Sync Roles/.test(runtimeSurface), false);
});

test("join campaign confirmation stays bound to the guild captured before dry-run", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const source = fs.readFileSync("discord/index/joinCampaignPage.js", "utf8");
    const start = source.indexOf("async function startCampaign()");
    const capturedName = source.indexOf("const guildName=", start);
    const dryRun = source.indexOf("await api('/api/join-campaign/dry-run'", start);
    const selectionGuard = source.indexOf("if(selectedGuildId() !== guildId)", dryRun);
    const confirmation = source.indexOf("window.confirm", dryRun);

    t.assert.ok(start >= 0);
    t.assert.ok(capturedName > start && capturedName < dryRun);
    t.assert.ok(selectionGuard > dryRun && selectionGuard < confirmation);
});
