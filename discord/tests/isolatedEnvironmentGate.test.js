"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
    databaseNameFromMongoUri,
    exactAllowedHosts,
    exactSnowflakeSet,
    assertCurrentCheckoutSha,
    hashIdentifier,
    persistGateRecord,
    redactSecrets,
    runIsolatedEnvironmentGate,
    validateIsolatedEnvironment
} = require("../../scripts/runIsolatedEnvironmentGate");

function validEnvironment() {
    return {
        TEST_ENVIRONMENT_CONFIRMATION: "ISOLATED_TEST_ONLY",
        TEST_COMMIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
        TEST_MONGO_URI: "mongodb://gate_user:gate_password@mongo.example.test/project_integration_test?retryWrites=false",
        TEST_DISCORD_TOKEN: "test-bot-token-value-not-a-real-token",
        TEST_GUILD_ID: "123456789012345678",
        TEST_TEXT_CHANNEL_ID: "223456789012345678",
        TEST_VOICE_CHANNEL_ID: "323456789012345678",
        TEST_DISCORD_CLIENT_ID: "423456789012345678",
        TEST_DISCORD_CLIENT_SECRET: "test-client-secret-value",
        TEST_PUBLIC_BASE_URL: "https://preview.example.test/",
        TEST_ALLOWED_HOSTS: "preview.example.test,other.example.test",
        PRODUCTION_PUBLIC_BASE_URL: "https://production.example.test",
        PRODUCTION_DISCORD_CLIENT_IDS: "523456789012345678",
        PRODUCTION_GUILD_IDS: "623456789012345678",
        PRODUCTION_CHANNEL_IDS: "723456789012345678,823456789012345678"
    };
}

test("isolated environment gate accepts an explicitly separated test configuration", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const config = validateIsolatedEnvironment(validEnvironment());
    assert.equal(config.databaseName, "project_integration_test");
    assert.equal(config.publicBaseUrl, "https://preview.example.test");
    assert.equal(config.productionOrigin, "https://production.example.test");
    assert.equal(config.commitSha, "abcdef1234567890abcdef1234567890abcdef12");
    assert.deepEqual(config.allowedHosts, ["other.example.test", "preview.example.test"]);
    assert.equal(config.guildId, "123456789012345678");
    assert.deepEqual(config.productionResourceCounts, { clients: 1, guilds: 1, channels: 2 });
});

test("isolated environment gate rejects missing confirmation, production reuse, and non-test databases", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const missingConfirmation = validEnvironment();
    delete missingConfirmation.TEST_ENVIRONMENT_CONFIRMATION;
    assert.throws(() => validateIsolatedEnvironment(missingConfirmation), /CONFIRMATION_REQUIRED/);

    const productionReuse = validEnvironment();
    productionReuse.PRODUCTION_PUBLIC_BASE_URL = "https://preview.example.test";
    assert.throws(() => validateIsolatedEnvironment(productionReuse), /MUST_DIFFER_FROM_PRODUCTION/);

    const missingProductionOrigin = validEnvironment();
    delete missingProductionOrigin.PRODUCTION_PUBLIC_BASE_URL;
    assert.throws(() => validateIsolatedEnvironment(missingProductionOrigin), /MISSING_TEST_ENVIRONMENT/);

    const productionDatabase = validEnvironment();
    productionDatabase.TEST_MONGO_URI = "mongodb://mongo.example.test/production";
    assert.throws(() => validateIsolatedEnvironment(productionDatabase), /DATABASE_NAME_REQUIRED/);
});

test("isolated environment gate validates exact SHA, exact host allowlisting, and Discord snowflakes", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const invalidSha = validEnvironment();
    invalidSha.TEST_COMMIT_SHA = "abcdef";
    assert.throws(() => validateIsolatedEnvironment(invalidSha), /INVALID_TEST_COMMIT_SHA/);

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
    assert.deepEqual([...exactSnowflakeSet("123456789012345678,123456789012345678", "TEST_IDS")], [
        "123456789012345678"
    ]);
    assert.throws(() => exactSnowflakeSet("invalid", "TEST_IDS"), /INVALID_TEST_IDS/);
});

