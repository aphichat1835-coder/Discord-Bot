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

    // Tokens wrapped in quotes
    assert.equal(validateTokenFormat(`"${valid}"`), true);
    assert.equal(validateTokenFormat(`'${valid}'`), true);

    // Tokens with Bot or Bearer prefix
    assert.equal(validateTokenFormat(`Bot ${valid}`), true);
    assert.equal(validateTokenFormat(`Bearer ${valid}`), true);
});


test("redactToken keeps only short edge markers", () => {
    const sampleValue = ["abcdef", "ghijklmnopqrstuvwxyz", "1234567890"].join(".");

    assert.equal(redactToken(null), "[REDACTED_TOKEN]");
    assert.equal(redactToken("short"), "[REDACTED_TOKEN]");
    assert.equal(redactToken(sampleValue), "abcdef...[REDACTED]...567890");
});
