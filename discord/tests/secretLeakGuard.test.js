"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { analyzeText, resolveTrackedPath, shouldScanPath } = require("../../scripts/checkSecretLeaks");

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
        sonar-scanner -Dsonar.token="$SONAR_TOKEN";
        const apiKey = "\${API_SECRET}";
    `, "discord/index.js"), []);
});

test("secret guard excludes test fixtures but scans production and configuration paths", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(shouldScanPath("discord/tests/example.test.js"), false);
    assert.equal(shouldScanPath("verification-tests/example.test.js"), false);
    assert.equal(shouldScanPath("discord/index.js"), true);
    assert.equal(shouldScanPath("render.yaml"), true);
    assert.equal(shouldScanPath(".env.example"), true);
});

test("secret guard rejects tracked paths outside the repository root", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(() => resolveTrackedPath("/tmp/repository", "../outside.txt"), /escaped repository root/);
    assert.equal(resolveTrackedPath("/tmp/repository", "discord/index.js"), "/tmp/repository/discord/index.js");
});

test("secret guard handles long adversarial non-matches in bounded time", { timeout: 1500 }, () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const longCredentialLikeText = `mongodb+srv://${"a".repeat(300_000)} without-delimiters`;
    const longAssignmentLikeText = `const token = "${"x".repeat(300_000)}`;
    const startedAt = Date.now();
    assert.deepEqual(analyzeText(`${longCredentialLikeText}\n${longAssignmentLikeText}`, "discord/adversarial.js"), []);
    assert.ok(Date.now() - startedAt < 1000);
});

test("secret guard bounds credential fields without missing normal encoded Mongo credentials", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const findings = analyzeText(
        'const uri = "mongodb+srv://owner%40mail:p%40ssw0rd@example.invalid/test";',
        "discord/mongo.js"
    );
    assert.equal(findings.some(item => item.code === "MONGODB_CREDENTIAL_LITERAL"), true);
});