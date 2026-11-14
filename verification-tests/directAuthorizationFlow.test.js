"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

process.env.VERIFY_STATE_SECRET = "direct-flow-test-secret-1234567890";
process.env.ENCRYPTION_KEY = "test-encryption-key-must-be-32-bytes-long!";
process.env.INTERNAL_API_SECRET = "direct-flow-test-api-secret-123456";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-flow-test-"));
const testDbPath = path.join(tempDir, "direct-flow.sqlite");
process.env.SQLITE_DB_PATH = testDbPath;
process.env.ALLOW_IN_SOURCE_STORAGE = "true";

const { openDatabase, closeDatabase } = require("../database/sqlite/connection");
const { runMigrations } = require("../database/sqlite/migrations/migrationRunner");
const db = openDatabase({ path: testDbPath });
runMigrations(db, { migrationsDir: path.resolve(__dirname, "../database/sqlite/migrations") });

test.after(() => {
    closeDatabase();
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
});

const verificationCommand = require("../discord/commands/verification");
const { _test: cmdTest } = verificationCommand;
const stateUtils = require("../discord/verification/utils/state");
const oauthRoute = require("../discord/verification/routes/oauth");
const { validateCallbackStateNonce } = oauthRoute._test;
const verificationOrchestrator = require("../discord/verification/services/verificationOrchestrator");
const GuildConfig = require("../discord/verification/models/GuildConfig");
const discordAPI = require("../discord/verification/utils/discordAPI");

function mockResponse() {
    return {
        statusCode: 200,
        sentJson: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.sentJson = data;
            return this;
        }
    };
}

test("Direct Authorization URL: button contains valid direct Discord OAuth2 URL meeting all platform constraints", () => {
    const prevBase = process.env.PUBLIC_BASE_URL;
    const prevClient = process.env.DISCORD_CLIENT_ID;
    try {
        process.env.PUBLIC_BASE_URL = "https://verified.example.com";
        process.env.DISCORD_CLIENT_ID = "123456789012345678";

        const guildId = "111222333444555666";
        const roleId = "777888999000111222";
        const panelRevision = "panel_rev_alpha99";

        // 1. Direct authorization URL generation
        const directUrl = cmdTest.buildDiscordAuthorizeUrl({
            interaction: null,
            guildId,
            roleId,
            panelRevision
        });

        // 2. Validate platform and host
        assert.ok(directUrl.startsWith("https://discord.com/oauth2/authorize?"));
        assert.ok(!directUrl.startsWith("https://verified.example.com"));
        assert.ok(!directUrl.includes("/auth/start"));

        // 3. Length strictly <= 512 for Discord Link Buttons
        assert.ok(directUrl.length <= 512, `URL length (${directUrl.length}) must be <= 512`);

        // 4. Exact query parameter contracts
        const parsed = new URL(directUrl);
        assert.equal(parsed.origin, "https://discord.com");
        assert.equal(parsed.pathname, "/oauth2/authorize");
        assert.equal(parsed.searchParams.get("client_id"), "123456789012345678");
        assert.equal(parsed.searchParams.get("response_type"), "code");
        assert.equal(parsed.searchParams.get("redirect_uri"), "https://verified.example.com/auth/callback");
        assert.equal(parsed.searchParams.get("scope"), "identify email connections guilds guilds.members.read guilds.join");
        assert.equal(parsed.searchParams.get("prompt"), "consent");

        // 5. State parameter is valid v5 direct panel state
        const stateParam = parsed.searchParams.get("state");
        assert.ok(stateParam);
        const decoded = stateUtils.decodeCallbackState(stateParam);
        assert.ok(decoded);
        assert.equal(decoded.v, 5);
        assert.equal(decoded.stateType, "panel");
        assert.equal(decoded.guildId, guildId);
        assert.equal(decoded.roleId, roleId);
        assert.equal(decoded.panelRevision, panelRevision);
        assert.equal(decoded.mode, "direct-panel-oauth");

        // 6. Build panel components: verify button style and URL
        const panelOptions = {
            title: "Verification Panel",
            description: "Click below to verify",
            colorHex: "#5865F2",
            buttonParts: {
                label: "Verify With Discord",
                emojiInput: null,
                emojiDisplay: ""
            }
        };

        const comp = cmdTest.buildVerificationPanelComponents({
            interaction: { guild: { id: guildId }, client: {} },
            verifyType: true,
            role: { id: roleId },
            panelRevision,
            panelOptions
        });

        assert.equal(comp.ok, true);
        const button = comp.row.components[0];
        assert.equal(button.data.style, 5); // Link button
        assert.ok(button.data.url.startsWith("https://discord.com/oauth2/authorize?"));
        const btnParsed = new URL(button.data.url);
        const btnState = stateUtils.decodeCallbackState(btnParsed.searchParams.get("state"));
        assert.ok(btnState);
        assert.equal(btnState.guildId, guildId);
        assert.equal(btnState.roleId, roleId);
        assert.equal(btnState.panelRevision, panelRevision);
        assert.equal(button.data.label, "Verify With Discord");
    } finally {
        if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = prevBase;
        if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = prevClient;
    }
});

