"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const lifecycle = require("../discord/verification/utils/oauthTokenLifecycle");
const privacy = require("../discord/verification/services/privacyDeletion");

function queryResult(value) {
    return {
        sort() { return this; },
        limit: async () => value,
        lean: async () => value
    };
}

test("concurrent OAuth scans re-read token state inside the lock", async () => { // NOSONAR
    let state = {
        _id: "doc1",
        discord: { userId: "user1" },
        oauth: { encryptedRefreshToken: "refresh-v1", expiresAt: 1000, refreshFailCount: 0, version: 1 }
    };
    const stale = structuredClone(state);
    const refreshTokens = [];
    const model = {
        find: () => queryResult([stale]),
        findById: () => ({ lean: async () => structuredClone(state) }),
        async updateOne(filter, update) {
            if (filter["oauth.encryptedRefreshToken"] !== state.oauth.encryptedRefreshToken ||
                filter["oauth.version"] !== state.oauth.version) return { modifiedCount: 0 };
            state = { ...state, oauth: structuredClone(update.$set.oauth), updatedAt: update.$set.updatedAt };
            return { modifiedCount: 1 };
        }
    };
    const options = {
        model,
        tokenField: "oauth",
        redirectUri: "https://example.test/auth/callback",
        now: 5000,
        config: { marginMs: 1000, failMax: 5, scanLimit: 10 },
        discordApi: {
            async refreshToken(token) {
                refreshTokens.push(token);
                return { access_token: "access-v2", refresh_token: "refresh-v2", expires_in: 3600 };
            }
        },
        prepareTokenStorage: token => ({
            encryptedAccessToken: token.access_token,
            encryptedRefreshToken: token.refresh_token,
            expiresAt: 5000 + 3_600_000
        })
    };
    const [left, right] = await Promise.all([
        lifecycle._test.refreshTokenField(options),
        lifecycle._test.refreshTokenField(options)
    ]);
    assert.equal(left.refreshed + right.refreshed, 1);
    assert.equal(left.skipped + right.skipped, 1);
    assert.equal(left.failed + right.failed, 0);
    assert.deepEqual(refreshTokens, ["refresh-v1"]);
});

test("privacy deletion records startSession failure instead of leaving a pending job", async () => { // NOSONAR
    const updates = [];
    const jobModel = {
        async create() {},
        async updateOne(_filter, update) { updates.push(update); return { modifiedCount: 1 }; }
    };
    await assert.rejects(
        privacy.runMemberPrivacyDeletion({
            guildId: "guild-a",
            userId: "111111111111111111",
            requestedBy: "owner",
            models: { PrivacyDeletionJob: jobModel },
            mongooseInstance: { async startSession() { throw new Error("session unavailable"); } }
        }),
        /session unavailable/
    );
    assert.ok(updates.some(update => update.$set?.status === "failed"));
});

test("privacy endSession failure never masks the transaction error", async () => { // NOSONAR
    const jobModel = {
        async create() {},
        async updateOne() { return { modifiedCount: 1 }; }
    };
    await assert.rejects(
        privacy.runMemberPrivacyDeletion({
            guildId: "guild-b",
            userId: "222222222222222222",
            requestedBy: "owner",
            models: { PrivacyDeletionJob: jobModel },
            mongooseInstance: {
                async startSession() {
                    return {
                        async withTransaction() { throw new Error("primary transaction failure"); },
                        async endSession() { throw new Error("secondary close failure"); }
                    };
                }
            }
        }),
        /primary transaction failure/
    );
});