test("isolated environment gate rejects production Discord application, guild, and channel reuse", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const clientReuse = validEnvironment();
    clientReuse.PRODUCTION_DISCORD_CLIENT_IDS = clientReuse.TEST_DISCORD_CLIENT_ID;
    assert.throws(() => validateIsolatedEnvironment(clientReuse), /CLIENT_MUST_DIFFER_FROM_PRODUCTION/);

    const guildReuse = validEnvironment();
    guildReuse.PRODUCTION_GUILD_IDS = guildReuse.TEST_GUILD_ID;
    assert.throws(() => validateIsolatedEnvironment(guildReuse), /GUILD_MUST_DIFFER_FROM_PRODUCTION/);

    const textChannelReuse = validEnvironment();
    textChannelReuse.PRODUCTION_CHANNEL_IDS = textChannelReuse.TEST_TEXT_CHANNEL_ID;
    assert.throws(() => validateIsolatedEnvironment(textChannelReuse), /CHANNELS_MUST_DIFFER_FROM_PRODUCTION/);

    const voiceChannelReuse = validEnvironment();
    voiceChannelReuse.PRODUCTION_CHANNEL_IDS = voiceChannelReuse.TEST_VOICE_CHANNEL_ID;
    assert.throws(() => validateIsolatedEnvironment(voiceChannelReuse), /CHANNELS_MUST_DIFFER_FROM_PRODUCTION/);
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

test("record persistence failure is reported without escaping the helper", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const messages = [];
    const config = validateIsolatedEnvironment(validEnvironment());
    const result = persistGateRecord(config, { status: "failed" }, {
        writer() {
            throw new Error(`cannot write ${config.mongoUri}`);
        },
        logger: {
            log() {},
            error(message) { messages.push(message); }
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ENV_GATE_RECORD_WRITE_FAILED");
    assert.equal(result.error.message.includes(config.mongoUri), false);
    assert.match(messages[0], /record write failed/);
    assert.equal(messages[0].includes(config.mongoUri), false);
});

test("missing environment still persists a redacted failure record", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const records = [];
    const env = {
        TEST_ENVIRONMENT_CONFIRMATION: "ISOLATED_TEST_ONLY",
        TEST_COMMIT_SHA: "abcdef1234567890abcdef1234567890abcdef12"
    };

    await assert.rejects(
        runIsolatedEnvironmentGate(env, {
            writer(_config, record) {
                records.push(structuredClone(record));
                return "memory://environment-gate.json";
            },
            logger: { log() {}, error() {} }
        }),
        /MISSING_TEST_ENVIRONMENT/
    );

    assert.equal(records.length, 1);
    assert.equal(records[0].status, "failed");
    assert.equal(records[0].errorCode, "MISSING_TEST_ENVIRONMENT");
    assert.ok(records[0].missing.includes("TEST_MONGO_URI"));
    assert.equal(JSON.stringify(records[0]).includes("test-bot-token-value-not-a-real-token"), false);
});

test("SHA mismatch persists evidence before external checks run", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const records = [];
    let externalCalls = 0;
    await assert.rejects(
        runIsolatedEnvironmentGate(validEnvironment(), {
            currentCheckoutSha: () => "1111111111111111111111111111111111111111",
            runMongoGate: async () => { externalCalls++; },
            writer(_config, record) {
                records.push(structuredClone(record));
                return "memory://environment-gate.json";
            },
            logger: { log() {}, error() {} }
        }),
        error => error?.code === "TEST_COMMIT_SHA_MISMATCH"
    );

    assert.equal(externalCalls, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].errorCode, "TEST_COMMIT_SHA_MISMATCH");
});

test("record writer failure does not replace the primary gate error", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await assert.rejects(
        runIsolatedEnvironmentGate(validEnvironment(), {
            currentCheckoutSha: () => "1111111111111111111111111111111111111111",
            writer() { throw new Error("writer failed"); },
            logger: { log() {}, error() {} }
        }),
        error => {
            assert.equal(error.code, "TEST_COMMIT_SHA_MISMATCH");
            assert.match(error.recordPersistenceError, /writer failed/);
            return true;
        }
    );
});

test("record writer failure becomes primary only after a successful gate", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const success = async () => ({ ok: true });
    await assert.rejects(
        runIsolatedEnvironmentGate(validEnvironment(), {
            currentCheckoutSha: () => validEnvironment().TEST_COMMIT_SHA,
            runMongoGate: success,
            requestClientCredentials: success,
            runDiscordBotGate: success,
            runDeploymentSmoke: success,
            writer() { throw new Error("writer failed"); },
            logger: { log() {}, error() {} }
        }),
        error => error?.code === "ENV_GATE_RECORD_WRITE_FAILED"
    );
});

test("checkout SHA validation accepts only the exact expected commit", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const expected = validEnvironment().TEST_COMMIT_SHA;
    assert.equal(assertCurrentCheckoutSha(expected, { currentCheckoutSha: () => expected }), expected);
    assert.throws(
        () => assertCurrentCheckoutSha(expected, { currentCheckoutSha: () => "invalid" }),
        /INVALID_CURRENT_COMMIT_SHA/
    );
});

test("Mongo database name parser handles standard and SRV connection strings", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(databaseNameFromMongoUri("mongodb://localhost:27017/project_test?x=1"), "project_test");
    assert.equal(databaseNameFromMongoUri("mongodb+srv://user:pass@example.test/sandbox%2Ddb"), "sandbox-db");
    assert.equal(databaseNameFromMongoUri("mongodb://localhost:27017"), "");
});

test("isolated environment workflow cannot be disabled for PR 71", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const workflow = fs.readFileSync(
        path.join(__dirname, "../../.github/workflows/isolated-environment-gate.yml"),
        "utf8"
    );
    assert.doesNotMatch(workflow, /RUN_ISOLATED_ENVIRONMENT_GATE/);
    assert.match(workflow, /github\.head_ref == ['"]ttt\.1['"]/);
    assert.match(workflow, /workflow_dispatch/);
    assert.match(workflow, /Initialize redacted environment record/);
    assert.doesNotMatch(workflow, /test -n "\$TEST_MONGO_URI"/);
});
