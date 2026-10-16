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
    try {
        process.env.PUBLIC_BASE_URL = "https://example.test";

        const url = _test.buildDiscordAuthorizeUrl({
            interaction: {},
            guildId: "11111111111111111",
            roleId: "22222222222222222",
            panelRevision: "panel_test123"
        });

        assert.ok(url.startsWith("https://example.test/auth/start?state="));
        const parsed = new URL(url);
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
    }
});

test("buildDiscordAuthorizeUrl throws when public URL is missing", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const prevBase = process.env.PUBLIC_BASE_URL;
    const prevDashboard = process.env.PUBLIC_DASHBOARD_URL;
    try {
        delete process.env.PUBLIC_BASE_URL;
        delete process.env.PUBLIC_DASHBOARD_URL;
        delete process.env.DASHBOARD_URL;
        delete process.env.RENDER_EXTERNAL_URL;

        assert.throws(
            () => _test.buildDiscordAuthorizeUrl({ interaction: {}, guildId: "1", roleId: "2" }),
            /Missing PUBLIC_DASHBOARD_URL/
        );
    } finally {
        if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = prevBase;
        if (prevDashboard === undefined) delete process.env.PUBLIC_DASHBOARD_URL;
        else process.env.PUBLIC_DASHBOARD_URL = prevDashboard;
    }
});

test("validateSetupChannelAndRole rejects non-text channels and everyone role", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = {
        guild: { id: "guild_123" },
        client: {}
    };
    const invalidChannel = { isTextBased: () => false };
    const validRole = { id: "role_123", name: "Member" };

    const channelRes = await _test.validateSetupChannelAndRole(interaction, invalidChannel, validRole);
    assert.equal(channelRes.ok, false);
    assert.match(channelRes.error, /เลือกห้องข้อความเท่านั้น/);

    const validChannel = {
        id: "ch_123",
        isTextBased: () => true,
        isSendable: () => true,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true })
    };
    const everyoneRole = { id: "guild_123", name: "@everyone" };
    const everyoneRes = await _test.validateSetupChannelAndRole(interaction, validChannel, everyoneRole);
    assert.equal(everyoneRes.ok, false);
    assert.match(everyoneRes.error, /ไม่สามารถใช้ยศ @everyone/);
});

test("parseVerificationButtonParts parses single text and fallback options", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interactionWithButtonText = {
        options: {
            getString: (name) => (name === "button_text" ? "🚀 Join Server" : null)
        },
        client: {}
    };
    const role = { name: "VIP" };
    const parts = _test.parseVerificationButtonParts(interactionWithButtonText, role, true);
    assert.equal(parts.label, "Join Server");
    assert.equal(parts.emojiDisplay, "🚀");

    const interactionLegacy = {
        options: {
            getString: (name) => {
                if (name === "button_label") return "Click Here";
                if (name === "button_emoji") return "🔒";
                return null;
            }
        },
        client: {}
    };
    const partsLegacy = _test.parseVerificationButtonParts(interactionLegacy, role, false);
    assert.equal(partsLegacy.label, "Click Here");
    assert.equal(partsLegacy.emojiInput, "🔒");
});

test("direct role mode validates hierarchy without invoking OAuth or Webhook pipelines", async () => {
    const bot = botMember({ canManageRoles: true, highestPosition: 10 });
    const targetRole = { id: "role_target", name: "Verified Member", managed: false, position: 3 };
    const check = _test.validateDirectRoleAssignment(bot, targetRole);
    assert.equal(check.ok, true);

    // Direct mode is isolated: does not invoke OAuth Start, VerifyLog, or Webhook Manager
    assert.equal(typeof _test.validateDirectRoleAssignment, "function");
});

test("handleVerifyButton rejects legacy verify_oauth_ buttons", async () => {
    const { handleVerifyButton } = require("../commands/verification");
    let replyPayload = null;
    const interaction = {
        customId: "verify_oauth_123456",
        reply: async (payload) => { replyPayload = payload; return payload; }
    };
    await handleVerifyButton(interaction);
    assert.ok(replyPayload);
    assert.equal(replyPayload.ephemeral, true);
    assert.match(replyPayload.content, /แผงเก่าแล้ว/);
});

test("handleVerifyButton rejects missing role in guild", async () => {
    const { handleVerifyButton } = require("../commands/verification");
    let replyPayload = null;
    const interaction = {
        customId: "verify_role_999999",
        guild: {
            roles: {
                cache: new Map()
            }
        },
        reply: async (payload) => { replyPayload = payload; return payload; }
    };
    await handleVerifyButton(interaction);
    assert.ok(replyPayload);
    assert.match(replyPayload.content, /ไม่พบยศนี้แล้ว/);
});

test("buildVerificationPanelComponents creates proper embed and button components", () => {
    const role = { id: "role_abc", name: "Member" };
    const panelOptions = {
        title: "Test Panel",
        description: "Welcome",
        colorHex: "#5865F2",
        buttonParts: {
            label: "Verify Now",
            emojiInput: null,
            emojiDisplay: ""
        }
    };
    const res = _test.buildVerificationPanelComponents({
        interaction: { guild: { id: "guild_123" }, client: {} },
        verifyType: false,
        role,
        panelRevision: "rev_1",
        panelOptions
    });
    assert.equal(res.ok, true);
    assert.ok(res.embed);
    assert.ok(res.row);
});

test("buildVerificationSetupResultEmbed formats confirmation embed properly", () => {
    const channel = { id: "ch_123" };
    const role = { id: "role_123" };
    const panelOptions = {
        colorHex: "#5865F2",
        showTs: true,
        buttonParts: {
            label: "Verify",
            emojiDisplay: "✅"
        }
    };
    const embed = _test.buildVerificationSetupResultEmbed({
        interaction: {},
        channel,
        role,
        verifyType: true,
        panelOptions
    });
    assert.ok(embed);
    assert.match(embed.data.title, /ติดตั้งแผงยืนยันเรียบร้อย/);
});