test("Direct Panel State Integrity: cryptographically rejects all tampering and expired states", () => {
    const guildId = "111222333444555666";
    const roleId = "777888999000111222";
    const panelRevision = "panel_secure_rev1";

    const validState = stateUtils.createDirectPanelState({
        guildId,
        roleId,
        panelRevision
    });

    // 1. Valid state passes
    const decoded = stateUtils.decodeCallbackState(validState);
    assert.ok(decoded);
    assert.equal(decoded.guildId, guildId);
    assert.equal(decoded.roleId, roleId);
    assert.equal(decoded.panelRevision, panelRevision);

    // 2. Tampered signature fails
    assert.equal(stateUtils.decodeCallbackState(validState + "corrupt"), null);

    // 3. Altered guildId fails
    const parts1 = validState.split(".");
    parts1[1] = "999999999999999999";
    assert.equal(stateUtils.decodeCallbackState(parts1.join(".")), null);

    // 4. Altered roleId fails
    const parts2 = validState.split(".");
    parts2[2] = "999999999999999999";
    assert.equal(stateUtils.decodeCallbackState(parts2.join(".")), null);

    // 5. Altered panelRevision fails
    const parts3 = validState.split(".");
    parts3[4] = "panel_forged_rev";
    assert.equal(stateUtils.decodeCallbackState(parts3.join(".")), null);

    // 6. Expired panel state fails
    const expiredState = stateUtils.createDirectPanelState({
        guildId,
        roleId,
        panelRevision,
        expiresAt: Date.now() - 1000
    });
    assert.equal(stateUtils.decodeCallbackState(expiredState), null);

    // 7. Different secret fails
    const oldSecret = process.env.VERIFY_STATE_SECRET;
    try {
        process.env.VERIFY_STATE_SECRET = "completely-different-secret";
        assert.equal(stateUtils.decodeCallbackState(validState), null);
    } finally {
        process.env.VERIFY_STATE_SECRET = oldSecret;
    }
});

test("Multi-user concurrency: multiple members can verify via the same static panel link without nonce exhaustion", async () => {
    const guildId = "111222333444555666";
    const roleId = "777888999000111222";
    const panelRevision = "panel_concurrent_test";

    const sharedPanelState = stateUtils.createDirectPanelState({
        guildId,
        roleId,
        panelRevision
    });

    // Simulate 5 users clicking the same static button
    for (let i = 1; i <= 5; i++) {
        const res = mockResponse();
        const outcome = await validateCallbackStateNonce({
            code: `oauth_code_user_${i}`,
            state: sharedPanelState
        }, res, `req_concurrent_${i}`);

        assert.equal(outcome.ok, true, `User ${i} must succeed on shared static panel link`);
        assert.equal(outcome.code, `oauth_code_user_${i}`);
        assert.equal(outcome.stateObj.v, 5);
        assert.equal(outcome.stateObj.stateType, "panel");
        assert.equal(outcome.stateObj.guildId, guildId);
    }
});

test("Precondition security: rejects outdated panel revision, disabled verification, and role mismatch", async () => {
    const guildId = "111222333444555666";
    const roleId = "777888999000111222";

    // Mock GuildConfig findOne
    const originalFindOne = GuildConfig.findOne;

    try {
        // Case 1: Panel revision mismatch
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => Promise.resolve({
                    guildId,
                    verification: {
                        enabled: true,
                        roleId,
                        panelRevision: "latest_panel_rev_2"
                    }
                })
            })
        });

        const oldStateObj = {
            v: 5,
            stateType: "panel",
            guildId,
            roleId,
            panelRevision: "old_panel_rev_1"
        };

        const outcome1 = await verificationOrchestrator.executeVerification({
            req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            code: "test_code_1",
            stateObj: oldStateObj,
            redirectUri: "https://example.com/auth/callback"
        });

        assert.equal(outcome1.body.success, false);
        assert.equal(outcome1.body.code, "panel_revision_mismatch");

        // Case 2: Verification disabled
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => Promise.resolve({
                    guildId,
                    verification: {
                        enabled: false,
                        roleId,
                        panelRevision: "latest_panel_rev_2"
                    }
                })
            })
        });

        const outcome2 = await verificationOrchestrator.executeVerification({
            req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            code: "test_code_2",
            stateObj: { v: 5, stateType: "panel", guildId, roleId, panelRevision: "latest_panel_rev_2" },
            redirectUri: "https://example.com/auth/callback"
        });

        assert.equal(outcome2.body.success, false);
        assert.equal(outcome2.body.code, "verification_disabled");

        // Case 3: Role mismatch (state has different role than guildConfig)
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => Promise.resolve({
                    guildId,
                    verification: {
                        enabled: true,
                        roleId: "999999999999999999", // newly configured role
                        panelRevision: "latest_panel_rev_2"
                    }
                })
            })
        });

        const outcome3 = await verificationOrchestrator.executeVerification({
            req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            code: "test_code_3",
            stateObj: { v: 5, stateType: "panel", guildId, roleId: "111111111111111111", panelRevision: "latest_panel_rev_2" },
            redirectUri: "https://example.com/auth/callback"
        });

        assert.equal(outcome3.body.success, false);
        assert.equal(outcome3.body.code, "role_mismatch");
    } finally {
        GuildConfig.findOne = originalFindOne;
    }
});

