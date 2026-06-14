const assert = require("node:assert/strict");
const test = require("node:test");

const { parseEnvLine, loadEnvFile } = require("../core/loadEnv");

test("parseEnvLine handles comments, quotes, and invalid keys", () => {
    assert.equal(parseEnvLine("# comment"), null);
    assert.equal(parseEnvLine(""), null);
    assert.equal(parseEnvLine("1BAD=value"), null);
    assert.deepEqual(parseEnvLine("TOKEN_MANAGER=abc"), ["TOKEN_MANAGER", "abc"]);
    assert.deepEqual(parseEnvLine("API_SECRET='secret value'"), ["API_SECRET", "secret value"]);
    assert.deepEqual(parseEnvLine('DASHBOARD_PIN="123456"'), ["DASHBOARD_PIN", "123456"]);
});

test("loadEnvFile loads missing values without overriding existing env", () => {
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
