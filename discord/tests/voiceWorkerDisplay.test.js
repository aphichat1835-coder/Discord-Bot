const assert = require("node:assert/strict");
const test = require("node:test");

const {
    safeAvatarURL,
    safeGuildIconURL,
    getAccountLabel,
    getGuildLabel,
    getVoiceLabel,
    getUptimeString,
    getConnectionStatusText,
    isVoiceConnectionUsable,
    normalizeVoiceTarget,
    buildVoiceFields
} = require("../voiceWorker/display");

const { VoiceConnectionStatus } = require("@discordjs/voice");

test("safeAvatarURL: returns null for falsy input", () => {
    assert.equal(safeAvatarURL(null), null);
    assert.equal(safeAvatarURL(undefined), null);
});

test("safeAvatarURL: calls displayAvatarURL when available", () => {
    const user = { displayAvatarURL: () => "https://example.com/avatar.png" };
    assert.equal(safeAvatarURL(user), "https://example.com/avatar.png");
});

test("safeAvatarURL: falls back to avatarURL when displayAvatarURL absent", () => {
    const user = { avatarURL: () => "https://example.com/avatar2.png" };
    assert.equal(safeAvatarURL(user), "https://example.com/avatar2.png");
});

test("safeAvatarURL: returns null when method throws", () => {
    const user = { displayAvatarURL: () => { throw new Error("no avatar"); } };
    assert.equal(safeAvatarURL(user), null);
});

test("safeGuildIconURL: returns null for falsy input", () => {
    assert.equal(safeGuildIconURL(null), null);
    assert.equal(safeGuildIconURL(undefined), null);
});

test("safeGuildIconURL: calls iconURL when available", () => {
    const guild = { iconURL: () => "https://example.com/icon.png" };
    assert.equal(safeGuildIconURL(guild), "https://example.com/icon.png");
});

test("safeGuildIconURL: returns null when iconURL throws", () => {
    const guild = { iconURL: () => { throw new Error("no icon"); } };
    assert.equal(safeGuildIconURL(guild), null);
});

test("getAccountLabel: prefers globalName + username format", () => {
    const session = { accountGlobalName: "TestUser", accountUsername: "testuser" };
    assert.equal(getAccountLabel(session), "TestUser (@testuser)");
});

test("getAccountLabel: uses globalName alone when username absent", () => {
    const session = { accountGlobalName: "TestUser" };
    assert.equal(getAccountLabel(session), "TestUser");
});

test("getAccountLabel: falls back to accountTag", () => {
    const session = { accountTag: "testuser#0000" };
    assert.equal(getAccountLabel(session), "testuser#0000");
});

test("getAccountLabel: falls back to accountId", () => {
    const session = { accountId: "123456789012345678" };
    assert.equal(getAccountLabel(session), "123456789012345678");
});

test("getAccountLabel: returns default when session is empty", () => {
    assert.equal(getAccountLabel({}), "ไม่ทราบบัญชี");
    assert.equal(getAccountLabel(null), "ไม่ทราบบัญชี");
});

test("getGuildLabel: returns serverName when available", () => {
    assert.equal(getGuildLabel({ serverName: "My Server" }), "My Server");
});

test("getGuildLabel: falls back to serverId", () => {
    assert.equal(getGuildLabel({ serverId: "111222333" }), "111222333");
});

test("getGuildLabel: returns default for empty session", () => {
    assert.equal(getGuildLabel({}), "ไม่ทราบเซิร์ฟเวอร์");
});

test("getVoiceLabel: returns voiceName when available", () => {
    assert.equal(getVoiceLabel({ voiceName: "General" }), "General");
});

test("getVoiceLabel: formats voiceId as channel mention", () => {
    assert.equal(getVoiceLabel({ voiceId: "999888777" }), "<#999888777>");
});

test("getVoiceLabel: returns default when no voice info", () => {
    assert.equal(getVoiceLabel({}), "ไม่ทราบช่องเสียง");
});

test("getUptimeString: returns unknown for missing startedAt", () => {
    assert.equal(getUptimeString({}), "ไม่ทราบ");
    assert.equal(getUptimeString(null), "ไม่ทราบ");
});

test("getUptimeString: shows minutes for short uptime", () => {
    const session = { startedAt: Date.now() - 5 * 60 * 1000 };
    const result = getUptimeString(session);
    assert.ok(result.includes("นาที"), `expected นาที in: ${result}`);
    assert.ok(!result.includes("ชั่วโมง"), `should not include hours: ${result}`);
});

test("getUptimeString: shows hours and minutes for medium uptime", () => {
    const session = { startedAt: Date.now() - 2 * 60 * 60 * 1000 };
    const result = getUptimeString(session);
    assert.ok(result.includes("ชั่วโมง"), `expected ชั่วโมง in: ${result}`);
    assert.ok(!result.includes("วัน"), `should not include days: ${result}`);
});

test("getUptimeString: shows days for long uptime", () => {
    const session = { startedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 };
    const result = getUptimeString(session);
    assert.ok(result.includes("วัน"), `expected วัน in: ${result}`);
});

test("getConnectionStatusText: returns green for Ready", () => {
    const session = { connection: { state: { status: VoiceConnectionStatus.Ready } } };
    assert.ok(getConnectionStatusText(session).includes("🟢"));
});

