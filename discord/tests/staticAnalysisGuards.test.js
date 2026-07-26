"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("voice notification storage avoids computed object injection sinks", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const source = fs.readFileSync("discord/voiceWorker/notifications.js", "utf8");

    assert.doesNotMatch(source, /notificationState\.events\s*\[[^\]]+\]/);
    assert.doesNotMatch(source, /digest\.counts\s*\[[^\]]+\]/);
    assert.doesNotMatch(source, /delete\s+events\s*\[/);
    assert.doesNotMatch(source, /\\u0000|\\x00/);
    assert.match(source, /Object\.create\(null\)/);
    assert.match(source, /EVENT_TYPES\.has\(type\)/);
});

test("protected path guard inventories the complete protected tree and requires external head approval", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const source = fs.readFileSync("scripts/checkProtectedPaths.js", "utf8");
    const manifest = JSON.parse(fs.readFileSync(".github/protected-path-digests.json", "utf8"));

    assert.match(source, /git\(\["ls-files", PROTECTED_ROOT_FILE, PROTECTED_DIRECTORY\]\)/);
    assert.match(source, /protected-owner-approval:/);
    assert.match(source, /pull_request\?\.head\?\.sha/);
    assert.match(source, /comments\?per_page=100/);
    assert.deepEqual(Object.keys(manifest).sort(), [
        "discord/systemProvider.js",
        "discord/systemProvider/actions.js",
        "discord/systemProvider/auth.js",
        "discord/systemProvider/dashboardHtml.js",
        "discord/systemProvider/htmlUtils.js",
        "discord/systemProvider/renderers.js"
    ]);
});
