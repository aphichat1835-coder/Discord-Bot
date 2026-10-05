"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("../index/events");

test("protection pipeline merges multiple rule findings into one strongest action", () => {
    const merged = _test.mergeProtectionFindings([
        {
            trigger: "Anti-Spam",
            action: "timeout",
            severity: "danger",
            reason: "ข้อความถี่เกินไป",
            evidence: ["spam-window"],
            shouldCreateCase: true,
            shouldDelete: true
        },
        {
            trigger: "Link Filter",
            action: "delete_message",
            severity: "warning",
            reason: "พบลิงก์ต้องห้าม",
            evidence: ["blocked-link"],
            shouldCreateCase: false,
            shouldDelete: true
        }
    ]);

    assert.equal(merged.action, "timeout");
    assert.equal(merged.severity, "danger");
    assert.equal(merged.shouldCreateCase, true);
    assert.equal(merged.deleteMode, "single");
    assert.deepEqual(merged.metadata.ruleIds, ["Anti-Spam", "Link Filter"]);
    assert.deepEqual(new Set(merged.evidence), new Set(["spam-window", "blocked-link"]));
});

test("anti-raid evidence chooses bounded raid deletion once", () => {
    const merged = _test.mergeProtectionFindings([
        {
            trigger: "Anti-Raid Mention",
            action: "ban",
            severity: "critical",
            reason: "raid",
            shouldCreateCase: true,
            shouldDelete: true
        },
        {
            trigger: "Anti-Spam",
            action: "timeout",
            severity: "danger",
            reason: "spam",
            shouldCreateCase: true,
            shouldDelete: true
        }
    ]);
    assert.equal(merged.action, "ban");
    assert.equal(merged.deleteMode, "raid");
});

test("checkProtectedCommandAccess allows normal commands and restricts owner commands", async () => {
    const config = { system: { ownerId: "owner_123" } };
    const normalCmd = {
        guild: { id: "guild_1" },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        commandName: "ping",
        user: { id: "user_456" }
    };
    const normalRes = await _test.checkProtectedCommandAccess(normalCmd, config, "shadow_master");
    assert.equal(normalRes.allowed, true);

    const replies = [];
    const protectedCmdUnauthorized = {
        guild: { id: "guild_1" },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        commandName: "backup",
        user: { id: "unauthorized_user" },
        reply: (payload) => replies.push(payload)
    };
    const unauthRes = await _test.checkProtectedCommandAccess(protectedCmdUnauthorized, config, "shadow_master");
    assert.equal(unauthRes.allowed, false);
    assert.match(replies[0].content, /เจ้าของบอท/);
});

test("checkDisabledCommand blocks disabled commands with notice", async () => {
    const disabledCommands = new Set(["disabled_cmd"]);
    const replies = [];
    const interaction = {
        isChatInputCommand: () => true,
        commandName: "disabled_cmd",
        reply: async (payload) => replies.push(payload)
    };

    const res = await _test.checkDisabledCommand(interaction, disabledCommands);
    assert.equal(res.allowed, false);
    assert.match(replies[0].content, /ถูกปิดใช้งานชั่วคราว/);

    const activeInteraction = {
        isChatInputCommand: () => true,
        commandName: "active_cmd"
    };
    const activeRes = await _test.checkDisabledCommand(activeInteraction, disabledCommands);
    assert.equal(activeRes.allowed, true);
});

