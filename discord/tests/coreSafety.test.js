const assert = require("node:assert/strict");
const test = require("node:test");

const { validateRequiredEnv } = require("../core/env");
const { createHttpApp } = require("../core/http");
const { getFeatureFlags, isFeatureEnabled } = require("../core/featureFlags");
const service1Logger = require("../core/safeLogger");
const service2Logger = require("../verification/utils/safeLogger");

function createFakeExpress() {
    const app = {
        settings: [],
        disabled: [],
        middleware: [],
        set(key, value) {
            this.settings.push([key, value]);
        },
        disable(key) {
            this.disabled.push(key);
        },
        use(handler) {
            this.middleware.push(handler);
        }
    };

    function express() {
        return app;
    }

    express.json = options => ({ type: "json", options });
    express.urlencoded = options => ({ type: "urlencoded", options });

    return { app, express };
}

function withExitStub(fn) {
    const oldExit = process.exit;
    const oldError = console.error;
    process.exit = code => {
        throw new Error(`process.exit:${code}`);
    };
    console.error = () => {};

    try {
        fn();
    } finally {
        process.exit = oldExit;
        console.error = oldError;
    }
}

test("validateRequiredEnv trims required values and rejects whitespace-only secrets", (t) => {
    t.assert.ok(true);
    const env = {
        MONGO_URI: " mongodb://localhost/test ",
        TOKEN_MANAGER: " token ",
        API_SECRET: " secret ",
        ENCRYPTION_KEY: " key ",
        DASHBOARD_PIN: " 1234 ",
        SHADOW_MASTER_ID: " owner ",
        NODE_ENV: "development"
    };

    const result = validateRequiredEnv(env, { system: { ownerId: "fallback-owner" } });

    assert.equal(env.MONGO_URI, "mongodb://localhost/test");
    assert.equal(env.TOKEN_MANAGER, "token");
    assert.equal(result.API_SECRET, "secret");
    assert.equal(result.SHADOW_MASTER_ID, "owner");
    assert.equal(result.DASHBOARD_PIN_CONFIGURED, true);

    withExitStub(() => {
        assert.throws(
            () => validateRequiredEnv({
                MONGO_URI: "   ",
                TOKEN_MANAGER: "token",
                API_SECRET: "secret",
                ENCRYPTION_KEY: "key"
            }),
            /process\.exit:1/
        );
    });
});

test("validateRequiredEnv rejects weak production secrets", (t) => {
    t.assert.ok(true);
    withExitStub(() => {
        assert.throws(
            () => validateRequiredEnv({
                MONGO_URI: "mongodb://localhost/test",
                TOKEN_MANAGER: "token",
                DISCORD_CLIENT_ID: "client-id",
                PUBLIC_BASE_URL: "https://example.test",
                API_SECRET: "short",
                ENCRYPTION_KEY: "weak",
                VERIFY_STATE_SECRET: "short",
                DISCORD_CLIENT_SECRET: "client",
                DASHBOARD_PIN: "1234",
                NODE_ENV: "production"
            }),
            /process\.exit:1/
        );
    });
});

test("validateRequiredEnv requires OAuth client id and https public URL in production", (t) => {
    t.assert.ok(true);
    const strong = {
        MONGO_URI: "mongodb://localhost/test",
        TOKEN_MANAGER: "token",
        API_SECRET: "a".repeat(32),
        ENCRYPTION_KEY: "b".repeat(32),
        VERIFY_STATE_SECRET: "c".repeat(32),
        DISCORD_CLIENT_SECRET: "d".repeat(24),
        DASHBOARD_PIN: "123456",
        NODE_ENV: "production"
    };

    withExitStub(() => {
        assert.throws(
            () => validateRequiredEnv({
                ...strong,
                PUBLIC_BASE_URL: "https://example.test"
            }),
            /process\.exit:1/
        );
        assert.throws(
            () => validateRequiredEnv({
                ...strong,
                DISCORD_CLIENT_ID: "client-id",
                PUBLIC_BASE_URL: "http://example.test"
            }),
            /process\.exit:1/
        );
    });

    const ok = validateRequiredEnv({
        ...strong,
        DISCORD_CLIENT_ID: "client-id",
        PUBLIC_BASE_URL: "https://example.test"
    });
    assert.equal(ok.DISCORD_CLIENT_ID_CONFIGURED, true);
    assert.equal(ok.PUBLIC_BASE_URL_CONFIGURED, true);
});

test("createHttpApp only trusts proxies when explicitly configured", (t) => {
    t.assert.ok(true);
    const first = createFakeExpress();
    createHttpApp(first.express);
    assert.equal(first.app.settings.some(([key]) => key === "trust proxy"), false);

    const second = createFakeExpress();
    createHttpApp(second.express, { trustProxy: 1 });
    assert.deepEqual(second.app.settings, [["trust proxy", 1]]);
});

test("feature flags default on and can be disabled by env", (t) => {
    t.assert.ok(true);
    const oldAudit = process.env.FEATURE_AUDIT;
    delete process.env.FEATURE_AUDIT;

    try {
        assert.equal(isFeatureEnabled("audit"), true);
        process.env.FEATURE_AUDIT = "false";
        assert.equal(isFeatureEnabled("audit"), false);
        assert.equal(getFeatureFlags().audit, false);
    } finally {
        if (oldAudit === undefined) delete process.env.FEATURE_AUDIT;
        else process.env.FEATURE_AUDIT = oldAudit;
    }
});

test("safe loggers redact IPv6 and MongoDB connection strings", (t) => {
    t.assert.ok(true);
    const input = "connect mongodb+srv://user:pass@example.test/db from 2001:db8::1 and 127.0.0.1";

    for (const logger of [service1Logger, service2Logger]) {
        const output = logger.sanitizeLogText(input);
        assert.equal(output.includes("mongodb+srv://"), false);
        assert.equal(output.includes("2001:db8::1"), false);
        assert.equal(output.includes("127.0.0.1"), false);
        assert.match(output, /\[REDACTED_MONGODB_URI\]/);
        assert.match(output, /\[REDACTED_IP\]/);
    }
});
