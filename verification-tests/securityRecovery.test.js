const assert = require("node:assert/strict");
const test = require("node:test");

const stateNonceModel = require("../discord/verification/models/VerificationStateNonce");
const stateNonce = require("../discord/verification/services/verificationStateNonce");
const {
    evaluateCriticalPersistence,
    coordinatePersistenceFailure
} = require("../discord/verification/services/verificationPersistence");

const ACTOR_ID = "111111111111111111";
const GUILD_ID = "222222222222222222";
const USER_ID = "333333333333333333";
const ROLE_ID = "444444444444444444";

test("verification state nonce registration hashes the nonce and consumption is atomic", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalCreate = stateNonceModel.create;
    const originalFind = stateNonceModel.findOneAndUpdate;
    let created;
    let consumed = false;
    try {
        stateNonceModel.create = async record => {
            created = record;
            return record;
        };
        stateNonceModel.findOneAndUpdate = () => ({
            async lean() {
                if (consumed) return null;
                consumed = true;
                return { status: "consumed" };
            }
        });
        const state = {
            nonce: "single-use-secret",
            guildId: GUILD_ID,
            roleId: ROLE_ID,
            expectedUserId: USER_ID,
            panelRevision: "revision-1",
            ts: Date.now() + 60_000
        };
        assert.equal(await stateNonce.registerVerificationState(state), true);
        assert.notEqual(created.nonceHash, state.nonce);
        assert.equal(created.guildId, GUILD_ID);
        assert.equal(await stateNonce.consumeVerificationState(state), true);
        assert.equal(await stateNonce.consumeVerificationState(state), false);
    } finally {
        stateNonceModel.create = originalCreate;
        stateNonceModel.findOneAndUpdate = originalFind;
    }
});


test("critical verification persistence failure rolls back a newly applied role and records recovery", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const evaluated = evaluateCriticalPersistence({
        oauthSaved: true,
        verifyLogSaved: false,
        trackingRequired: true,
        trackingSaved: true
    });
    assert.equal(evaluated.ok, false);

    const saved = [];
    let rollbackCalls = 0;
    const result = await coordinatePersistenceFailure({
        requestId: "verify-request",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "success",
        roleAssignResult: { ok: true, alreadyHadRole: false },
        persistence: evaluated.persistence,
        removeRole: async () => {
            rollbackCalls++;
            return { ok: true };
        },
        saveRecovery: async recovery => {
            saved.push(recovery);
            return true;
        },
        now: () => 123456
    });

    assert.equal(rollbackCalls, 1);
    assert.equal(result.rollbackSucceeded, true);
    assert.equal(result.manualReviewRequired, false);
    assert.equal(result.response.success, false);
    assert.equal(result.response.code, "verification_persistence_failed");
    assert.equal(saved[0].status, "role_rolled_back");
    assert.equal(saved[0].updatedAt, 123456);
});

test("failed rollback remains fail-closed and requires manual review", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = await coordinatePersistenceFailure({
        requestId: "verify-request-2",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "success",
        roleAssignResult: { ok: true, alreadyHadRole: false },
        persistence: { oauthUser: false, verifyLog: false, ipTracking: false },
        removeRole: async () => ({ ok: false }),
        saveRecovery: async () => true
    });
    assert.equal(result.rollbackSucceeded, false);
    assert.equal(result.manualReviewRequired, true);
    assert.equal(result.response.manualReviewRequired, true);
});