test("Direct role button (verify_type: false) retains isolated direct-role behavior", () => {
    const role = { id: "role_direct_123", name: "Direct Member" };
    const panelOptions = {
        title: "Direct Verify",
        description: "Click to get role immediately",
        colorHex: "#5865F2",
        buttonParts: {
            label: "Get Role",
            emojiInput: null,
            emojiDisplay: ""
        }
    };

    const comp = cmdTest.buildVerificationPanelComponents({
        interaction: { guild: { id: "guild_1" }, client: {} },
        verifyType: false,
        role,
        panelRevision: "panel_direct",
        panelOptions
    });

    assert.equal(comp.ok, true);
    const button = comp.row.components[0];
    assert.equal(button.data.style, 3); // SUCCESS
    assert.equal(button.data.custom_id, "verify_role_role_direct_123");
    assert.equal(button.data.url, undefined);
});

test("Scenario A & D: End-to-end execution of v5 direct panel state and code replay prevention", async () => {
    const guildId = "111222333444555666";
    const roleId = "777888999000111222";
    const panelRevision = "panel_e2e_rev";

    const v5State = stateUtils.createDirectPanelState({
        guildId,
        roleId,
        panelRevision
    });

    const decodedState = stateUtils.decodeCallbackState(v5State);
    assert.ok(decodedState);

    // Mock GuildConfig
    const originalFindOne = GuildConfig.findOne;
    const discordDataCollector = require("../discord/verification/services/collectors/discordDataCollector");
    const originalCollect = discordDataCollector.collectDiscordData;
    const originalGetMemberResult = discordAPI.getGuildMemberResult;
    const originalAddRole = discordAPI.addRoleToMember;

    const oauthTokenManager = require("../discord/tokens/oauthTokenManager");
    const originalCommit = oauthTokenManager.commitVerificationActivation;
    const OAuthUser = require("../discord/verification/models/OAuthUser");
    const originalOAuthFindOne = OAuthUser.findOne;
    const VerifyLog = require("../discord/verification/models/VerifyLog");
    const originalVerifyLogCreate = VerifyLog.create;
    const IpIdentityLink = require("../discord/verification/models/IpIdentityLink");
    const originalIpFind = IpIdentityLink.find;

    try {
        const chainableQuery = {};
        const chainable = () => chainableQuery;
        chainableQuery.select = chainable;
        chainableQuery.sort = chainable;
        chainableQuery.limit = chainable;
        chainableQuery.where = chainable;
        chainableQuery.equals = chainable;
        chainableQuery.lean = () => Promise.resolve([]);
        IpIdentityLink.find = chainable;
        OAuthUser.findOne = () => ({
            select: () => ({
                lean: () => Promise.resolve(null)
            })
        });
        oauthTokenManager.commitVerificationActivation = async () => ({
            ok: true,
            activated: { _id: "mock_activated_oauth_user" }
        });
        VerifyLog.create = async (doc) => ({
            _id: "mock_verify_log_id_123",
            result: "success",
            ...doc,
            isBudgetDegraded: false
        });

        const mockConfig = {
            guildId,
            verification: {
                enabled: true,
                roleId,
                roleName: "Verified Member",
                panelRevision
            }
        };
        GuildConfig.findOne = () => ({
            where: () => ({
                equals: () => {
                    const p = Promise.resolve(mockConfig);
                    p.lean = () => Promise.resolve(mockConfig);
                    return p;
                }
            })
        });

        // 1. First execution: Success
        discordDataCollector.collectDiscordData = async () => ({
            tokenData: { access_token: "mock_access_token", refresh_token: "mock_refresh_token", expires_in: 604800 },
            accessToken: "mock_access_token",
            profile: {
                id: "555666777888999000",
                username: "testuser",
                discriminator: "0",
                globalName: "Test User",
                email: "test@example.com",
                emailVerified: true,
                accountAgeDays: 100,
                accountCreatedAt: Date.now() - 100 * 24 * 60 * 60 * 1000
            },
            connections: [],
            guildSummary: { status: "success" },
            fetchMetadata: {}
        });

        discordAPI.getGuildMemberResult = async () => ({
            member: { user: { id: "555666777888999000" } },
            status: 200
        });

        let roleAssigned = false;
        discordAPI.addRoleToMember = async (gId, uId, rId) => {
            if (gId === guildId && uId === "555666777888999000" && rId === roleId) {
                roleAssigned = true;
                return { ok: true };
            }
            return { ok: false };
        };

        const successOutcome = await verificationOrchestrator.executeVerification({
            req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            code: "fresh_single_use_code_123",
            stateObj: decodedState,
            redirectUri: "https://example.com/auth/callback"
        });

        assert.equal(successOutcome.body.success, true, "Verification must succeed");
        assert.equal(roleAssigned, true, "Target role must be assigned to member");
        assert.equal(successOutcome.body.user.id, "555666777888999000");

        // 2. Second execution with replayed code: Discord rejects with invalid grant
        const grantError = new Error("invalid_grant: code already used");
        grantError.status = 400;
        grantError.providerCode = "invalid_grant";
        grantError.response = { data: { error: "invalid_grant" } };

        discordDataCollector.collectDiscordData = async () => {
            throw grantError;
        };

        const replayedOutcome = await verificationOrchestrator.executeVerification({
            req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            code: "fresh_single_use_code_123", // replayed code
            stateObj: decodedState,
            redirectUri: "https://example.com/auth/callback"
        });

        assert.equal(replayedOutcome.body.success, false, "Replayed code must fail");
        assert.equal(replayedOutcome.body.code, "oauth_code_expired", "Code must be marked expired/used");
    } finally {
        GuildConfig.findOne = originalFindOne;
        discordDataCollector.collectDiscordData = originalCollect;
        discordAPI.getGuildMemberResult = originalGetMemberResult;
        discordAPI.addRoleToMember = originalAddRole;
        OAuthUser.findOne = originalOAuthFindOne;
        oauthTokenManager.commitVerificationActivation = originalCommit;
        VerifyLog.create = originalVerifyLogCreate;
        IpIdentityLink.find = originalIpFind;
    }
});

