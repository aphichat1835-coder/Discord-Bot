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