test("verifyLog budget degradation fails critical persistence and triggers rollback recovery rather than silent success", async () => {
    const evaluated = evaluateCriticalPersistence({
        oauthSaved: true,
        verifyLogSaved: true,
        verifyLogDegraded: true,
        trackingRequired: true,
        trackingSaved: true
    });
    assert.equal(evaluated.ok, false, "Degraded verifyLog must NOT be marked as ok");
    assert.equal(evaluated.persistence.verifyLog, false, "verifyLog persistence must be false when degraded");
    assert.equal(evaluated.degraded, true, "degraded flag is preserved");

    const saved = [];
    let rollbackCalls = 0;
    const result = await coordinatePersistenceFailure({
        requestId: "verify-budget-degraded",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "success",
        roleAssignResult: { ok: true, alreadyHadRole: false },
        persistence: evaluated.persistence,
        removeRole: async () => {
            rollbackCalls++;
            return { ok: true };
        },
        saveRecovery: async recovery => {
            saved.push(recovery);
            return true;
        }
    });

    assert.equal(rollbackCalls, 1, "Role is rolled back when verifyLog is degraded");
    assert.equal(result.rollbackSucceeded, true);
    assert.equal(saved[0].status, "role_rolled_back");
});

test("P1-1: coordinatePersistenceFailure rolls back newly applied role even when result is passed as 'failed'", async () => {
    let rollbackCalls = 0;
    const saved = [];
    const result = await coordinatePersistenceFailure({
        requestId: "verify-failed-result-p1-1",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "failed", // Orchestrator passes "failed" because persistence failed
        roleAssignResult: { ok: true, alreadyHadRole: false },
        persistence: { oauthUser: false, verifyLog: false, ipTracking: false },
        removeRole: async () => {
            rollbackCalls++;
            return { ok: true };
        },
        saveRecovery: async recovery => {
            saved.push(recovery);
            return true;
        }
    });

    assert.equal(rollbackCalls, 1, "removeRole must be called even when result is 'failed'");
    assert.equal(result.rollbackSucceeded, true, "rollback must succeed");
    assert.equal(result.manualReviewRequired, false, "no manual review needed after successful rollback");
    assert.equal(saved[0].status, "role_rolled_back", "status must be role_rolled_back");
    assert.equal(result.response.error, "ระบบบันทึกหลักฐานไม่สำเร็จ จึงย้อนยศกลับแล้ว กรุณาลองใหม่");
});

test("coordinatePersistenceFailure preserves existing role when user already had role before", async () => {
    let rollbackCalls = 0;
    const result = await coordinatePersistenceFailure({
        requestId: "verify-already-had-role",
        guildId: GUILD_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        result: "failed",
        roleAssignResult: { ok: true, alreadyHadRole: true },
        persistence: { oauthUser: false, verifyLog: false, ipTracking: false },
        removeRole: async () => {
            rollbackCalls++;
            return { ok: true };
        },
        saveRecovery: async () => true
    });

    assert.equal(rollbackCalls, 0, "removeRole must NOT be called if user already had role");
    assert.equal(result.rollbackAttempted, false);
});

