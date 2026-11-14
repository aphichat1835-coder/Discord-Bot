"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.VERIFY_STATE_SECRET = "test-state-secret-direct-url-123456789";

const {
    VERIFY_SCOPE,
    MAX_DISCORD_BUTTON_URL_LENGTH,
    buildDirectDiscordAuthorizeUrl
} = require("../discord/verification/utils/directAuthorizeUrl");
const { decodeCallbackState } = require("../discord/verification/utils/state");
const { _test: commandTest } = require("../discord/commands/verification");
const guildRoute = require("../discord/verification/routes/guild");
const { _test: guildTest } = guildRoute;

test("buildDirectDiscordAuthorizeUrl: validation, query parameters, trailing slash handling, and length constraints", () => {
    // 1. Missing clientId
    assert.throws(
        () => buildDirectDiscordAuthorizeUrl({ clientId: "", baseUrl: "https://example.com", guildId: "1", roleId: "2" }),
        /Missing DISCORD_CLIENT_ID/
    );

    // 2. Missing baseUrl
    assert.throws(
        () => buildDirectDiscordAuthorizeUrl({ clientId: "123", baseUrl: "", guildId: "1", roleId: "2" }),
        /Missing PUBLIC_DASHBOARD_URL/
    );

    // 3. Trailing slash normalization without regex backtracking
    const urlWithSlash = buildDirectDiscordAuthorizeUrl({
        clientId: "123456789012345678",
        baseUrl: "https://verified.example.com///",
        guildId: "111222333444555666",
        roleId: "777888999000111222",
        panelRevision: "rev_test"
    });
    const parsedWithSlash = new URL(urlWithSlash);
    assert.equal(parsedWithSlash.searchParams.get("redirect_uri"), "https://verified.example.com/auth/callback");

    // 4. Exceeding max length (512)
    assert.throws(
        () => buildDirectDiscordAuthorizeUrl({
            clientId: "123456789012345678",
            baseUrl: "https://" + "a".repeat(450) + ".com",
            guildId: "111222333444555666",
            roleId: "777888999000111222",
            panelRevision: "rev_test"
        }),
        /Direct OAuth URL too long/
    );
});

