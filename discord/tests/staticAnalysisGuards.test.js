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

test("protected path guard reads only literal allowlisted files", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const source = fs.readFileSync("scripts/checkProtectedPaths.js", "utf8");

    assert.doesNotMatch(source, /readFileSync\(file\)/);
    assert.match(source, /readFileSync\("discord\/systemProvider\.js"\)/);
    assert.match(source, /OWNER_APPROVED_FILES\.get\(file\)/);
});