test("getConnectionStatusText: returns red for Destroyed", () => {
    const session = { connection: { state: { status: VoiceConnectionStatus.Destroyed } } };
    assert.ok(getConnectionStatusText(session).includes("🔴"));
});

test("getConnectionStatusText: returns yellow for Connecting", () => {
    const session = { connection: { state: { status: VoiceConnectionStatus.Connecting } } };
    assert.ok(getConnectionStatusText(session).includes("🟡"));
});

test("getConnectionStatusText: returns orange for Disconnected", () => {
    const session = { connection: { state: { status: VoiceConnectionStatus.Disconnected } } };
    assert.ok(getConnectionStatusText(session).includes("🟠"));
});

test("getConnectionStatusText: handles missing connection gracefully", () => {
    const result = getConnectionStatusText({});
    assert.equal(typeof result, "string");
    assert.ok(result.includes("⚪"));
});

test("isVoiceConnectionUsable: false when no connection", () => {
    assert.ok(!isVoiceConnectionUsable(null));
    assert.ok(!isVoiceConnectionUsable(undefined));
});

test("isVoiceConnectionUsable: false when connection is not Ready", () => {
    const conn = { state: { status: VoiceConnectionStatus.Connecting } };
    assert.ok(!isVoiceConnectionUsable(conn));
});

test("isVoiceConnectionUsable: true when Ready and no channelId filter", () => {
    const conn = { state: { status: VoiceConnectionStatus.Ready } };
    assert.ok(isVoiceConnectionUsable(conn));
});

test("isVoiceConnectionUsable: true when Ready and channelId matches", () => {
    const conn = {
        state: { status: VoiceConnectionStatus.Ready },
        joinConfig: { channelId: "777" }
    };
    assert.ok(isVoiceConnectionUsable(conn, "777"));
});

test("isVoiceConnectionUsable: false when Ready but channelId does not match", () => {
    const conn = {
        state: { status: VoiceConnectionStatus.Ready },
        joinConfig: { channelId: "777" }
    };
    assert.ok(!isVoiceConnectionUsable(conn, "888"));
});

test("normalizeVoiceTarget: parses guildId and channelId correctly", () => {
    const result = normalizeVoiceTarget({ guildId: "123456789012345678", channelId: "987654321098765432" });
    assert.equal(result.guildId, "123456789012345678");
    assert.equal(result.channelId, "987654321098765432");
});

test("normalizeVoiceTarget: accepts serverId and voiceId aliases", () => {
    const result = normalizeVoiceTarget({ serverId: "123456789012345678", voiceId: "987654321098765432" });
    assert.equal(result.guildId, "123456789012345678");
    assert.equal(result.channelId, "987654321098765432");
});

test("normalizeVoiceTarget: throws INVALID_GUILD_ID for bad guildId", () => {
    assert.throws(() => normalizeVoiceTarget({ guildId: "abc", channelId: "987654321098765432" }), { message: "INVALID_GUILD_ID" });
    assert.throws(() => normalizeVoiceTarget({ guildId: "", channelId: "987654321098765432" }), { message: "INVALID_GUILD_ID" });
});

test("normalizeVoiceTarget: throws INVALID_VOICE_CHANNEL_ID for bad channelId", () => {
    assert.throws(() => normalizeVoiceTarget({ guildId: "123456789012345678", channelId: "bad" }), { message: "INVALID_VOICE_CHANNEL_ID" });
});

test("buildVoiceFields: returns array of embed field objects", () => {
    const session = {
        accountGlobalName: "User",
        accountUsername: "user",
        accountId: "111222333444555666",
        serverName: "Test Server",
        voiceName: "General",
        startedAt: Date.now() - 60000,
        reconnectCount: 0,
        sessionId: "sess-abc-12345678",
        connection: { state: { status: VoiceConnectionStatus.Ready } }
    };
    const fields = buildVoiceFields(session);
    assert.ok(Array.isArray(fields));
    assert.ok(fields.length >= 6);
    for (const f of fields) {
        assert.equal(typeof f.name, "string");
        assert.equal(typeof f.value, "string");
    }
});

test("buildVoiceFields: includes reconnect field when reconnectCount > 0", () => {
    const session = {
        accountId: "111222333444555666",
        serverId: "111222333444555666",
        voiceId: "111222333444555666",
        startedAt: Date.now(),
        reconnectCount: 3,
        sessionId: "sess-abc-12345678"
    };
    const fields = buildVoiceFields(session);
    const reconnectField = fields.find(f => f.name.includes("Reconnect"));
    assert.ok(reconnectField);
    assert.ok(reconnectField.value.includes("3"));
});

test("buildVoiceFields: includes extra reason and action when provided", () => {
    const session = {
        accountId: "111222333444555666",
        serverId: "111222333444555666",
        voiceId: "111222333444555666",
        startedAt: Date.now(),
        reconnectCount: 0,
        sessionId: "sess-abc-12345678"
    };
    const fields = buildVoiceFields(session, { reason: "Timeout", action: "Retry" });
    assert.ok(fields.some(f => f.value === "Timeout"));
    assert.ok(fields.some(f => f.value === "Retry"));
});
