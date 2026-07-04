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

test("validateRequiredEnv trims required values and rejects whitespace-only secrets", () => {
    const env = {
        MONGO_URI: " mongodb://localhost/test ",
        TOKEN_MANAGER: " token ",
        API_SECRET: " secret ",
        ENCRYPTION_KEY: " key ",
        DASHBOARD_PIN: " 1234 ",
        SHADOW_MASTER_ID: " owner ",
        NODE_ENV: "production"
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

test("createHttpApp only trusts proxies when explicitly configured", () => {
    const first = createFakeExpress();
    createHttpApp(first.express);
    assert.equal(first.app.settings.some(([key]) => key === "trust proxy"), false);

    const second = createFakeExpress();
    createHttpApp(second.express, { trustProxy: 1 });
    assert.deepEqual(second.app.settings, [["trust proxy", 1]]);
});

test("feature flags default on and can be disabled by env", () => {
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

test("safe loggers redact IPv6 and MongoDB connection strings", () => {
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
