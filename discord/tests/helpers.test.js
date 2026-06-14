const assert = require("node:assert/strict");
const test = require("node:test");

const {
    IDS,
    PREFIXES,
    isVerifyButton,
    isStatusPage,
    getStatusPage,
    isStatusStop,
    getStatusStopSessionId
} = require("../commands/customIds");
const {
    buildVoiceStatusControls
} = require("../commands/panelViews");
const {
    getSessionAccountLabel,
    getSessionTokenSafe,
    serializeVoiceSession,
    toEpochMs
} = require("../index/sessionSerializer");
const {
    createViewHelpers,
    escapeHtml
} = require("../index/viewHelpers");
const { BASE_CSS } = require("../index/viewStyles");
const views = require("../index/views");
const {
    decodeTokenOwnerIdSafe
} = require("../sessions/tokenUtils");

test("decodeTokenOwnerIdSafe extracts a canonical Discord user ID", () => {
    const userId = "123456789012345678";
    const encodedUserId = Buffer.from(userId)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    const encodedInvalidUser = Buffer.from("not-a-user")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    const token = `${encodedUserId}.abcdef.${"a".repeat(32)}`;

    assert.equal(decodeTokenOwnerIdSafe(token), userId);
    assert.equal(decodeTokenOwnerIdSafe(null), null);
    assert.equal(decodeTokenOwnerIdSafe("not-a-token"), null);
    assert.equal(decodeTokenOwnerIdSafe(`${encodedInvalidUser}.x.y`), null);
});

test("custom ID helpers preserve the routing parser contract", () => {
    assert.equal(isVerifyButton(`${PREFIXES.VERIFY_ROLE}abc`), true);
    assert.equal(isVerifyButton(`${PREFIXES.VERIFY_OAUTH}abc`), true);
    assert.equal(isVerifyButton(IDS.BTN_START), false);

    assert.equal(isStatusPage(`${PREFIXES.STATUS_PAGE}-1`), true);
    assert.equal(getStatusPage(`${PREFIXES.STATUS_PAGE}-1`), -1);
    assert.equal(getStatusPage(`${PREFIXES.STATUS_PAGE}2`), 2);

    assert.equal(isStatusStop(`${PREFIXES.STATUS_STOP}vc_123`), true);
    assert.equal(getStatusStopSessionId(`${PREFIXES.STATUS_STOP}vc_123`), "vc_123");
});

test("buildVoiceStatusControls uses shared custom ID prefixes", () => {
    const row = buildVoiceStatusControls({ sessionId: "vc_session_1" }, 3);
    const customIds = row.components.map(component => component.customId);

    assert.deepEqual(customIds, [
        `${PREFIXES.STATUS_PAGE}2`,
        `${PREFIXES.STATUS_STOP}vc_session_1`,
        `${PREFIXES.STATUS_PAGE}4`
    ]);
});

test("serializeVoiceSession redacts tokens and serializes timestamps as epoch milliseconds", () => {
    const startedAt = new Date("2026-06-12T01:02:03.000Z");
    const lastActivity = "2026-06-12T01:03:04.000Z";
    const session = {
        sessionId: "vc_1234567890abcdef",
        serverId: "111",
        voiceId: "222",
        ownerId: "333",
        accountUsername: "voice-user",
        token: "raw-token",
        encryptedToken: "encrypted-token",
        tokenHash: "token-hash",
        startedAt,
        lastActivity,
        connection: { state: { status: "ready" } },
        client: { isReady: () => true }
    };

    const serialized = serializeVoiceSession(session);

    assert.equal(serialized.startedAt, startedAt.getTime());
    assert.equal(serialized.lastActivity, Date.parse(lastActivity));
    assert.equal(serialized.accountLabel, "voice-user");
    assert.equal(serialized.connectionStatus, "ready");
    assert.equal(serialized.clientReady, true);
    assert.equal(Object.hasOwn(serialized, "token"), false);
    assert.equal(Object.hasOwn(serialized, "encryptedToken"), false);
    assert.equal(Object.hasOwn(serialized, "tokenHash"), false);
});

test("session serializer helpers handle labels, timestamps, and token fallback", () => {
    assert.equal(getSessionAccountLabel({ accountGlobalName: "Display", accountUsername: "user" }), "Display (@user)");
    assert.equal(getSessionAccountLabel({ accountTag: "user#0001" }), "user#0001");
    assert.equal(toEpochMs(new Date("2026-06-12T00:00:00.000Z")), Date.parse("2026-06-12T00:00:00.000Z"));
    assert.equal(toEpochMs("bad-date"), null);

    assert.equal(getSessionTokenSafe({
        getSessionToken: () => null,
        getToken: () => "fallback-token"
    }, "vc_1"), "fallback-token");

    assert.equal(getSessionTokenSafe({
        getSessionToken: () => "primary-token",
        getToken: () => "fallback-token"
    }, "vc_1"), "primary-token");
});

test("view helpers escape HTML and create a consistent shell", () => {
    assert.equal(escapeHtml(`<tag attr="x">&'`), "&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;");

    const helpers = createViewHelpers("body{color:red;}");
    const html = helpers.shell("Title", helpers.navBar("/status") + helpers.toastScript());

    assert.match(html, /<style>body\{color:red;\}<\/style>/);
    assert.match(html, /href="\/status" class="active"/);
    assert.match(html, /function showToast/);
});

test("view styles remain available through the split style module and views compatibility export", () => {
    assert.equal(typeof BASE_CSS, "string");
    assert.match(BASE_CSS, /:root/);
    assert.match(BASE_CSS, /@media\(max-width:700px\)/);
    assert.match(BASE_CSS, /\.session-actions/);
    assert.match(BASE_CSS, /\.table-scroll/);
    assert.match(BASE_CSS, /\.detail-grid/);
    assert.equal(views.BASE_CSS, BASE_CSS);
});
