"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    databaseNameFromMongoUri,
    exactAllowedHosts,
    hashIdentifier,
    redactSecrets,
    validateIsolatedEnvironment
} = require("../../scripts/runIsolatedEnvironmentGate");

function validEnvironment() {
    return {
        TEST_ENVIRONMENT_CONFIRMATION: "ISOLATED_TEST_ONLY",
        TEST_MONGO_URI: "mongodb://gate_user:gate_password@mongo.example.test/project_integration_test?retryWrites=false",
        TEST_DISCORD_TOKEN: "test-bot-token-value-not-a-real-token",
        TEST_GUILD_ID: "123456789012345678",
        TEST_TEXT_CHANNEL_ID: "223456789012345678",
        TEST_VOICE_CHANNEL_ID: "323456789012345678",
        TEST_DISCORD_CLIENT_ID: "423456789012345678",
        TEST_DISCORD_CLIENT_SECRET: "test-client-secret-value",
        TEST_PUBLIC_BASE_URL: "https://preview.example.test/",
        TEST_ALLOWED_HOSTS: "preview.example.test,other.example.test",
        GITHUB_SHA: "abcdef1234567890"
    };
}

test("isolated environment gate accepts an explicitly separated test configuration", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const config = validateIsolatedEnvironment(validEnvironment());
    assert.equal(config.databaseName, "project_integration_test");
    assert.equal(config.publicBaseUrl, "https://preview.example.test");
    assert.deepEqual(config.allowedHosts, ["other.example.test", "preview.example.test"]);
    assert.equal(config.guildId, "123456789012345678");
});

test("isolated environment gate rejects missing confirmation, production reuse, and non-test databases", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const missingConfirmation = validEnvironment();
    delete missingConfirmation.TEST_ENVIRONMENT_CONFIRMATION;
    assert.throws(() => validateIsolatedEnvironment(missingConfirmation), /CONFIRMATION_REQUIRED/);

    const productionReuse = validEnvironment();
    productionReuse.PUBLIC_BASE_URL = "https://preview.example.test";
    assert.throws(() => validateIsolatedEnvironment(productionReuse), /MUST_DIFFER_FROM_PRODUCTION/);

    const productionDatabase = validEnvironment();
    productionDatabase.TEST_MONGO_URI = "mongodb://mongo.example.test/production";
    assert.throws(() => validateIsolatedEnvironment(productionDatabase), /DATABASE_NAME_REQUIRED/);
});

test("isolated environment gate validates exact host allowlisting and Discord snowflakes", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const wrongHost = validEnvironment();
    wrongHost.TEST_ALLOWED_HOSTS = "example.test";
    assert.throws(() => validateIsolatedEnvironment(wrongHost), /HOST_NOT_ALLOWLISTED/);

    const invalidGuild = validEnvironment();
    invalidGuild.TEST_GUILD_ID = "not-a-snowflake";
    assert.throws(() => validateIsolatedEnvironment(invalidGuild), /INVALID_TEST_GUILD_ID/);

    assert.deepEqual([...exactAllowedHosts("B.EXAMPLE.test,a.example.test,b.example.test")].sort(), [
        "a.example.test",
        "b.example.test"
    ]);
});

test("environment gate evidence redacts credentials and hashes identifiers", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const config = validateIsolatedEnvironment(validEnvironment());
    const message = `failed ${config.mongoUri} ${config.botToken} ${config.clientSecret}`;
    const redacted = redactSecrets(message, config);
    assert.equal(redacted.includes(config.mongoUri), false);
    assert.equal(redacted.includes(config.botToken), false);
    assert.equal(redacted.includes(config.clientSecret), false);
    assert.equal((redacted.match(/\[REDACTED\]/g) || []).length, 3);
    assert.match(hashIdentifier(config.guildId), /^[a-f0-9]{16}$/);
    assert.notEqual(hashIdentifier(config.guildId), config.guildId);
});

test("Mongo database name parser handles standard and SRV connection strings", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(databaseNameFromMongoUri("mongodb://localhost:27017/project_test?x=1"), "project_test");
    assert.equal(databaseNameFromMongoUri("mongodb+srv://user:pass@example.test/sandbox%2Ddb"), "sandbox-db");
    assert.equal(databaseNameFromMongoUri("mongodb://localhost:27017"), "");
});
