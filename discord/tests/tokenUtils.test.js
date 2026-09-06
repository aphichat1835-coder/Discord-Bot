const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MIN_TOKEN_LENGTH,
    MAX_TOKEN_LENGTH,
    TOKEN_PATTERN,
    validateTokenFormat,
    redactToken
} = require("../sessions/tokenUtils");

test("token constants describe the accepted token envelope", () => {
    assert.equal(MIN_TOKEN_LENGTH, 50);
    assert.equal(MAX_TOKEN_LENGTH, 256);
    assert.equal(TOKEN_PATTERN.test("a".repeat(24) + "." + "b".repeat(6) + "." + "c".repeat(27)), true);
});

test("validateTokenFormat accepts shaped tokens and rejects unsafe input", () => {
    const valid = `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`;

    assert.equal(validateTokenFormat(valid), true);
    assert.equal(validateTokenFormat(null), false);
    assert.equal(validateTokenFormat("short.token.value"), false);
    assert.equal(validateTokenFormat(`${"a".repeat(300)}.b.c`), false);

    // Tokens with '=' padding
    const tokenWithEquals = `${"a".repeat(23)}=.${"b".repeat(4)}.${"c".repeat(26)}=`;
    assert.equal(validateTokenFormat(tokenWithEquals), true);

    // Tokens with standard Base64 characters '+' and '/'
    const tokenWithPlusAndSlash = `${"a".repeat(22)}+=.${"b".repeat(4)}/.${"c".repeat(25)}+/`;
    assert.equal(validateTokenFormat(tokenWithPlusAndSlash), true);

    // MFA tokens (mfa.<payload>)
    const mfaToken = `mfa.${"A".repeat(70)}`;
    const mfaWithPlusSlash = `mfa.${"B".repeat(30)}+${"C".repeat(30)}/==`;
    assert.equal(validateTokenFormat(mfaToken), true);
    assert.equal(validateTokenFormat(mfaWithPlusSlash), true);
    assert.equal(validateTokenFormat("mfa.short"), false);

    // Tokens wrapped in quotes
    assert.equal(validateTokenFormat(`"${valid}"`), true);
    assert.equal(validateTokenFormat(`'${valid}'`), true);

    // Tokens wrapped in markdown backticks
    assert.equal(validateTokenFormat(`\`${valid}\``), true);
    assert.equal(validateTokenFormat(`\`\`\`${valid}\`\`\``), true);
    assert.equal(validateTokenFormat(`\`\`\`js\n${valid}\n\`\`\``), true);

    // Tokens with invisible / zero-width spaces
    assert.equal(validateTokenFormat(`\u200B${valid}\u200B`), true);
    assert.equal(validateTokenFormat(`\uFEFF${valid}`), true);

    // Tokens with Bot or Bearer prefix
    assert.equal(validateTokenFormat(`Bot ${valid}`), true);
    assert.equal(validateTokenFormat(`Bearer ${valid}`), true);
});

test("voiceWorker validateToken is consistent with validateTokenFormat", () => {
    const { validateToken } = require("../voiceWorker/session");
    const valid3Part = `${"x".repeat(24)}.${"y".repeat(6)}.${"z".repeat(27)}`;
    const validWithPlusSlash = `${"x".repeat(22)}+=.${"y".repeat(4)}/.${"z".repeat(25)}+/`;
    const validMfa = `mfa.${"W".repeat(70)}`;

    assert.equal(validateToken(valid3Part), true);
    assert.equal(validateToken(validWithPlusSlash), true);
    assert.equal(validateToken(validMfa), true);
    assert.equal(validateToken(`\`${valid3Part}\``), true);
    assert.equal(validateToken(`\u200B${valid3Part}`), true);

    assert.throws(() => validateToken("invalid.short.token"), /INVALID_TOKEN_FORMAT/);
    assert.throws(() => validateToken(null), /INVALID_TOKEN_FORMAT/);
    assert.throws(() => validateToken(""), /INVALID_TOKEN_FORMAT/);
});


test("redactToken keeps only short edge markers", () => {
    const sampleValue = ["abcdef", "ghijklmnopqrstuvwxyz", "1234567890"].join(".");

    assert.equal(redactToken(null), "[REDACTED_TOKEN]");
    assert.equal(redactToken("short"), "[REDACTED_TOKEN]");
    assert.equal(redactToken(sampleValue), "abcdef...[REDACTED]...567890");
});
