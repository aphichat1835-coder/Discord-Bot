"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { analyzeText, shouldScanPath } = require("../../scripts/checkSecretLeaks");

test("secret guard detects credential-shaped literals without returning secret values", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const source = [
        'const token = "abcdefghijklmnopqrstuv.abcdef.abcdefghijklmnopqrstuvwxyzABCDE";',
        'const uri = "mongodb+srv://owner:password@example.invalid/test";',
        'const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDE";'
    ].join("\n");
    const findings = analyzeText(source, "discord/example.js");
    const codes = new Set(findings.map(item => item.code));

    assert.equal(codes.has("DISCORD_TOKEN_LITERAL"), true);
    assert.equal(codes.has("MONGODB_CREDENTIAL_LITERAL"), true);
    assert.equal(codes.has("DISCORD_WEBHOOK_LITERAL"), true);
    assert.equal(codes.has("HARDCODED_SECRET_ASSIGNMENT"), true);
    assert.equal(JSON.stringify(findings).includes("owner:password"), false);
    assert.equal(JSON.stringify(findings).includes("abcdefghijklmnopqrstuvwxyzABCDE"), false);
});

test("secret guard accepts environment references and explicit placeholders", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(analyzeText(`
        const token = process.env.TOKEN_MANAGER;
        const secret = "<set-in-hosting-provider>";
        const password = "replace-me-before-deploy";
    `, "discord/index.js"), []);
});

test("secret guard excludes test fixtures but scans production and configuration paths", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(shouldScanPath("discord/tests/example.test.js"), false);
    assert.equal(shouldScanPath("verification-tests/example.test.js"), false);
    assert.equal(shouldScanPath("discord/index.js"), true);
    assert.equal(shouldScanPath("render.yaml"), true);
    assert.equal(shouldScanPath(".env.example"), true);
});
