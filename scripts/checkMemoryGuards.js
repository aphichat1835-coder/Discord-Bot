#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function fail(findings) {
    console.error("[MEMORY-GUARDS] risky patterns found:");
    for (const finding of findings) {
        console.error(`- ${finding}`);
    }
    process.exit(1);
}

function assertNotContains(findings, relativePath, pattern, message) {
    const text = read(relativePath);
    if (pattern.test(text)) findings.push(`${relativePath}: ${message}`);
}

function assertContains(findings, relativePath, pattern, message) {
    const text = read(relativePath);
    if (!pattern.test(text)) findings.push(`${relativePath}: ${message}`);
}

const findings = [];

assertNotContains(
    findings,
    "discord/commands.js",
    /PanelStateModel\.find\s*\(\s*\{\s*\}\s*\)/,
    "restorePanels must use sessionManager.getPanelStates() so panel state loading stays bounded"
);

assertNotContains(
    findings,
    "discord/index/views.js",
    /ApprovedGuildModel\.find\s*\(\s*\{\s*\}\s*\)/,
    "approved dashboard page must use sessionManager.getApprovedGuildDocs() so guild loading stays bounded"
);

assertContains(
    findings,
    "dashboard-public/utils/discordAPI.js",
    /DISCORD_API_RESPONSE_MAX_BYTES/,
    "Discord API helper must keep a response byte limit"
);

assertContains(
    findings,
    "dashboard-public/utils/discordAPI.js",
    /totalBytes\s*>\s*DISCORD_API_RESPONSE_MAX_BYTES/,
    "Discord API helper must reject oversized responses before Buffer.concat"
);

assertContains(
    findings,
    "discord/sessionManager.js",
    /PANEL_STATES_LOAD_MAX/,
    "sessionManager must expose a bounded panel-state load limit"
);

assertContains(
    findings,
    "discord/sessionManager.js",
    /SESSION_LOAD_MAX/,
    "sessionManager must keep session auto-load bounded"
);

for (const routeFile of [
    "dashboard-public/routes/api.js",
    "dashboard-public/routes/guildDashboard.js"
]) {
    assertNotContains(
        findings,
        routeFile,
        /select\s*\(\s*['"`][^'"`]*\bconnections\b[^'"`]*\bguilds\b[^'"`]*['"`]\s*\)/,
        "dashboard routes must use oauthUserSummary counts instead of loading OAuthUser connections/guilds arrays"
    );
}

assertContains(
    findings,
    "dashboard-public/utils/oauthUserSummary.js",
    /\$size:\s*\{\s*\$ifNull:\s*\['\$connections'/,
    "OAuth user summary loader must count connections without returning the array"
);

if (findings.length) fail(findings);

console.log("[MEMORY-GUARDS] bounded memory guard patterns verified.");
