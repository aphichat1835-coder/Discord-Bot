#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function write(relativePath, content) {
    fs.writeFileSync(path.join(ROOT, relativePath), content, "utf8");
}

function replaceOnce(content, before, after, label) {
    const index = content.indexOf(before);
    if (index === -1) throw new Error(`Patch target not found: ${label}`);
    if (content.indexOf(before, index + before.length) !== -1) {
        throw new Error(`Patch target is ambiguous: ${label}`);
    }
    return `${content.slice(0, index)}${after}${content.slice(index + before.length)}`;
}

function patchProtection() {
    const file = "discord/features/protection.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `function normalizeDomain(value) {\n    const raw = String(value || "").trim().toLowerCase().replace(/^\\.+|\\.+$/g, "");\n    if (!raw || raw.length > 253 || raw.includes("/") || raw.includes(":")) return null;\n    try {\n        const parsed = new URL(\`https://\${raw}\`);\n        if (parsed.hostname !== raw || !raw.includes(".")) return null;\n        return raw;\n    } catch {\n        return null;\n    }\n}`,
        `function normalizeDomain(value) {\n    const input = String(value || "").trim();\n    if (!input || input.length > 253) return null;\n\n    let raw = input.toLowerCase();\n    while (raw.startsWith(".")) raw = raw.slice(1);\n    while (raw.endsWith(".")) raw = raw.slice(0, -1);\n    if (\n        !raw ||\n        raw.length > 253 ||\n        raw.includes("..") ||\n        /[^\\p{L}\\p{N}.-]/u.test(raw)\n    ) return null;\n\n    try {\n        const parsed = new URL(\`https://\${raw}\`);\n        const hostname = parsed.hostname.toLowerCase();\n        if (!hostname || hostname.length > 253 || !hostname.includes(".")) return null;\n        return hostname;\n    } catch {\n        return null;\n    }\n}`,
        "bounded domain normalization"
    );
    content = replaceOnce(
        content,
        `const INVITE_REGEX = /discord(?:app)?\\.(?:com\\/invite|gg)\\/[a-zA-Z0-9-]+/i;`,
        `const INVITE_REGEX = /discord(?:app)?\\.(?:com\\/invite|gg)\\/[a-z0-9-]+/i;`,
        "invite regex duplicate case range"
    );
    write(file, content);
}

function patchProtectionTests() {
    const file = "discord/tests/protectionConfig.test.js";
    let content = read(file);
    const marker = `test("protection config ignores prototype-pollution keys", () => {`;
    const tests = `test("domain normalization bounds input before parsing and canonicalizes Unicode", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    assert.equal(protection.normalizeDomain("...Example.COM..."), "example.com");\n    assert.equal(protection.normalizeDomain("münich.com"), "xn--mnich-kva.com");\n    assert.equal(protection.normalizeDomain("example..com"), null);\n    assert.equal(protection.normalizeDomain("https://example.com/path"), null);\n    assert.equal(protection.normalizeDomain(\`\${".".repeat(300)}example.com\`), null);\n});\n\n`;
    content = replaceOnce(content, marker, `${tests}${marker}`, "domain normalization regression tests");
    write(file, content);
}

function patchCommandGuards() {
    const file = "discord/guards/commandGuards.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `    const content = commandName === "say"\n        ? readCommandOption(interaction, "message")\n        : commandName === "announce"\n            ? readCommandOption(interaction, "content")\n            : "";`,
        `    let content = "";\n    if (commandName === "say") {\n        content = readCommandOption(interaction, "message");\n    } else if (commandName === "announce") {\n        content = readCommandOption(interaction, "content");\n    }`,
        "command mention option selection"
    );
    write(file, content);
}

function patchJoinCampaignRoutes() {
    const file = "discord/index/joinCampaignRoutes.js";
    let content = read(file);
    const registerMarker = `function registerJoinCampaignRoutes({ app, express, client, checkAuth }) {`;
    const helper = `function resolveJoinCampaignStartStatus(code) {\n    switch (code) {\n        case "CAMPAIGN_DISABLED":\n        case "CAMPAIGN_ALLOWLIST_REQUIRED":\n            return 503;\n        case "INVALID_GUILD_ID":\n            return 400;\n        case "TARGET_GUILD_NOT_ALLOWED":\n            return 403;\n        default:\n            return 409;\n    }\n}\n\n`;
    content = replaceOnce(content, registerMarker, `${helper}${registerMarker}`, "join campaign status helper");
    content = replaceOnce(
        content,
        `                const status = started.code === "CAMPAIGN_DISABLED" || started.code === "CAMPAIGN_ALLOWLIST_REQUIRED"\n                    ? 503\n                    : started.code === "INVALID_GUILD_ID"\n                        ? 400\n                        : started.code === "TARGET_GUILD_NOT_ALLOWED"\n                            ? 403\n                            : 409;`,
        `                const status = resolveJoinCampaignStartStatus(started.code);`,
        "join campaign nested status selection"
    );
    content = replaceOnce(
        content,
        `module.exports = {\n    listJoinCampaignTargets,\n    resolveJoinCampaignTarget,\n    registerJoinCampaignRoutes\n};`,
        `module.exports = {\n    listJoinCampaignTargets,\n    resolveJoinCampaignStartStatus,\n    resolveJoinCampaignTarget,\n    registerJoinCampaignRoutes\n};`,
        "join campaign exports"
    );
    write(file, content);
}