test("P1-1 end-to-end: executeVerification rolls back granted role when persistence fails and records recovery", async () => {
    const { executeVerification } = require("../discord/verification/services/verificationOrchestrator");
    const discordAPI = require("../discord/verification/utils/discordAPI");
    const discordDataCollector = require("../discord/verification/services/collectors/discordDataCollector");
    const GuildConfig = require("../discord/verification/models/GuildConfig");
    const VerifyLog = require("../discord/verification/models/VerifyLog");
    const OAuthUser = require("../discord/verification/models/OAuthUser");
    const IpIdentityLink = require("../discord/verification/models/IpIdentityLink");
    const VerificationRecovery = require("../discord/verification/models/VerificationRecovery");

    // Stored originals
    const origGuildConfigFindOne = GuildConfig.findOne;
    const origCollect = discordDataCollector.collectDiscordData;
    const origGetMember = discordAPI.getGuildMemberResult;
    const origAddRole = discordAPI.addRoleToMember;
    const origRemoveRole = discordAPI.removeRoleFromMember;
    const origVerifyLogCreate = VerifyLog.create;
    const origOAuthUserFindOneAndUpdate = OAuthUser.findOneAndUpdate;
    const origIpLinkFindOne = IpIdentityLink.findOne;
    const origIpLinkFindOneAndUpdate = IpIdentityLink.findOneAndUpdate;
    const origRecoveryCreate = VerificationRecovery.create;

    let rollbackCalls = 0;
    let savedRecoveries = [];

    GuildConfig.findOne = () => ({
        where: () => ({
            equals: () => Promise.resolve({
                guildId: GUILD_ID,
                verification: {
                    enabled: true,
                    roleId: ROLE_ID,
                    roleName: "Verified",
                    panelRevision: 1,
                    securityRules: {}
                }
            })
        })
    });

    discordDataCollector.collectDiscordData = async () => ({
        tokenData: { access_token: "tok_123", refresh_token: "ref_123", scope: "identify" },
        accessToken: "tok_123",
        profile: { id: USER_ID, username: "test_user", discriminator: "0" },
        connections: [],
        guildSummary: { totalCount: 1, ownedCount: 0 },
        fetchMetadata: {}
    });

    // Member is in guild without role -> triggers addRoleToMember
    discordAPI.getGuildMemberResult = async () => ({
        member: { user: { id: USER_ID }, roles: [] },
        status: 200,
        failureReason: null
    });

    discordAPI.addRoleToMember = async () => ({ ok: true });
    discordAPI.removeRoleFromMember = async () => {
        rollbackCalls++;
        return { ok: true };
    };

    // Simulate critical persistence failure: VerifyLog.create throws
    VerifyLog.create = async () => {
        throw new Error("Simulated VerifyLog persistence write failure");
    };
    OAuthUser.findOneAndUpdate = async () => ({});
    IpIdentityLink.findOne = () => ({
        where: () => ({
            equals: () => ({
                lean: () => Promise.resolve(null)
            })
        })
    });
    IpIdentityLink.findOneAndUpdate = async () => ({});
    VerificationRecovery.create = async (rec) => {
        savedRecoveries.push(rec);
        return rec;
    };

    const req = {
        headers: { "user-agent": "test-agent" },
        connection: { remoteAddress: "127.0.0.1" }
    };
    const stateObj = {
        guildId: GUILD_ID,
        roleId: ROLE_ID,
        panelRevision: 1,
        mode: "oauth"
    };

    try {
        const outcome = await executeVerification({
            req,
            code: "test_code_persistence_fail",
            stateObj,
            redirectUri: "https://localhost/callback"
        });

        // 1. Role must be rolled back
        assert.equal(rollbackCalls, 1, "discord.removeRoleFromMember MUST be called when persistence fails");

        // 2. Response must indicate persistence failure
        assert.equal(outcome.body.success, false);
        assert.equal(outcome.body.code, "verification_persistence_failed");

        // 3. Recovery record must be created
        assert.equal(savedRecoveries.length, 1, "Recovery record must be created");
        assert.equal(savedRecoveries[0].status, "role_rolled_back");
        assert.equal(savedRecoveries[0].userId, USER_ID);
        assert.equal(savedRecoveries[0].guildId, GUILD_ID);
    } finally {
        GuildConfig.findOne = origGuildConfigFindOne;
        discordDataCollector.collectDiscordData = origCollect;
        discordAPI.getGuildMemberResult = origGetMember;
        discordAPI.addRoleToMember = origAddRole;
        discordAPI.removeRoleFromMember = origRemoveRole;
        VerifyLog.create = origVerifyLogCreate;
        OAuthUser.findOneAndUpdate = origOAuthUserFindOneAndUpdate;
        IpIdentityLink.findOne = origIpLinkFindOne;
        IpIdentityLink.findOneAndUpdate = origIpLinkFindOneAndUpdate;
        VerificationRecovery.create = origRecoveryCreate;
    }
});

