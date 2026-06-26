const assert = require("node:assert/strict");
const test = require("node:test");

const joinCampaign = require("../features/joinCampaign");
const {
    listJoinCampaignTargets,
    resolveJoinCampaignTarget
} = require("../index/joinCampaignRoutes");

test("join campaign candidate summary uses only tokens with guilds.join", () => {
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

    assert.equal(summary.scannedRecords, 4);
    assert.equal(summary.uniqueUsers, 3);
    assert.equal(summary.usableUsers, 2);
    assert.equal(summary.missingScope, 1);
    assert.equal(summary.byTokenField.oauth, 1);
    assert.equal(summary.byTokenField.adminOAuth, 1);
});

test("join campaign refreshes expiring token before adding member", async () => {
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
            assert.equal(refreshToken, "old-refresh");
            assert.match(redirectUri, /\/auth\/callback$/);
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

    assert.equal(summary.joined, 1);
    assert.equal(summary.refreshed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(joined.length, 1);
    assert.deepEqual(joined[0], {
        guildId: "123456789012345678",
        userId: "100",
        accessToken: "new-access"
    });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.$set.oauth.encryptedAccessToken, "enc:new-access");
});

test("Thai join campaign log summarizes counts without raw tokens", () => {
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

    assert.match(payload.content, /งานดึงสมาชิกเข้าเซิร์ฟเวอร์เสร็จแล้ว/);
    assert.match(payload.content, /ดึงเข้าสำเร็จ: 5/);
    assert.equal(payload.content.includes("new-access"), false);
    assert.equal(payload.content.includes("old-refresh"), false);
});

test("join campaign route helpers list and resolve allowed target guilds", () => {
    const oldAllowed = process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS;
    process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS = "111111111111111111";

    try {
        const cache = new Map([
            ["111111111111111111", { id: "111111111111111111", name: "Allowed", memberCount: 10 }],
            ["222222222222222222", { id: "222222222222222222", name: "Blocked", memberCount: 20 }]
        ]);
        const client = { guilds: { cache } };

        const targets = listJoinCampaignTargets(client);
        assert.equal(targets.length, 1);
        assert.equal(targets[0].id, "111111111111111111");

        assert.equal(resolveJoinCampaignTarget(client, "111111111111111111").ok, true);
        assert.equal(resolveJoinCampaignTarget(client, "222222222222222222").status, 403);
        assert.equal(resolveJoinCampaignTarget(client, "333333333333333333").status, 403);
    } finally {
        if (oldAllowed === undefined) delete process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS;
        else process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS = oldAllowed;
    }
});

test("startJoinCampaign rejects disabled config before creating an active job", () => {
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

    assert.equal(result.ok, false);
    assert.equal(result.error, "campaign_disabled");
    assert.equal(joinCampaign.getJoinCampaignStatus().active, null);
});

test("join campaign rejects empty allowed guild list even when enabled", async () => {
    assert.equal(joinCampaign.isGuildAllowed("123456789012345678", {
        enabled: true,
        allowedGuilds: new Set()
    }), false);

    await assert.rejects(() => joinCampaign.executeJoinCampaign({
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
        }
    }), /Target guild is not allowed/);
});
