const assert = require("node:assert/strict");
const test = require("node:test");

const {
    MIN_TOKEN_LENGTH,
    MAX_TOKEN_LENGTH,
    TOKEN_PATTERN,
    toBase64Url,
    decodeTokenOwnerIdSafe,
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
});

test("decodeTokenOwnerIdSafe validates the base64url owner segment", () => {
    const userId = "123456789012345678";
    const token = `${toBase64Url(userId)}.${"b".repeat(6)}.${"c".repeat(27)}`;

    assert.equal(decodeTokenOwnerIdSafe(token), userId);
    assert.equal(decodeTokenOwnerIdSafe(`${toBase64Url("abc")}.b.c`), null);
    assert.equal(decodeTokenOwnerIdSafe("not/a/token"), null);
});

test("redactToken keeps only short edge markers", () => {
    const token = "abcdef.ghijklmnopqrstuvwxyz.1234567890";

    assert.equal(redactToken(null), "[REDACTED_TOKEN]");
    assert.equal(redactToken("short"), "[REDACTED_TOKEN]");
    assert.equal(redactToken(token), "abcdef...[REDACTED]...567890");
});