test("Section 3.2: executeVerification 5 membership lookup scenarios ensure only genuine 404 attempts addMemberToGuild", async () => {
    const { executeVerification } = require("../discord/verification/services/verificationOrchestrator");
    const discordAPI = require("../discord/verification/utils/discordAPI");
    const discordDataCollector = require("../discord/verification/services/collectors/discordDataCollector");
    const GuildConfig = require("../discord/verification/models/GuildConfig");
    const VerifyLog = require("../discord/verification/models/VerifyLog");
    const OAuthUser = require("../discord/verification/models/OAuthUser");
    const IpIdentityLink = require("../discord/verification/models/IpIdentityLink");

    const origGuildConfigFindOne = GuildConfig.findOne;
    const origCollect = discordDataCollector.collectDiscordData;
    const origGetMember = discordAPI.getGuildMemberResult;
    const origAddRole = discordAPI.addRoleToMember;
    const origAddMember = discordAPI.addMemberToGuild;
    const origVerifyLogCreate = VerifyLog.create;
    const origOAuthUserFindOneAndUpdate = OAuthUser.findOneAndUpdate;
    const origIpLinkFindOne = IpIdentityLink.findOne;
    const origIpLinkfindOneAndUpdate = IpIdentityLink.findOneAndUpdate;

    GuildConfig.findOne = () => ({
        where: () => ({
            equals: () => Promise.resolve({
                guildId: GUILD_ID,
                verification: {
                    enabled: true,
                    roleId: ROLE_ID,
                    roleName: "Verified",
                    panelRevision: 1,
                    securityRules: {}
                }
            })
        })
    });

    const oauthTokenManager = require("../discord/core/oauthTokenManager");
    const origCommit = oauthTokenManager.commitVerificationActivation;
    oauthTokenManager.commitVerificationActivation = async () => ({ activated: true, saved: true });

    discordDataCollector.collectDiscordData = async () => ({
        tokenData: { access_token: "tok_123", refresh_token: "ref_123", scope: "identify" },
        accessToken: "tok_123",
        profile: { id: USER_ID, username: "lookup_test", discriminator: "0" },
        connections: [],
        guildSummary: { totalCount: 1, ownedCount: 0 },
        fetchMetadata: {}
    });

    VerifyLog.create = async (doc) => ({ ...doc, _id: "log_mock_123" });
    OAuthUser.findOneAndUpdate = async () => ({});
    IpIdentityLink.findOne = () => ({
        where: () => ({
            equals: () => ({
                lean: () => Promise.resolve(null)
            })
        })
    });
    IpIdentityLink.findOneAndUpdate = async () => ({});

    const req = { headers: { "user-agent": "agent" }, connection: { remoteAddress: "127.0.0.1" } };
    const stateObj = { guildId: GUILD_ID, roleId: ROLE_ID, panelRevision: 1, mode: "oauth" };

    try {
        // --- Scenario 1: Member found and ALREADY has role ---
        let addRoleCalls = 0;
        let addMemberCalls = 0;
        discordAPI.getGuildMemberResult = async () => ({
            member: { user: { id: USER_ID }, roles: [ROLE_ID] },
            status: 200,
            failureReason: null
        });
        discordAPI.addRoleToMember = async () => { addRoleCalls++; return { ok: true }; };
        discordAPI.addMemberToGuild = async () => { addMemberCalls++; return { ok: true }; };

        const res1 = await executeVerification({ req, code: "c1", stateObj, redirectUri: "uri" });
        assert.equal(res1.body.success, true);
        assert.equal(addRoleCalls, 0, "Must NOT call addRoleToMember if member already had role");
        assert.equal(addMemberCalls, 0, "Must NOT call addMemberToGuild if member already in guild");

        // --- Scenario 2: Member found and DOES NOT have role ---
        addRoleCalls = 0;
        addMemberCalls = 0;
        discordAPI.getGuildMemberResult = async () => ({
            member: { user: { id: USER_ID }, roles: [] },
            status: 200,
            failureReason: null
        });

        const res2 = await executeVerification({ req, code: "c2", stateObj, redirectUri: "uri" });
        assert.equal(res2.body.success, true);
        assert.equal(addRoleCalls, 1, "Must call addRoleToMember when member is in guild without role");
        assert.equal(addMemberCalls, 0, "Must NOT call addMemberToGuild when member is already in guild");

        // --- Scenario 3: Real HTTP 404 (member not in guild) ---
        addRoleCalls = 0;
        addMemberCalls = 0;
        discordAPI.getGuildMemberResult = async () => ({
            member: null,
            status: 404,
            failureReason: null
        });

        const res3 = await executeVerification({ req, code: "c3", stateObj, redirectUri: "uri" });
        assert.equal(res3.body.success, true);
        assert.equal(addMemberCalls, 1, "Must call addMemberToGuild on genuine HTTP 404");
        assert.equal(addRoleCalls, 0, "Must NOT call addRoleToMember on HTTP 404");

        // --- Scenario 4: Discord API timeout / network failure ---
        addRoleCalls = 0;
        addMemberCalls = 0;
        discordAPI.getGuildMemberResult = async () => ({
            member: null,
            status: 503,
            failureReason: "discord_request_timeout"
        });

        const res4 = await executeVerification({ req, code: "c4", stateObj, redirectUri: "uri" });
        assert.equal(res4.body.success, false);
        assert.equal(res4.body.code, "member_lookup_failed");
        assert.equal(addMemberCalls, 0, "Must NOT call addMemberToGuild on API failure/timeout");
        assert.equal(addRoleCalls, 0, "Must NOT call addRoleToMember on API failure");

        // --- Scenario 5: Discord API returns malformed payload (missing roles) ---
        addRoleCalls = 0;
        addMemberCalls = 0;
        discordAPI.getGuildMemberResult = async () => ({
            member: null,
            status: 200,
            failureReason: "discord_invalid_payload"
        });

        const res5 = await executeVerification({ req, code: "c5", stateObj, redirectUri: "uri" });
        assert.equal(res5.body.success, false);
        assert.equal(res5.body.code, "member_lookup_failed");
        assert.equal(addMemberCalls, 0, "Must NOT call addMemberToGuild on malformed payload");
        assert.equal(addRoleCalls, 0, "Must NOT call addRoleToMember on malformed payload");
    } finally {
        GuildConfig.findOne = origGuildConfigFindOne;
        discordDataCollector.collectDiscordData = origCollect;
        discordAPI.getGuildMemberResult = origGetMember;
        discordAPI.addRoleToMember = origAddRole;
        discordAPI.addMemberToGuild = origAddMember;
        VerifyLog.create = origVerifyLogCreate;
        OAuthUser.findOneAndUpdate = origOAuthUserFindOneAndUpdate;
        IpIdentityLink.findOne = origIpLinkFindOne;
        IpIdentityLink.findOneAndUpdate = origIpLinkfindOneAndUpdate;
        oauthTokenManager.commitVerificationActivation = origCommit;
    }
});

