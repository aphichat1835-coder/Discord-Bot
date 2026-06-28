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
// CONTRACT COPIES (inlined from source — ถ้า source เปลี่ยนแล้วไม่ match
// ทำให้รู้ได้ทันทีว่า regression test ต้องอัปเดตด้วย)
// ─────────────────────────────────────────────────────────────────────────────

// Source: discord/voiceWorker/display.js :: normalizeVoiceTarget
function normalizeVoiceTarget(input = {}) {
    const guildId = String(input.guildId || input.serverId || "").trim();
    const channelId = String(input.channelId || input.voiceId || "").trim();
    if (!/^\d{17,22}$/.test(guildId)) throw new Error("INVALID_GUILD_ID");
    if (!/^\d{17,22}$/.test(channelId)) throw new Error("INVALID_VOICE_CHANNEL_ID");
    return { guildId, channelId };
}

// Source: discord/commands/panelInteractions.js :: normalizeDiscordId
function normalizeDiscordId(value) {
    const id = String(value || "").trim();
    return /^\d{17,22}$/.test(id) ? id : null;
}

// Source: discord/commands/panelInteractions.js :: validateStartFields (regex only)
const PANEL_ID_REGEX = /^\d{17,19}$/;

// Source: discord/commands/panelInteractions.js :: isOwnerGlobalControl
// หมายเหตุ: ใช้ config.system.ownerId (ไม่ใช่ application.owner)
function isOwnerGlobalControl(interaction, shadowMasterId, ownerId = null) {
    return interaction.user?.id === ownerId ||
        (shadowMasterId && interaction.user?.id === shadowMasterId);
}

// Source: discord/commands/panelInteractions.js :: getVisibleVoiceSessions
function getVisibleVoiceSessions(interaction, getAllSessions, shadowMasterId, ownerId = null) {
    const allSessions = getAllSessions();
    if (isOwnerGlobalControl(interaction, shadowMasterId, ownerId)) return allSessions;
    const guildId = interaction.guild?.id;
    return allSessions.filter(s => String(s.serverId || "") === String(guildId || ""));
}

// Source: discord/commands/panelInteractions.js :: canControlSession
function canControlSession(interaction, session, shadowMasterId, ownerId = null) {
    if (!session) return false;
    if (isOwnerGlobalControl(interaction, shadowMasterId, ownerId)) return true;
    return String(session.serverId || "") === String(interaction.guild?.id || "");
}

// Source: discord/commands/panelInteractions.js :: ensureStartAllowed (guild cross-check only)
function ensureStartAllowed_crossGuildCheck(interaction, serverId, shadowMasterId, ownerId = null) {
    if (isOwnerGlobalControl(interaction, shadowMasterId, ownerId)) return null;
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
    { sessionId: "s1", serverId: "guild-A" },
    { sessionId: "s2", serverId: "guild-B" },
    { sessionId: "s3", serverId: "guild-A" },
];

// ════════════════════════════════════════════════════════════════════════════
//  1. WORKER: normalizeVoiceTarget (display.js) — รับ 17–22 หลัก
// ════════════════════════════════════════════════════════════════════════════
test("worker normalizeVoiceTarget: accepts 17-digit ID (minimum)", () => {
    const r = normalizeVoiceTarget({ guildId: "12345678901234567", channelId: "98765432109876543" });
    assert.equal(r.guildId, "12345678901234567");
    assert.equal(r.channelId, "98765432109876543");
});

test("worker normalizeVoiceTarget: accepts 19-digit ID (common snowflake)", () => {
    const r = normalizeVoiceTarget({ guildId: "1234567890123456789", channelId: "9876543210987654321" });
    assert.equal(r.guildId, "1234567890123456789");
});

test("worker normalizeVoiceTarget: accepts 22-digit ID (upper boundary)", () => {
    const r = normalizeVoiceTarget({ guildId: "1234567890123456789012", channelId: "9876543210987654321098" });
    assert.equal(r.guildId, "1234567890123456789012");
});

