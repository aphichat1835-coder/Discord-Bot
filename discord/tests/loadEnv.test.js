const assert = require("node:assert/strict");
const test = require("node:test");

const {
    deleteBlankEnvironmentValues,
    loadEnvFile,
    parseEnvLine
} = require("../core/loadEnv");

test("parseEnvLine handles comments, quotes, and invalid keys", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(parseEnvLine("# comment"), null);
    assert.equal(parseEnvLine(""), null);
    assert.equal(parseEnvLine("1BAD=value"), null);
    assert.deepEqual(parseEnvLine("TOKEN_MANAGER=abc"), ["TOKEN_MANAGER", "abc"]);
    assert.deepEqual(parseEnvLine("API_SECRET='secret value'"), ["API_SECRET", "secret value"]);
    assert.deepEqual(parseEnvLine('DASHBOARD_PIN="123456"'), ["DASHBOARD_PIN", "123456"]);
});

test("loadEnvFile loads missing values without overriding existing env", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const env = { TOKEN_MANAGER: "host-token" };
    const fakeFs = {
        existsSync() {
            return true;
        },
        readFileSync() {
            return "TOKEN_MANAGER=file-token\nAPI_SECRET=file-secret\n";
        }
    };
    const loaded = loadEnvFile(".env", env, fakeFs);

    assert.equal(loaded, 1);
    assert.equal(env.TOKEN_MANAGER, "host-token");
    assert.equal(env.API_SECRET, "file-secret");
});

test("blank environment values become absent while explicit zero remains configured", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const env = {
        SESSION_LOAD_MAX: "   ",
        WEBHOOK_CONCURRENCY: "0",
        TEXT_VALUE: " value "
    };
    assert.equal(deleteBlankEnvironmentValues(env), 1);
    assert.equal(Object.hasOwn(env, "SESSION_LOAD_MAX"), false);
    assert.equal(env.WEBHOOK_CONCURRENCY, "0");
    assert.equal(env.TEXT_VALUE, " value ");
});

test("blank values loaded from a file are removed after normalization", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const env = {};
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => "LIMIT=0\nEMPTY=   \nNAME=bot\n"
    };
    assert.equal(loadEnvFile("/tmp/.env", env, fakeFs), 3);
    deleteBlankEnvironmentValues(env);
    assert.deepEqual(env, { LIMIT: "0", NAME: "bot" });
});