test("evaluateSecurity: detects deviceDuplicate and enforces violation when enabled", () => {
    const { evaluateSecurity } = require("../discord/verification/services/securityEvaluator");
    const result = evaluateSecurity({
        profile: { id: "user_a", accountAgeDays: 100, email: "a@test.com", emailVerified: true },
        device: { fingerprintHash: "device_hash_123" },
        deviceSummary: { userIds: ["user_b", "user_c"] }, // 2 other accounts already on device
        securityRules: {
            deviceDuplicate: {
                enabled: true,
                threshold: 1, // max 1 account allowed
                action: "deny_role"
            }
        }
    });

    assert.equal(result.isBlocked, true);
    assert.equal(result.moderationAction, "deny_role");
    assert.ok(result.findings.some(f => f.startsWith("device_duplicate_limit:")));
    assert.ok(result.allViolations.some(v => v.key === "deviceDuplicate"));
});

test("evaluateSecurity: detects deviceDuplicate as finding only when rule is disabled", () => {
    const { evaluateSecurity } = require("../discord/verification/services/securityEvaluator");
    const result = evaluateSecurity({
        profile: { id: "user_a", accountAgeDays: 100, email: "a@test.com", emailVerified: true },
        device: { fingerprintHash: "device_hash_123" },
        deviceSummary: { userIds: ["user_b", "user_c"] }, // 2 other accounts already on device
        securityRules: {
            deviceDuplicate: {
                enabled: false,
                threshold: 1,
                action: "deny_role"
            }
        }
    });

    assert.equal(result.isBlocked, false);
    assert.equal(result.moderationAction, null);
    // Finding is always recorded regardless of rule enabled status
    assert.ok(result.findings.some(f => f.startsWith("device_duplicate_limit:3")));
    assert.equal(result.allViolations.length, 0);
});

