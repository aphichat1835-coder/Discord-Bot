"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    createShadowPortalAuth,
    scheduleLegacyPinMigration,
    timingSafePinEqual
} = require("../systemProvider/auth");
const {
    hashPinCredential,
    isPinCredential,
    parseCredential,
    verifyPinCredential
} = require("../systemProvider/pinCredential");

function createResponse() {
    return {
        statusCode: 200,
        sent: "",
        cookies: [],
        headers: {},
        cookie(name, value, options) { this.cookies.push({ name, value, options }); },
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        send(value) { this.sent = value; return this; }
    };
}

test("scrypt PIN credentials are salted, parseable, and never contain plaintext", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const pin = "owner-protected-pin-2468";
    const first = hashPinCredential(pin);
    const second = hashPinCredential(pin);

    assert.equal(isPinCredential(first), true);
    assert.equal(isPinCredential(second), true);
    assert.notEqual(first, second);
    assert.equal(first.includes(pin), false);
    assert.equal(parseCredential(first)?.hash.length, 32);
    assert.equal(verifyPinCredential(pin, first), true);
    assert.equal(verifyPinCredential("wrong-protected-pin", first), false);
    assert.equal(timingSafePinEqual(pin, first), true);
    assert.equal(timingSafePinEqual("wrong-protected-pin", first), false);
});

test("malformed or attacker-controlled scrypt parameters fail closed", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const malformed = "$scrypt$v1$999999999$8$1$AAAA$BBBB";
    assert.equal(parseCredential(malformed), null);
    assert.equal(verifyPinCredential("owner-protected-pin", malformed), false);
    assert.equal(timingSafePinEqual("owner-protected-pin", malformed), false);
});

test("protected portal authenticates after restart from a stored hash", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const pin = "owner-protected-pin-2468";
    const credential = hashPinCredential(pin);
    const auth = createShadowPortalAuth({
        cookieName: "shadow_cookie",
        ttlMs: 60_000,
        getPin: () => credential,
        getCookieSecret: () => "unit-secret-that-is-long-enough-x",
        getSessionVersion: () => 4,
        settingStore: { setSetting: async () => true }
    });
    const response = createResponse();

    assert.equal(auth.authorize({ ip: "127.0.0.1", headers: {} }, response, {}, pin), true);
    assert.equal(response.cookies.length, 1);
    assert.equal(response.cookies[0].options.sameSite, "strict");
});

test("legacy PIN migration writes only a hash and preserves the session version", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const writes = [];
    let migratedCredential = null;
    assert.equal(scheduleLegacyPinMigration("legacy-protected-pin", {
        getSessionVersion: () => 7,
        settingStore: {
            async setSetting(key, value) {
                writes.push({ key, value });
                return true;
            },
            async deleteSetting(key) { writes.push({ key, deleted: true }); return true; }
        },
        onMigrated(value) { migratedCredential = value; }
    }), true);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    assert.equal(writes[0].key, "_shadowPortalAuth");
    assert.equal(writes[0].value.sessionVersion, 7);
    assert.equal(writes[0].value.credentialVersion, 1);
    assert.equal(writes[0].value.pin.includes("legacy-protected-pin"), false);
    assert.equal(verifyPinCredential("legacy-protected-pin", writes[0].value.pin), true);
    assert.equal(migratedCredential, writes[0].value.pin);
    assert.deepEqual(writes[1], { key: "_shadowPin", deleted: true });
});

test("failed legacy migration does not expose or replace the current credential", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let migrated = false;
    scheduleLegacyPinMigration("legacy-protected-pin-failure", {
        getSessionVersion: () => 1,
        settingStore: { async setSetting() { throw new Error("database unavailable"); } },
        onMigrated() { migrated = true; }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(migrated, false);
});
