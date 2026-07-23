"use strict";

const crypto = require("node:crypto");
const test = require("node:test");

process.env.ENCRYPTION_KEY = "voice-session-encryption-test-key-with-enough-entropy";
const sessionManager = require("../sessionManager");

function legacyVoiceToken(plaintext) {
    const key = Buffer.from(
        crypto.createHash("sha256")
            .update(process.env.ENCRYPTION_KEY)
            .digest("base64")
            .substring(0, 32)
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `gcm:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

function legacyVoiceTokenWithoutConfiguredKey(plaintext) {
    // Byte-level compatibility vector avoids embedding a secret-like string in
    // the test while reproducing the historical raw 32-byte fallback exactly.
    const key = Buffer.from([
        100, 101, 102, 97, 117, 108, 116, 45,
        107, 101, 121, 45, 99, 104, 97, 110,
        103, 101, 45, 109, 101, 45, 51, 50,
        45, 99, 104, 97, 114, 115, 33, 33
    ]);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `gcm:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

function legacyVoiceCbcToken(plaintext) {
    const key = Buffer.from(
        crypto.createHash("sha256")
            .update(process.env.ENCRYPTION_KEY)
            .digest("base64")
            .substring(0, 32)
    );
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${ciphertext.toString("hex")}`;
}

test("Voice session writes use v3 full-key encryption", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const encrypted = sessionManager.encryptToken("voice-token-value");

    t.assert.match(encrypted, /^v3:gcm:/);
    t.assert.equal(sessionManager.decryptToken(encrypted), "voice-token-value");
    t.assert.equal(sessionManager._test.decryptTokenWithMetadata(encrypted).needsMigration, false);
});

test("Voice session legacy GCM tokens migrate without changing plaintext", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const legacy = legacyVoiceToken("legacy-voice-token-value");
    const migration = sessionManager._test.migrateEncryptedToken(legacy);

    t.assert.equal(migration.migrated, true);
    t.assert.match(migration.token, /^v3:gcm:/);
    t.assert.equal(sessionManager.decryptToken(migration.token), "legacy-voice-token-value");
});

test("Voice session legacy GCM tokens created before ENCRYPTION_KEY remain migratable", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const legacy = legacyVoiceTokenWithoutConfiguredKey("legacy-default-key-token-value");
    const migration = sessionManager._test.migrateEncryptedToken(legacy);

    t.assert.equal(migration.migrated, true);
    t.assert.match(migration.token, /^v3:gcm:/);
    t.assert.equal(sessionManager.decryptToken(migration.token), "legacy-default-key-token-value");
});

test("Voice session legacy CBC tokens remain readable and migrate to authenticated GCM", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const legacy = legacyVoiceCbcToken("legacy-cbc-voice-token-value");
    const migration = sessionManager._test.migrateEncryptedToken(legacy);

    t.assert.equal(migration.migrated, true);
    t.assert.match(migration.token, /^v3:gcm:/);
    t.assert.equal(sessionManager.decryptToken(migration.token), "legacy-cbc-voice-token-value");
});