function patchUtilityRestore() {
    const file = "discord/commands/utility.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `                const validTypes = [...SUPPORTED_BACKUP_CHANNEL_TYPES];`,
        `                const validTypes = new Set(SUPPORTED_BACKUP_CHANNEL_TYPES);`,
        "restore channel type set"
    );
    content = replaceOnce(
        content,
        `                                if (validTypes.includes(cData.type)) {`,
        `                                if (validTypes.has(cData.type)) {`,
        "restore channel type lookup"
    );
    write(file, content);
}

function patchOAuthRoute() {
    const file = "discord/verification/routes/oauth.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `const VERIFY_SCOPE = 'identify identify.premium email connections guilds guilds.members.read guilds.join';\nconst DEVICE_DUPLICATE_LOOKUP_MAX`,
        `const VERIFY_SCOPE = 'identify identify.premium email connections guilds guilds.members.read guilds.join';\nconst DISCORD_AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';\n\nfunction buildDiscordAuthorizeUrl(params) {\n    const url = new URL(DISCORD_AUTHORIZE_ENDPOINT);\n    url.search = params.toString();\n    if (url.origin !== 'https://discord.com' || url.pathname !== '/oauth2/authorize') {\n        const error = new Error('Discord OAuth authorize endpoint is invalid');\n        error.code = 'discord_oauth_authorize_endpoint_invalid';\n        throw error;\n    }\n    return url.toString();\n}\n\nconst DEVICE_DUPLICATE_LOOKUP_MAX`,
        "fixed Discord OAuth authorize URL"
    );
    content = replaceOnce(
        content,
        `function applyOAuthTokenStorage(updateSet, tokenData) {`,
        `function applyForcedOAuthTokenStorage(updateSet, tokenData) {`,
        "forced OAuth storage helper name"
    );
    content = replaceOnce(
        content,
        `    storagePolicy = {},\n    fetchMetadata = {},`,
        `    fetchMetadata = {},`,
        "remove ignored OAuth storage policy parameter"
    );
    content = replaceOnce(
        content,
        `            applyOAuthTokenStorage(updateSet, tokenData, storagePolicy);`,
        `            applyForcedOAuthTokenStorage(updateSet, tokenData);`,
        "forced OAuth storage invocation"
    );
    content = replaceOnce(
        content,
        `        return res.redirect(302, \`https://discord.com/oauth2/authorize?\${params.toString()}\`);`,
        `        return res.redirect(302, buildDiscordAuthorizeUrl(params));`,
        "fixed OAuth redirect target"
    );
    content = replaceOnce(
        content,
        `module.exports._test = {\n    decodeUserBadgeFlags,`,
        `module.exports._test = {\n    buildDiscordAuthorizeUrl,\n    decodeUserBadgeFlags,`,
        "OAuth helper test export"
    );
    write(file, content);
}

function patchOAuthContracts() {
    const file = "verification-tests/oauthSourceContracts.test.js";
    let content = read(file);
    const ending = `    test('does not pass callback-derived object filters directly to findOne', () => {\n        expect(routeSource).not.toMatch(/IpIdentityLink\\.findOne\\(\\s*\\{/);\n        expect(routeSource).not.toMatch(/GuildConfig\\.findOne\\(\\s*\\{/);\n        expect(routeSource).toContain(".where('guildId').equals(safeGuildId)");\n        expect(routeSource).toContain(".where('ipHash').equals(safeIpHash)");\n        expect(routeSource).toContain(".where('guildId').equals(guildId)");\n    });\n});`;
    const replacement = `    test('does not pass callback-derived object filters directly to findOne', () => {\n        expect(routeSource).not.toMatch(/IpIdentityLink\\.findOne\\(\\s*\\{/);\n        expect(routeSource).not.toMatch(/GuildConfig\\.findOne\\(\\s*\\{/);\n        expect(routeSource).toContain(".where('guildId').equals(safeGuildId)");\n        expect(routeSource).toContain(".where('ipHash').equals(safeIpHash)");\n        expect(routeSource).toContain(".where('guildId').equals(guildId)");\n    });\n\n    test('uses a fixed Discord authorize target and an explicit forced token-storage contract', () => {\n        expect(routeSource).toContain("const DISCORD_AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';");\n        expect(routeSource).toContain("url.origin !== 'https://discord.com'");\n        expect(routeSource).toContain("url.pathname !== '/oauth2/authorize'");\n        expect(routeSource).toContain('applyForcedOAuthTokenStorage(updateSet, tokenData);');\n        expect(routeSource).not.toContain('applyOAuthTokenStorage(updateSet, tokenData, storagePolicy)');\n        expect(routeSource).not.toContain('storagePolicy = {}');\n    });\n});`;
    content = replaceOnce(content, ending, replacement, "OAuth source contract assertions");
    write(file, content);
}

patchProtection();
patchProtectionTests();
patchCommandGuards();
patchJoinCampaignRoutes();
patchUtilityRestore();
patchOAuthRoute();
patchOAuthContracts();
console.log("Applied non-protected quality fixes.");