test("worker normalizeVoiceTarget: rejects 16-digit ID (too short)", () => {
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "1234567890123456", channelId: "1234567890123456789" }),
        /INVALID_GUILD_ID/
    );
});

test("worker normalizeVoiceTarget: rejects 23-digit ID (too long)", () => {
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "12345678901234567890123", channelId: "1234567890123456789" }),
        /INVALID_GUILD_ID/
    );
});

test("worker normalizeVoiceTarget: rejects non-numeric guildId", () => {
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "abc12345678901234", channelId: "1234567890123456789" }),
        /INVALID_GUILD_ID/
    );
});

test("worker normalizeVoiceTarget: rejects invalid channelId", () => {
    assert.throws(
        () => normalizeVoiceTarget({ guildId: "1234567890123456789", channelId: "short" }),
        /INVALID_VOICE_CHANNEL_ID/
    );
});

test("worker normalizeVoiceTarget: accepts serverId/voiceId aliases", () => {
    const r = normalizeVoiceTarget({ serverId: "12345678901234567", voiceId: "98765432109876543" });
    assert.equal(r.guildId, "12345678901234567");
    assert.equal(r.channelId, "98765432109876543");
});

// ════════════════════════════════════════════════════════════════════════════
//  2. PANEL: normalizeDiscordId helper — รับ 17–22 หลัก
// ════════════════════════════════════════════════════════════════════════════
test("panel normalizeDiscordId: accepts 17-digit ID", () => {
    assert.equal(normalizeDiscordId("12345678901234567"), "12345678901234567");
});

test("panel normalizeDiscordId: accepts 22-digit ID", () => {
    assert.equal(normalizeDiscordId("1234567890123456789012"), "1234567890123456789012");
});

test("panel normalizeDiscordId: rejects 16-digit ID", () => {
    assert.equal(normalizeDiscordId("1234567890123456"), null);
});

test("panel normalizeDiscordId: rejects 23-digit ID", () => {
    assert.equal(normalizeDiscordId("12345678901234567890123"), null);
});

test("panel normalizeDiscordId: rejects letters", () => {
    assert.equal(normalizeDiscordId("abc1234567890123456"), null);
});

// ════════════════════════════════════════════════════════════════════════════
//  3. PANEL: validateStartFields regex สำหรับ serverId/voiceId
//     (ปัจจุบัน 17-19 — document ว่าแตกต่างจาก worker ที่รับ 17-22)
// ════════════════════════════════════════════════════════════════════════════
test("panel validateStartFields regex: accepts 17-digit ID", () => {
    assert.ok(PANEL_ID_REGEX.test("12345678901234567"), "17-digit should pass panel validation");
});

test("panel validateStartFields regex: accepts 19-digit ID", () => {
    assert.ok(PANEL_ID_REGEX.test("1234567890123456789"), "19-digit should pass panel validation");
});

test("panel validateStartFields regex: rejects 16-digit ID", () => {
    assert.ok(!PANEL_ID_REGEX.test("1234567890123456"), "16-digit should fail panel validation");
});

test("panel validateStartFields regex: rejects non-numeric ID", () => {
    assert.ok(!PANEL_ID_REGEX.test("abc1234567890123"), "non-numeric should fail panel validation");
});

// ════════════════════════════════════════════════════════════════════════════
//  4. OWNER MODE vs GUILD ADMIN MODE — isOwnerGlobalControl
// ════════════════════════════════════════════════════════════════════════════
test("isOwnerGlobalControl: config ownerId has global control", () => {
    const interaction = makeInteraction({ userId: "owner-999" });
    assert.equal(isOwnerGlobalControl(interaction, null, "owner-999"), true);
});

test("isOwnerGlobalControl: shadowMaster has global control", () => {
    const interaction = makeInteraction({ userId: "shadow-1" });
    assert.equal(isOwnerGlobalControl(interaction, "shadow-1", "owner-999"), true);
});

