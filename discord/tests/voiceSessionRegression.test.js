/**
 * voiceSessionRegression.test.js
 *
 * Regression tests สำหรับ voice/session flow:
 * 1. Discord ID 17–22 หลักผ่าน validation ทั้ง worker และ panel helper
 * 2. Owner Mode กับ Guild Admin Mode แยกสิทธิ์ถูกต้อง
 * 3. Guild Admin เริ่ม session ข้าม guild ไม่ได้
 * 4. Owner/global control เห็นทุก session ได้
 * 5. ensureVoiceSession() ต้องไม่พึ่ง main bot guild fetch
 *
 * Design: self-contained — ไม่ import module ที่ต้องการ Discord/DB runtime
 * Pure functions ถูก inline ตรงจาก source (contract copy) และ
 * source-code tests ใช้ fs.readFileSync เพื่อ assert โครงสร้างโค้ดโดยตรง
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// ─────────────────────────────────────────────────────────────────────────────
// REAL MODULE IMPORTS — ดึงจาก source จริง ไม่ inline
// ─────────────────────────────────────────────────────────────────────────────

// Source: discord/commands/panelHelpers.js (pure, no Discord/DB runtime deps)
const { normalizeDiscordId, PANEL_FIELD_ID_REGEX: PANEL_ID_REGEX } = require("../commands/panelHelpers");

// Source: discord/commands/panelInteractions.js :: _test exports
const panelInteractionsTest = require("../commands/panelInteractions")._test;
const isOwnerGlobalControl = panelInteractionsTest.isOwnerGlobalControl;
const getVisibleVoiceSessions = panelInteractionsTest.getVisibleVoiceSessions;
const canControlSession = panelInteractionsTest.canControlSession;

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT COPIES — เฉพาะฟังก์ชันที่ยังต้อง inline เพราะพึ่ง Discord/DB runtime
// (source-code contract tests ใน section 9 จะตรวจว่า source ไม่ drift)
// ─────────────────────────────────────────────────────────────────────────────

// Source: discord/voiceWorker/display.js :: normalizeVoiceTarget
function normalizeVoiceTarget(input = {}) {
    const guildId = String(input.guildId || input.serverId || "").trim();
    const channelId = String(input.channelId || input.voiceId || "").trim();
    if (!/^\d{17,22}$/.test(guildId)) throw new Error("INVALID_GUILD_ID");
    if (!/^\d{17,22}$/.test(channelId)) throw new Error("INVALID_VOICE_CHANNEL_ID");
    return { guildId, channelId };
}

// Source: discord/commands/panelInteractions.js :: ensureStartAllowed (guild cross-check only)
function ensureStartAllowed_crossGuildCheck(interaction, serverId, shadowMasterId, ownerId = null) {
    // Reuse imported isOwnerGlobalControl
    if (isOwnerGlobalControl(interaction, shadowMasterId)) return null;
    if (serverId !== interaction.guild?.id) {
        return "cross_guild_blocked";
    }
    return "same_guild_proceed";
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function makeInteraction({ userId = "user1", guildId = "guild-A", ownerId = null } = {}) {
    return { user: { id: userId }, guild: { id: guildId }, _ownerId: ownerId };
}

const SESSIONS = [
    { sessionId: "s1", serverId: "guild-A", ownerId: "admin-A" },
    { sessionId: "s2", serverId: "guild-B", ownerId: "admin-B" },
    { sessionId: "s3", serverId: "guild-A", ownerId: "other-A" },
    { sessionId: "legacy", serverId: "guild-A", ownerId: null }
];

// ════════════════════════════════════════════════════════════════════════════
//  1. WORKER: normalizeVoiceTarget (display.js) — รับ 17–22 หลัก
// ════════════════════════════════════════════════════════════════════════════
test("worker normalizeVoiceTarget: accepts 17-digit ID (minimum)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const r = normalizeVoiceTarget({ guildId: "12345678901234567", channelId: "98765432109876543" });
    assert.equal(r.guildId, "12345678901234567");
    assert.equal(r.channelId, "98765432109876543");
});

test("worker normalizeVoiceTarget: accepts 19-digit ID (common snowflake)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const r = normalizeVoiceTarget({ guildId: "1234567890123456789", channelId: "9876543210987654321" });
    assert.equal(r.guildId, "1234567890123456789");
});

test("worker normalizeVoiceTarget: accepts 22-digit ID (upper boundary)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const r = normalizeVoiceTarget({ guildId: "1234567890123456789012", channelId: "9876543210987654321098" });
    assert.equal(r.guildId, "1234567890123456789012");
});

test("worker normalizeVoiceTarget: rejects 16-digit ID (too short)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "1234567890123456", channelId: "1234567890123456789" }),
        /INVALID_GUILD_ID/
    );
});

test("worker normalizeVoiceTarget: rejects 23-digit ID (too long)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "12345678901234567890123", channelId: "1234567890123456789" }),
        /INVALID_GUILD_ID/
    );
});

test("worker normalizeVoiceTarget: rejects non-numeric guildId", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "abc12345678901234", channelId: "1234567890123456789" }),
        /INVALID_GUILD_ID/
    );
});

test("worker normalizeVoiceTarget: rejects invalid channelId", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "1234567890123456789", channelId: "short" }),
        /INVALID_VOICE_CHANNEL_ID/
    );
});

test("worker normalizeVoiceTarget: accepts serverId/voiceId aliases", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const r = normalizeVoiceTarget({ serverId: "12345678901234567", voiceId: "98765432109876543" });
    assert.equal(r.guildId, "12345678901234567");
    assert.equal(r.channelId, "98765432109876543");
});

// ════════════════════════════════════════════════════════════════════════════
//  2. PANEL: normalizeDiscordId helper — รับ 17–22 หลัก
// ════════════════════════════════════════════════════════════════════════════
test("panel normalizeDiscordId: accepts 17-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(normalizeDiscordId("12345678901234567"), "12345678901234567");
});

test("panel normalizeDiscordId: accepts 22-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(normalizeDiscordId("1234567890123456789012"), "1234567890123456789012");
});

test("panel normalizeDiscordId: rejects 16-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(normalizeDiscordId("1234567890123456"), null);
});

test("panel normalizeDiscordId: rejects 23-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(normalizeDiscordId("12345678901234567890123"), null);
});

test("panel normalizeDiscordId: rejects letters", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(normalizeDiscordId("abc1234567890123456"), null);
});

// ════════════════════════════════════════════════════════════════════════════
//  3. PANEL: validateStartFields regex สำหรับ serverId/voiceId
//     (ตรงกับ worker: 17-22)
// ════════════════════════════════════════════════════════════════════════════
test("panel validateStartFields regex: accepts 17-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.ok(PANEL_ID_REGEX.test("12345678901234567"), "17-digit should pass panel validation");
});

test("panel validateStartFields regex: accepts 19-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.ok(PANEL_ID_REGEX.test("1234567890123456789"), "19-digit should pass panel validation");
});

test("panel validateStartFields regex: rejects 16-digit ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.ok(!PANEL_ID_REGEX.test("1234567890123456"), "16-digit should fail panel validation");
});

test("panel validateStartFields regex: rejects non-numeric ID", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.ok(!PANEL_ID_REGEX.test("abc1234567890123"), "non-numeric should fail panel validation");
});

test("panel validateStartFields regex: accepts 20 and 22-digit IDs", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.ok(PANEL_ID_REGEX.test("12345678901234567890"));
    assert.ok(PANEL_ID_REGEX.test("1234567890123456789012"));
});

// ════════════════════════════════════════════════════════════════════════════
//  4. OWNER MODE vs GUILD ADMIN MODE — isOwnerGlobalControl
// ════════════════════════════════════════════════════════════════════════════
test("isOwnerGlobalControl: shadowMaster has global control", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "shadow-1" });
    assert.equal(isOwnerGlobalControl(interaction, "shadow-1"), true);
});

test("isOwnerGlobalControl: regular guild admin does NOT have global control", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "guild-admin-1" });
    assert.equal(isOwnerGlobalControl(interaction, "shadow-999"), false);
});

test("isOwnerGlobalControl: null shadowMasterId does not grant control", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "random-user" });
    // (null && ...) evaluates to null in JS — falsy but not strict false
    assert.ok(!isOwnerGlobalControl(interaction, null),
        "non-owner with null shadowMasterId must not have global control");
});

// ════════════════════════════════════════════════════════════════════════════
//  5. OWNER SEES ALL SESSIONS — getVisibleVoiceSessions
// ════════════════════════════════════════════════════════════════════════════
test("getVisibleVoiceSessions: owner (shadowMaster) sees ALL sessions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "shadow-1", guildId: "guild-A" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-1");
    assert.equal(visible.length, 4);
});

test("getVisibleVoiceSessions: a guild admin sees only sessions they created", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999");
    assert.equal(visible.length, 1);
    assert.equal(visible[0].sessionId, "s1");
});

test("getVisibleVoiceSessions: another member sees only their own sessions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-B", guildId: "guild-B" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999");
    assert.equal(visible.length, 1);
    assert.equal(visible[0].serverId, "guild-B");
});

test("getVisibleVoiceSessions: admin with no matching guild sees zero sessions", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-C", guildId: "guild-C" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999");
    assert.equal(visible.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
//  6. canControlSession — owner vs guild admin
// ════════════════════════════════════════════════════════════════════════════
test("canControlSession: owner can control session in any guild", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "shadow-1", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-B" }, "shadow-1"), true);
});

test("canControlSession: a user can control their own session", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-A", ownerId: "admin-A" }, "shadow-999"), true);
});

test("canControlSession: a user cannot control another user's session", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-A", ownerId: "other-A" }, "shadow-999"), false);
});

test("legacy ownerless sessions are hidden from non-owners", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-A", ownerId: null }, "shadow-999"), false);
    assert.equal(getVisibleVoiceSessions(interaction, () => [SESSIONS[3]], "shadow-999").length, 0);
});

test("canControlSession: returns false for null session", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, null, "shadow-999"), false);
});


// ════════════════════════════════════════════════════════════════════════════
//  7. ensureStartAllowed — guild admin cross-guild block
// ════════════════════════════════════════════════════════════════════════════
test("ensureStartAllowed: owner can start session in any guild", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "shadow-1", guildId: "guild-A" });
    const result = ensureStartAllowed_crossGuildCheck(interaction, "guild-B", "shadow-1");
    assert.equal(result, null);
});

test("ensureStartAllowed: guild admin blocked from starting session in another guild", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    const result = ensureStartAllowed_crossGuildCheck(interaction, "guild-B", "shadow-999");
    assert.equal(result, "cross_guild_blocked");
});

test("ensureStartAllowed: guild admin in same guild proceeds to next check", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    const result = ensureStartAllowed_crossGuildCheck(interaction, "guild-A", "shadow-999");
    assert.equal(result, "same_guild_proceed");
});

// ════════════════════════════════════════════════════════════════════════════
//  8. REGRESSION: ensureVoiceSession ต้องไม่พึ่ง mainClient.guilds
// ════════════════════════════════════════════════════════════════════════════
function readLifecycleSrc() {
    return fs.readFileSync(path.join(__dirname, "../voiceWorker/lifecycle.js"), "utf8"); // nosemgrep
}

function extractFunctionBody(src, fnName) {
    const start = src.indexOf(`async function ${fnName}`);
    if (start === -1) return null;
    const afterStart = src.indexOf("\nasync function", start + 10);
    return afterStart === -1 ? src.slice(start) : src.slice(start, afterStart);
}

test("regression: ensureVoiceSession does not reference mainClient.guilds", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "ensureVoiceSession");
    assert.ok(body, "ensureVoiceSession must exist in lifecycle.js");
    assert.ok(
        !body.includes("mainClient.guilds") && !body.includes("mainClient?.guilds"),
        "ensureVoiceSession must NOT call mainClient.guilds — violates separation from main bot"
    );
});

test("regression: voice lifecycle does not bind token ownership to requester IDs", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = readLifecycleSrc();
    assert.equal(src.includes("TOKEN_OWNER_MISMATCH"), false);
    assert.equal(src.includes("token_in_use_by_another_user"), false);
    assert.equal(src.includes("assertRequestedTokenOwner"), false);
    assert.match(src, /replaceExistingVoiceSession/);
    assert.match(src, /superseded_by_newer_request/);
});

test("regression: ensureVoiceSession does not call resolveVoiceTarget", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "ensureVoiceSession");
    assert.ok(body, "ensureVoiceSession must exist in lifecycle.js");
    assert.ok(
        !body.includes("resolveVoiceTarget"),
        "ensureVoiceSession must NOT call resolveVoiceTarget (which fetches via mainClient)"
    );
});

test("regression: connectToVoice resolves guild via self-client param, not mainClient", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "connectToVoice");
    assert.ok(body, "connectToVoice must exist in lifecycle.js");
    assert.ok(
        body.includes("client.guilds"),
        "connectToVoice must resolve guild via self-client parameter"
    );
    assert.ok(
        !body.includes("mainClient.guilds") && !body.includes("st.mainClient.guilds"),
        "connectToVoice must NOT use mainClient.guilds"
    );
});

test("regression: healthCheck uses st.isShuttingDown (not bare variable)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "healthCheck");
    assert.ok(body, "healthCheck must exist in lifecycle.js");
    assert.ok(
        body.includes("st.isShuttingDown"),
        "healthCheck must use st.isShuttingDown for shared mutable state"
    );
});

test("regression: pauseAll sets st.isShuttingDown (not bare variable)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "pauseAll");
    assert.ok(body, "pauseAll must exist in lifecycle.js");
    assert.ok(
        body.includes("st.isShuttingDown = true"),
        "pauseAll must set st.isShuttingDown = true to propagate to all modules"
    );
});

// ════════════════════════════════════════════════════════════════════════════
//  9. SOURCE CONTRACT: worker and panel both accept 17-22
// ════════════════════════════════════════════════════════════════════════════
test("source contract: worker normalizeVoiceTarget regex is 17,22", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = fs.readFileSync(path.join(__dirname, "../voiceWorker/display.js"), "utf8"); // nosemgrep
    assert.ok(
        src.includes("/^\\d{17,22}$/.test(guildId)"),
        "display.js normalizeVoiceTarget must use 17-22 regex for guildId"
    );
    assert.ok(
        src.includes("/^\\d{17,22}$/.test(channelId)"),
        "display.js normalizeVoiceTarget must use 17-22 regex for channelId"
    );
});

test("source contract: panel validateStartFields uses the shared 17-22 regex", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const panelSrc = fs.readFileSync(path.join(__dirname, "../commands/panelInteractions.js"), "utf8"); // nosemgrep
    const helperSrc = fs.readFileSync(path.join(__dirname, "../commands/panelHelpers.js"), "utf8"); // nosemgrep
    // ตรวจว่า validateStartFields ใช้ PANEL_FIELD_ID_REGEX (ไม่ inline regex เอง)
    const validateBlock = panelSrc.slice(
        panelSrc.indexOf("function validateStartFields"),
        panelSrc.indexOf("\n}", panelSrc.indexOf("function validateStartFields")) + 2
    );
    assert.ok(
        validateBlock.includes("PANEL_FIELD_ID_REGEX"),
        "validateStartFields must delegate to PANEL_FIELD_ID_REGEX from panelHelpers"
    );
    // ตรวจว่า panel helper ใช้ source เดียวกับ normalizeDiscordId
    assert.ok(
        helperSrc.includes("const PANEL_FIELD_ID_REGEX = DISCORD_ID_REGEX"),
        "panel field validation must share the 17-22 Discord ID regex"
    );
});

test("source contract: panel normalizeDiscordId uses 17-22 regex (consistent with worker)", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const src = fs.readFileSync(path.join(__dirname, "../commands/panelHelpers.js"), "utf8"); // nosemgrep
    assert.ok(
        src.includes("/^\\d{17,22}$/.test(id)") || src.includes("\\d{17,22}"),
        "normalizeDiscordId in panelHelpers must use 17-22 regex matching worker"
    );
});

test("voice webhooks ignore individual connection outcomes and alert only on persistence failure", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const source = require("node:fs").readFileSync("discord/voiceWorker/lifecycle.js", "utf8");
    assert.doesNotMatch(source, /code:\s*"voice\.session\.reconnect_unstable"/);
    assert.doesNotMatch(source, /code:\s*"voice\.session\.recovered"/);
    assert.doesNotMatch(source, /code:\s*"voice\.session\.dead"/);
    assert.match(source, /code:\s*"voice\.session\.failure_state_persistence_failed"/);
    assert.match(source, /category:\s*"DATA"/);
});
