"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { readFiniteInteger, readFiniteNumber } = require("../core/numbers");
const { isDiscordSnowflake, normalizeDiscordSnowflake } = require("../core/snowflakes");
const { sanitizeSensitiveValue } = require("../core/sensitiveData");

test("finite configuration guards reject NaN and Infinity while enforcing bounds", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(readFiniteNumber("Infinity", { fallback: 10, min: 1, max: 20 }), 10);
    assert.equal(readFiniteNumber("NaN", { fallback: 10, min: 1, max: 20 }), 10);
    assert.equal(readFiniteNumber("-5", { fallback: 10, min: 1, max: 20 }), 1);
    assert.equal(readFiniteNumber("50", { fallback: 10, min: 1, max: 20 }), 20);
    assert.equal(readFiniteInteger("4.8", { fallback: 1, min: 0, max: 10 }), 4);
});

test("Discord snowflake guard accepts only 17 to 22 digits", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(isDiscordSnowflake("12345678901234567"), true);
    assert.equal(isDiscordSnowflake("1234567890123456789012"), true);
    assert.equal(isDiscordSnowflake("12345"), false);
    assert.equal(isDiscordSnowflake("$ne"), false);
    assert.equal(normalizeDiscordSnowflake(" 123456789012345678 "), "123456789012345678");
    assert.equal(normalizeDiscordSnowflake("invalid"), null);
});

test("sensitive-data sanitizer redacts nested credentials and personal network data", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const token = "abc.def.ghi";
    const text = sanitizeSensitiveValue(`token=${token} email=user@example.com ip=203.0.113.9`);
    assert.doesNotMatch(text, /abc\.def\.ghi/);
    assert.doesNotMatch(text, /user@example\.com/);
    assert.doesNotMatch(text, /203\.0\.113\.9/);

    const object = sanitizeSensitiveValue({
        authorization: "Bearer secret-value",
        nested: { accessToken: "secret-token", safe: "visible" }
    });
    assert.notEqual(object.authorization, "Bearer secret-value");
    assert.notEqual(object.nested.accessToken, "secret-token");
    assert.equal(object.nested.safe, "visible");
});
