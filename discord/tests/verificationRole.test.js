const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

process.env.ENCRYPTION_KEY ||= "test-key-for-unit-tests-only";
process.env.API_SECRET ||= "test-api-secret";
process.env.VERIFY_STATE_SECRET ||= "test-verify-state-secret";

const { _test } = require("../commands/verification");

function botMember({ canManageRoles = true, highestPosition = 10 } = {}) {
    return {
        permissions: {
            has(permission) {
                return permission === PermissionFlagsBits.ManageRoles && canManageRoles;
            }
        },
        roles: {
            highest: {
                position: highestPosition
            }
        }
    };
}

test("direct-role assignment helper accepts manageable roles", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = _test.validateDirectRoleAssignment(
        botMember({ canManageRoles: true, highestPosition: 10 }),
        { id: "role1", managed: false, position: 5 }
    );

    assert.equal(result.ok, true);
});

test("direct-role assignment helper rejects missing Manage Roles", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = _test.validateDirectRoleAssignment(
        botMember({ canManageRoles: false, highestPosition: 10 }),
        { id: "role1", managed: false, position: 5 }
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /Manage Roles/);
});

test("direct-role assignment helper rejects managed and higher roles", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const managed = _test.validateDirectRoleAssignment(
        botMember({ highestPosition: 10 }),
        { id: "role1", managed: true, position: 5 }
    );
    const tooHigh = _test.validateDirectRoleAssignment(
        botMember({ highestPosition: 10 }),
        { id: "role2", managed: false, position: 10 }
    );

    assert.equal(managed.ok, false);
    assert.match(managed.reason, /managed/);
    assert.equal(tooHigh.ok, false);
    assert.match(tooHigh.reason, /role hierarchy|ยศบอท/);
});

test("verification panel accepts HTTPS URLs only and enforces text limits", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(_test.cleanHttpsUrl("https://example.com/image.png", "image"), "https://example.com/image.png");
    assert.throws(() => _test.cleanHttpsUrl("http://example.com", "image"), /PANEL_URL_INVALID/);
    assert.doesNotThrow(() => _test.validatePanelText("x".repeat(256), "title", 256));
    assert.throws(() => _test.validatePanelText("x".repeat(257), "title", 256), /PANEL_INPUT_TOO_LONG/);
});

test("direct role config is bound to the latest guild message and role", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = { message: { id: "222222222222222222" } };
    const guildConfig = { verification: {
        enabled: true,
        roleId: "333333333333333333",
        messageId: "222222222222222222",
        verifyType: "direct",
        panelRevision: "panel-test"
    } };
    assert.equal(_test.isCurrentDirectConfig(guildConfig, interaction, "333333333333333333"), true);
    assert.equal(_test.isCurrentDirectConfig(guildConfig, { message: { id: "444444444444444444" } }, "333333333333333333"), false);
});

test("verification persistence retries bounded transient failures", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let attempts = 0;
    const result = await _test.retryPersistence(async () => {
        attempts++;
        if (attempts < 3) return false;
        return { ok: true };
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
});

test("verification Mongo identifiers require strict string snowflakes", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(_test.strictSnowflake("12345678901234567"), "12345678901234567");
    assert.equal(_test.strictSnowflake("1234567890123456789012"), "1234567890123456789012");
    assert.equal(_test.strictSnowflake({ $ne: null }), null);
    assert.equal(_test.strictSnowflake("1234"), null);
});

test("verification replacement disables the previous persisted panel", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let edited = false;
    const message = { edit: async payload => { edited = payload.components.length === 0; } };
    const channel = { messages: { fetch: async () => message } };
    const interaction = {
        guild: {
            channels: {
                cache: new Map([["12345678901234567", channel]]),
                fetch: async () => channel
            }
        }
    };
    const previous = { verification: {
        channelId: "12345678901234567",
        messageId: "22345678901234567"
    } };
    assert.equal(await _test.disablePreviousVerificationPanel(interaction, previous, "32345678901234567"), true);
    assert.equal(edited, true);
});

test("verification setup failure explains each recovery state without nested formatting logic", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.match(_test.verificationSetupFailureMessage({ recoveryRequired: false }), /ปิดแผงที่บันทึกไม่ครบแล้ว/);
    assert.match(
        _test.verificationSetupFailureMessage({ recoveryRequired: true, recoveryPersisted: true }),
        /Owner Dashboard/
    );
    assert.match(
        _test.verificationSetupFailureMessage({ recoveryRequired: true, recoveryPersisted: false }),
        /ตรวจสอบด้วยตนเอง/
    );
});

test("buildDiscordAuthorizeUrl builds direct Discord authorize URL with compact state", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const prevBase = process.env.PUBLIC_BASE_URL;
    const prevClient = process.env.DISCORD_CLIENT_ID;
    try {
        process.env.PUBLIC_BASE_URL = "https://example.test";
        process.env.DISCORD_CLIENT_ID = "12345678901234567";

        const url = _test.buildDiscordAuthorizeUrl({
            interaction: {},
            guildId: "11111111111111111",
            roleId: "22222222222222222",
            panelRevision: "panel_test123"
        });

        assert.ok(url.startsWith("https://discord.com/oauth2/authorize?"));
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("client_id"), "12345678901234567");
        assert.equal(parsed.searchParams.get("redirect_uri"), "https://example.test/auth/callback");
        assert.equal(parsed.searchParams.get("response_type"), "code");
        assert.equal(parsed.searchParams.get("prompt"), "consent");
        const stateParam = parsed.searchParams.get("state");
        const { decodeCallbackState } = require("../verification/utils/state");
        const decoded = decodeCallbackState(stateParam);
        assert.ok(decoded);
        assert.equal(decoded.guildId, "11111111111111111");
        assert.equal(decoded.roleId, "22222222222222222");
        assert.equal(decoded.panelRevision, "panel_test123");
    } finally {
        if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = prevBase;
        if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = prevClient;
    }
});

test("buildDiscordAuthorizeUrl throws when public URL or client ID is missing", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const prevBase = process.env.PUBLIC_BASE_URL;
    const prevDashboard = process.env.PUBLIC_DASHBOARD_URL;
    const prevClient = process.env.DISCORD_CLIENT_ID;
    try {
        delete process.env.PUBLIC_BASE_URL;
        delete process.env.PUBLIC_DASHBOARD_URL;
        delete process.env.DASHBOARD_URL;
        delete process.env.RENDER_EXTERNAL_URL;
        delete process.env.DISCORD_CLIENT_ID;

        assert.throws(
            () => _test.buildDiscordAuthorizeUrl({ interaction: {}, guildId: "1", roleId: "2" }),
            /Missing PUBLIC_DASHBOARD_URL/
        );

        process.env.PUBLIC_BASE_URL = "https://example.test";
        assert.throws(
            () => _test.buildDiscordAuthorizeUrl({ interaction: {}, guildId: "1", roleId: "2" }),
            /Missing DISCORD_CLIENT_ID/
        );
    } finally {
        if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = prevBase;
        if (prevDashboard === undefined) delete process.env.PUBLIC_DASHBOARD_URL;
        else process.env.PUBLIC_DASHBOARD_URL = prevDashboard;
        if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = prevClient;
    }
});