test("Scenario E: Coexistence of legacy v4 state and modern v5 direct panel state", async () => {
    const { registerVerificationState } = require("../discord/verification/services/verificationStateNonce");

    const guildId = "111222333444555666";
    const roleId = "777888999000111222";

    // 1. Legacy v4 state with registered single-use nonce
    const v4State = stateUtils.createCompactCallbackState({
        guildId,
        roleId,
        expectedUserId: null,
        panelRevision: "legacy_rev"
    });

    const decodedV4 = stateUtils.decodeCallbackState(v4State);
    assert.equal(decodedV4.v, 4);
    assert.equal(decodedV4.stateType, "execution");
    assert.ok(decodedV4.nonce);

    await registerVerificationState(decodedV4);

    // First consumption of v4 state succeeds
    const resV4_1 = mockResponse();
    const rV4_1 = await validateCallbackStateNonce({ code: "code_v4_1", state: v4State }, resV4_1, "req_v4_1");
    assert.equal(rV4_1.ok, true);

    // Replay of v4 state fails with callback_state_replayed
    const resV4_2 = mockResponse();
    const rV4_2 = await validateCallbackStateNonce({ code: "code_v4_2", state: v4State }, resV4_2, "req_v4_2");
    assert.equal(rV4_2.ok, false);
    assert.equal(resV4_2.sentJson.code, "callback_state_replayed");

    // 2. Modern v5 state can be used repeatedly without single-use DB nonce starvation
    const v5State = stateUtils.createDirectPanelState({
        guildId,
        roleId,
        panelRevision: "modern_rev"
    });

    const resV5_1 = mockResponse();
    const rV5_1 = await validateCallbackStateNonce({ code: "code_v5_1", state: v5State }, resV5_1, "req_v5_1");
    assert.equal(rV5_1.ok, true);
    assert.equal(rV5_1.stateObj.v, 5);
    assert.equal(rV5_1.stateObj.stateType, "panel");

    const resV5_2 = mockResponse();
    const rV5_2 = await validateCallbackStateNonce({ code: "code_v5_2", state: v5State }, resV5_2, "req_v5_2");
    assert.equal(rV5_2.ok, true);
    assert.equal(rV5_2.stateObj.v, 5);
    assert.equal(rV5_2.stateObj.stateType, "panel");
});