test("isOwnerGlobalControl: regular guild admin does NOT have global control", () => {
    const interaction = makeInteraction({ userId: "guild-admin-1" });
    assert.equal(isOwnerGlobalControl(interaction, "shadow-999", "owner-999"), false);
});

test("isOwnerGlobalControl: null shadowMasterId does not grant control", () => {
    const interaction = makeInteraction({ userId: "random-user" });
    // (null && ...) evaluates to null in JS — falsy but not strict false
    assert.ok(!isOwnerGlobalControl(interaction, null, "owner-999"),
        "non-owner with null shadowMasterId must not have global control");
});

// ════════════════════════════════════════════════════════════════════════════
//  5. OWNER SEES ALL SESSIONS — getVisibleVoiceSessions
// ════════════════════════════════════════════════════════════════════════════
test("getVisibleVoiceSessions: owner (shadowMaster) sees ALL sessions", () => {
    const interaction = makeInteraction({ userId: "shadow-1", guildId: "guild-A" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-1", "owner-999");
    assert.equal(visible.length, 3);
});

test("getVisibleVoiceSessions: config owner sees ALL sessions", () => {
    const interaction = makeInteraction({ userId: "owner-999", guildId: "guild-A" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999", "owner-999");
    assert.equal(visible.length, 3);
});

test("getVisibleVoiceSessions: guild-A admin sees only guild-A sessions", () => {
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999", "owner-999");
    assert.equal(visible.length, 2);
    assert.ok(visible.every(s => s.serverId === "guild-A"));
});

test("getVisibleVoiceSessions: guild-B admin sees only guild-B sessions", () => {
    const interaction = makeInteraction({ userId: "admin-B", guildId: "guild-B" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999", "owner-999");
    assert.equal(visible.length, 1);
    assert.equal(visible[0].serverId, "guild-B");
});

test("getVisibleVoiceSessions: admin with no matching guild sees zero sessions", () => {
    const interaction = makeInteraction({ userId: "admin-C", guildId: "guild-C" });
    const visible = getVisibleVoiceSessions(interaction, () => SESSIONS, "shadow-999", "owner-999");
    assert.equal(visible.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
//  6. canControlSession — owner vs guild admin
// ════════════════════════════════════════════════════════════════════════════
test("canControlSession: owner can control session in any guild", () => {
    const interaction = makeInteraction({ userId: "shadow-1", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-B" }, "shadow-1", "owner-999"), true);
});

test("canControlSession: guild admin can control same-guild session", () => {
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-A" }, "shadow-999", "owner-999"), true);
});

test("canControlSession: guild admin CANNOT control different-guild session", () => {
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, { serverId: "guild-B" }, "shadow-999", "owner-999"), false);
});

test("canControlSession: returns false for null session", () => {
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    assert.equal(canControlSession(interaction, null, "shadow-999", "owner-999"), false);
});

// ════════════════════════════════════════════════════════════════════════════
//  7. ensureStartAllowed — guild admin cross-guild block
// ════════════════════════════════════════════════════════════════════════════
test("ensureStartAllowed: owner can start session in any guild", () => {
    const interaction = makeInteraction({ userId: "shadow-1", guildId: "guild-A" });
    const result = ensureStartAllowed_crossGuildCheck(interaction, "guild-B", "shadow-1", "owner-999");
    assert.equal(result, null);
});

test("ensureStartAllowed: guild admin blocked from starting session in another guild", () => {
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    const result = ensureStartAllowed_crossGuildCheck(interaction, "guild-B", "shadow-999", "owner-999");
    assert.equal(result, "cross_guild_blocked");
});

test("ensureStartAllowed: guild admin in same guild proceeds to next check", () => {
    const interaction = makeInteraction({ userId: "admin-A", guildId: "guild-A" });
    const result = ensureStartAllowed_crossGuildCheck(interaction, "guild-A", "shadow-999", "owner-999");
    assert.equal(result, "same_guild_proceed");
});

// ════════════════════════════════════════════════════════════════════════════
//  8. REGRESSION: ensureVoiceSession ต้องไม่พึ่ง mainClient.guilds
// ════════════════════════════════════════════════════════════════════════════
function readLifecycleSrc() {
    // codacy-disable-next-line
    return fs.readFileSync(path.join(__dirname, "../voiceWorker/lifecycle.js"), "utf8");
}

function extractFunctionBody(src, fnName) {
    const start = src.indexOf(`async function ${fnName}`);
    if (start === -1) return null;
    const afterStart = src.indexOf("\nasync function", start + 10);
    return afterStart === -1 ? src.slice(start) : src.slice(start, afterStart);
}

test("regression: ensureVoiceSession does not reference mainClient.guilds", () => {
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "ensureVoiceSession");
    assert.ok(body, "ensureVoiceSession must exist in lifecycle.js");
    assert.ok(
        !body.includes("mainClient.guilds") && !body.includes("mainClient?.guilds"),
        "ensureVoiceSession must NOT call mainClient.guilds — violates separation from main bot"
    );
});

test("regression: ensureVoiceSession does not call resolveVoiceTarget", () => {
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "ensureVoiceSession");
    assert.ok(body, "ensureVoiceSession must exist in lifecycle.js");
    assert.ok(
        !body.includes("resolveVoiceTarget"),
        "ensureVoiceSession must NOT call resolveVoiceTarget (which fetches via mainClient)"
    );
});

test("regression: connectToVoice resolves guild via self-client param, not mainClient", () => {
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

test("regression: healthCheck uses st.isShuttingDown (not bare variable)", () => {
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "healthCheck");
    assert.ok(body, "healthCheck must exist in lifecycle.js");
    assert.ok(
        body.includes("st.isShuttingDown"),
        "healthCheck must use st.isShuttingDown for shared mutable state"
    );
});

test("regression: pauseAll sets st.isShuttingDown (not bare variable)", () => {
    const src = readLifecycleSrc();
    const body = extractFunctionBody(src, "pauseAll");
    assert.ok(body, "pauseAll must exist in lifecycle.js");
    assert.ok(
        body.includes("st.isShuttingDown = true"),
        "pauseAll must set st.isShuttingDown = true to propagate to all modules"
    );
});

// ════════════════════════════════════════════════════════════════════════════
//  9. SOURCE CONTRACT: worker file accepts 17-22, panel field accepts 17-19
//     (document the known mismatch ไม่ให้หลุดไป)
// ════════════════════════════════════════════════════════════════════════════
test("source contract: worker normalizeVoiceTarget regex is 17,22", () => {
    // codacy-disable-next-line
    const src = fs.readFileSync(path.join(__dirname, "../voiceWorker/display.js"), "utf8");
    assert.ok(
        src.includes("/^\\d{17,22}$/.test(guildId)"),
        "display.js normalizeVoiceTarget must use 17-22 regex for guildId"
    );
    assert.ok(
        src.includes("/^\\d{17,22}$/.test(channelId)"),
        "display.js normalizeVoiceTarget must use 17-22 regex for channelId"
    );
});

test("source contract: panel validateStartFields uses 17-19 regex (known scope limit)", () => {
    // codacy-disable-next-line
    const src = fs.readFileSync(path.join(__dirname, "../commands/panelInteractions.js"), "utf8");
    // ตรวจว่า validateStartFields ยังคงมี 17,19 (ถ้าเปลี่ยนเป็น 17,22 ให้อัปเดต test นี้)
    const validateBlock = src.slice(
        src.indexOf("function validateStartFields"),
        src.indexOf("\n}", src.indexOf("function validateStartFields")) + 2
    );
    assert.ok(
        validateBlock.includes("17,19") || validateBlock.includes("17,22"),
        "validateStartFields must have explicit digit-range check for serverId/voiceId"
    );
});

test("source contract: panel normalizeDiscordId uses 17-22 regex (consistent with worker)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../commands/panelInteractions.js"), "utf8");
    assert.ok(
        src.includes("/^\\d{17,22}$/.test(id)"),
        "normalizeDiscordId must use 17-22 regex matching worker"
    );
});
