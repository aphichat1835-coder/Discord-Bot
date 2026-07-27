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


test("main dashboard destructive and sensitive routes are POST-only and CSRF-protected", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const server = fs.readFileSync("discord/index/server.js", "utf8");
    const sessions = fs.readFileSync("discord/sessionManager.js", "utf8");
    const views = fs.readFileSync("discord/index/views.js", "utf8");
    const helpers = fs.readFileSync("discord/index/viewHelpers.js", "utf8");

    assert.doesNotMatch(server, /app\.get\("\/auth\/logout"/);
    assert.match(server, /app\.post\("\/auth\/logout", auth\.requirePin, auth\.requireCsrf/);
    assert.doesNotMatch(server, /\/api\/reveal-token/);
    assert.doesNotMatch(server, /\/api\/reveal-all-tokens/);
    assert.doesNotMatch(views, /fetch\('\/api\/reveal-token\/'/);
    assert.match(server, /token: getSessionTokenSafe/);
    assert.match(helpers, /fetch\('\/auth\/logout',\{method:'POST'\}\)/);
    assert.doesNotMatch(sessions, /clearAllSessions/);
    assert.doesNotMatch(sessions, /deleteMany\(\{\}\)/);
});