test("Equivalence: command and guild route callers produce identical URL structure and state semantics", () => {
    const prevBase = process.env.PUBLIC_BASE_URL;
    const prevClient = process.env.DISCORD_CLIENT_ID;

    try {
        const testBaseUrl = "https://app.verified.org";
        const testClientId = "999888777666555444";
        const testGuildId = "111222333444555666";
        const testRoleId = "777888999000111222";
        const testPanelRevision = "panel_unified_rev_42";

        process.env.PUBLIC_BASE_URL = testBaseUrl;
        process.env.DISCORD_CLIENT_ID = testClientId;

        // Caller 1: Discord slash command builder
        const commandUrl = commandTest.buildDiscordAuthorizeUrl({
            interaction: null,
            clientId: testClientId,
            baseUrl: testBaseUrl,
            guildId: testGuildId,
            roleId: testRoleId,
            panelRevision: testPanelRevision
        });

        // Caller 2: Web Dashboard guild route builder
        const guildRouteUrl = guildTest.buildDiscordAuthorizeUrl({}, {
            clientId: testClientId,
            guildId: testGuildId,
            roleId: testRoleId,
            panelRevision: testPanelRevision
        });

        // Parse both URLs
        const parsedCommand = new URL(commandUrl);
        const parsedGuild = new URL(guildRouteUrl);

        // Assert platform host and path equivalence
        assert.equal(parsedCommand.origin, "https://discord.com");
        assert.equal(parsedGuild.origin, "https://discord.com");
        assert.equal(parsedCommand.pathname, "/oauth2/authorize");
        assert.equal(parsedGuild.pathname, "/oauth2/authorize");

        // Assert query parameter equivalence
        assert.equal(parsedCommand.searchParams.get("client_id"), parsedGuild.searchParams.get("client_id"));
        assert.equal(parsedCommand.searchParams.get("client_id"), testClientId);

        assert.equal(parsedCommand.searchParams.get("response_type"), parsedGuild.searchParams.get("response_type"));
        assert.equal(parsedCommand.searchParams.get("response_type"), "code");

        assert.equal(parsedCommand.searchParams.get("redirect_uri"), parsedGuild.searchParams.get("redirect_uri"));
        assert.equal(parsedCommand.searchParams.get("redirect_uri"), `${testBaseUrl}/auth/callback`);

        assert.equal(parsedCommand.searchParams.get("scope"), parsedGuild.searchParams.get("scope"));
        assert.equal(parsedCommand.searchParams.get("scope"), VERIFY_SCOPE);

        assert.equal(parsedCommand.searchParams.get("prompt"), parsedGuild.searchParams.get("prompt"));
        assert.equal(parsedCommand.searchParams.get("prompt"), "consent");

        // Assert length safety for both callers
        assert.ok(commandUrl.length <= MAX_DISCORD_BUTTON_URL_LENGTH, `Command URL must be <= 512 (was ${commandUrl.length})`);
        assert.ok(guildRouteUrl.length <= MAX_DISCORD_BUTTON_URL_LENGTH, `Guild route URL must be <= 512 (was ${guildRouteUrl.length})`);

        // Assert state semantic equivalence (random salts will differ, but decoded payload must match exactly)
        const commandState = decodeCallbackState(parsedCommand.searchParams.get("state"));
        const guildState = decodeCallbackState(parsedGuild.searchParams.get("state"));

        assert.ok(commandState, "Command state must decode successfully");
        assert.ok(guildState, "Guild route state must decode successfully");

        assert.equal(commandState.v, 5);
        assert.equal(guildState.v, 5);
        assert.equal(commandState.stateType, "panel");
        assert.equal(guildState.stateType, "panel");
        assert.equal(commandState.guildId, testGuildId);
        assert.equal(guildState.guildId, testGuildId);
        assert.equal(commandState.roleId, testRoleId);
        assert.equal(guildState.roleId, testRoleId);
        assert.equal(commandState.panelRevision, testPanelRevision);
        assert.equal(guildState.panelRevision, testPanelRevision);
        assert.equal(commandState.mode, "direct-panel-oauth");
        assert.equal(guildState.mode, "direct-panel-oauth");
    } finally {
        if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = prevBase;
        if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = prevClient;
    }
});

test("Boundary-specific resolution: command and guild route respect boundary-specific fallbacks", () => {
    const prevBase = process.env.PUBLIC_BASE_URL;
    const prevClient = process.env.DISCORD_CLIENT_ID;

    try {
        process.env.PUBLIC_BASE_URL = "https://default.env.org";
        process.env.DISCORD_CLIENT_ID = "111111111111111111";

        // Command builder with interaction client ID when env is not set
        delete process.env.DISCORD_CLIENT_ID;
        const fakeInteraction = {
            client: { user: { id: "222222222222222222" } }
        };
        const cmdUrl = commandTest.buildDiscordAuthorizeUrl({
            interaction: fakeInteraction,
            guildId: "g1",
            roleId: "r1"
        });
        const parsedCmd = new URL(cmdUrl);
        assert.equal(parsedCmd.searchParams.get("client_id"), "222222222222222222", "Command must resolve interaction client ID when env is not set");

        // Guild route builder with explicit clientId override
        process.env.DISCORD_CLIENT_ID = "111111111111111111";
        const guildUrl = guildTest.buildDiscordAuthorizeUrl({}, {
            clientId: "333333333333333333",
            guildId: "g1",
            roleId: "r1"
        });
        const parsedGuild = new URL(guildUrl);
        assert.equal(parsedGuild.searchParams.get("client_id"), "333333333333333333", "Guild route must resolve explicit clientId override");
    } finally {
        if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = prevBase;
        if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = prevClient;
    }
});
