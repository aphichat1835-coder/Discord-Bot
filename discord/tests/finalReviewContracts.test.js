"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const SOURCE_FILES = Object.freeze({
    system: path.join(REPOSITORY_ROOT, "discord/index/system.js"),
    oauth: path.join(REPOSITORY_ROOT, "discord/verification/routes/oauth.js"),
    guild: path.join(REPOSITORY_ROOT, "discord/verification/routes/guild.js")
});

function source(name) {
    const filename = SOURCE_FILES[name];
    if (!filename) throw new Error(`Unknown source fixture: ${name}`);
    return fs.readFileSync(filename, "utf8");
}

test("fatal shutdown escalates the exit code of an in-progress graceful shutdown", () => {
    const system = source("system");
    assert.match(system, /let shutdownExitCode = 0;/);
    assert.match(system, /shutdownExitCode = Math\.max\(shutdownExitCode, Number\(exitCode\) \|\| 0\);/);
    assert.match(system, /process\.exit\(shutdownExitCode\);/);
});

test("OAuth start has a bounded friendly error boundary and a fixed Discord redirect", () => {
    const oauth = source("oauth");
    const start = oauth.indexOf("router.get('/auth/start'");
    const end = oauth.indexOf("router.get('/auth/callback'", start);
    assert.ok(start >= 0 && end > start);
    const handler = oauth.slice(start, end);
    assert.match(handler, /try \{/);
    assert.match(handler, /catch \(error\)/);
    assert.match(handler, /res\.status\(503\)\.send\('ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่'\)/);
    assert.match(handler, /buildDiscordAuthorizeUrl\(params\)/);
    assert.match(oauth, /const DISCORD_AUTHORIZE_ENDPOINT = 'https:\/\/discord\.com\/oauth2\/authorize';/);
    assert.match(oauth, /url\.origin !== 'https:\/\/discord\.com'/);
    assert.match(oauth, /url\.pathname !== '\/oauth2\/authorize'/);
});

test("privacy deletion response uses the verified manifest deletedCount", () => {
    const guild = source("guild");
    assert.match(guild, /deletedCount: Number\(deletion\.manifest\?\.deletedCount \|\| 0\)/);
    assert.doesNotMatch(guild, /deletedCount: Object\.values\(deletion\.manifest/);
});
