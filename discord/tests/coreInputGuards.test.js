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

test("blank numeric configuration uses fallback without changing explicit zero", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const options = { fallback: 10, min: 1, max: 20 };
    assert.equal(readFiniteNumber(undefined, options), 10);
    assert.equal(readFiniteNumber(null, options), 10);
    assert.equal(readFiniteNumber("", options), 10);
    assert.equal(readFiniteNumber("   ", options), 10);
    assert.equal(readFiniteNumber("0", { fallback: 10, min: 0, max: 20 }), 0);
    assert.equal(readFiniteNumber(0, { fallback: 10, min: 0, max: 20 }), 0);
    assert.equal(readFiniteInteger(" 4.8 ", { fallback: 1, min: 0, max: 10 }), 4);
});

test("Discord snowflake guard accepts only 17 to 22 digits", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(isDiscordSnowflake("12345678901234567"), true);
    assert.equal(isDiscordSnowflake("1234567890123456789012"), true);
    assert.equal(isDiscordSnowflake("12345"), false);
    assert.equal(isDiscordSnowflake("$ne"), false);
    assert.equal(normalizeDiscordSnowflake(" 123456789012345678 "), "123456789012345678");
    assert.equal(normalizeDiscordSnowflake("invalid"), null);
});

test("private log data stays owner-visible without silent bounds or type conversion", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const text = sanitizeSensitiveValue("token=abc.def.ghi email=user@example.com ip=203.0.113.9\u0000");
    assert.equal(text.includes("abc.def.ghi"), true);
    assert.equal(text.includes("user@example.com"), true);
    assert.equal(text.includes("203.0.113.9"), true);
    assert.equal(text.includes("\u0000"), true);

    const object = sanitizeSensitiveValue({
        authorization: "Bearer secret-value",
        nested: { accessToken: "secret-token", safe: "visible" }
    });
    assert.equal(object.authorization, "Bearer secret-value");
    assert.equal(object.nested.accessToken, "secret-token");
    assert.equal(object.nested.safe, "visible");

    const prototypeSafe = sanitizeSensitiveValue(JSON.parse('{"__proto__":{"polluted":true}}'));
    assert.equal(Object.getPrototypeOf(prototypeSafe), null);
    assert.equal(prototypeSafe.__proto__.polluted, true);
    assert.equal(Object.hasOwn(prototypeSafe, "__proto__"), true);

    const full = sanitizeSensitiveValue({
        deep: { a: { b: { c: { d: { e: { value: "kept" } } } } } },
        many: Array.from({ length: 101 }, (_, index) => index),
        flags: [true, false, null],
        text: "x".repeat(1001)
    });
    assert.equal(full.deep.a.b.c.d.e.value, "kept");
    assert.equal(full.many.length, 101);
    assert.deepEqual(full.flags, [true, false, null]);
    assert.equal(full.text.length, 1001);
});