test("evaluateSecurity: same user re-verifying does not trigger deviceDuplicate false-positive", () => {
    const { evaluateSecurity } = require("../discord/verification/services/securityEvaluator");
    const result = evaluateSecurity({
        profile: { id: "user_a", accountAgeDays: 100, email: "a@test.com", emailVerified: true },
        device: { fingerprintHash: "device_hash_123" },
        deviceSummary: { userIds: ["user_a"] }, // Only user_a itself exists on device
        securityRules: {
            deviceDuplicate: {
                enabled: true,
                threshold: 1,
                action: "deny_role"
            }
        }
    });

    // Projected unique accounts = 0 others + 1 current = 1 <= threshold 1
    assert.equal(result.isBlocked, false);
    assert.ok(!result.findings.some(f => f.startsWith("device_duplicate_limit:")));
});

test("evaluateSecurity: requireConnections blocks when connections empty and passes when provided", () => {
    const { evaluateSecurity } = require("../discord/verification/services/securityEvaluator");
    // Case 1: Empty connections -> blocked
    const blockedResult = evaluateSecurity({
        profile: { id: "user_a", accountAgeDays: 100, email: "a@test.com", emailVerified: true },
        policySnapshot: { requireConnections: true },
        connections: []
    });
    assert.equal(blockedResult.isBlocked, true);
    assert.equal(blockedResult.moderationAction, "deny_role");
    assert.ok(blockedResult.findings.includes("no_connections"));
    assert.ok(blockedResult.allViolations.some(v => v.key === "requireConnections"));

    // Case 2: Has connections -> allowed
    const passedResult = evaluateSecurity({
        profile: { id: "user_a", accountAgeDays: 100, email: "a@test.com", emailVerified: true },
        policySnapshot: { requireConnections: true },
        connections: [{ type: "youtube", id: "yt_123" }]
    });
    assert.equal(passedResult.isBlocked, false);
    assert.ok(!passedResult.findings.includes("no_connections"));

    // Case 3: requireConnections disabled -> allowed even if empty
    const disabledResult = evaluateSecurity({
        profile: { id: "user_a", accountAgeDays: 100, email: "a@test.com", emailVerified: true },
        policySnapshot: { requireConnections: false },
        connections: []
    });
    assert.equal(disabledResult.isBlocked, false);
    assert.ok(!disabledResult.findings.includes("no_connections"));
});

test("loadExistingDeviceContext: aggregates user IDs matching fingerprintHash and includes current user", async () => {
    const { loadExistingDeviceContext } = require("../discord/verification/services/verificationOrchestrator");
    const IpIdentityLink = require("../discord/verification/models/IpIdentityLink");
    const origFind = IpIdentityLink.find;

    try {
        IpIdentityLink.find = () => ({
            select: () => ({
                sort: () => ({
                    limit: () => ({
                        lean: async () => [
                            {
                                deviceFingerprints: [
                                    { fingerprintHash: "test_dev_hash", userId: "user_alpha" },
                                    { fingerprintHash: "other_dev_hash", userId: "user_beta" } // should not match
                                ],
                                users: [
                                    { userId: "user_gamma", lastDeviceFingerprintHash: "test_dev_hash" }
                                ]
                            }
                        ]
                    })
                })
            })
        });

        const context = await loadExistingDeviceContext({
            device: { fingerprintHash: "test_dev_hash" },
            guildId: GUILD_ID,
            currentUserId: "user_delta"
        });

        assert.equal(context.uniqueUsers, 3);
        assert.ok(context.userIds.includes("user_alpha"));
        assert.ok(context.userIds.includes("user_gamma"));
        assert.ok(context.userIds.includes("user_delta"));
        assert.ok(!context.userIds.includes("user_beta"));
    } finally {
        IpIdentityLink.find = origFind;
    }
});



