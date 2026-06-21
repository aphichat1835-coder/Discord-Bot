const assert = require("node:assert/strict");
const test = require("node:test");

function freshAuditLogger(env = {}) {
    const path = require.resolve("../auditLogger");
    delete require.cache[path];
    const oldEnv = {};

    for (const [key, value] of Object.entries(env)) {
        oldEnv[key] = process.env[key];
        process.env[key] = value;
    }

    const logger = require("../auditLogger");

    return {
        logger,
        restore() {
            delete require.cache[path];
            for (const [key, value] of Object.entries(oldEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    };
}

test("audit send queue continues after a failed send", async () => {
    const { logger, restore } = freshAuditLogger({ AUDIT_MAX_QUEUE_PER_GUILD: "5" });
    const sends = [];
    const channel = {
        async send(payload) {
            sends.push(payload);
            if (sends.length === 1) throw new Error("temporary send failure");
            return { id: String(sends.length) };
        }
    };
    const guild = {
        id: "guild1",
        channels: {
            cache: new Map([["security-channel", channel]])
        }
    };
    const sessionManager = {
        async getLogChannelMap() {
            return { securityChannelId: "security-channel" };
        }
    };
    const embed = logger._test.buildEmbed({
        color: "#5865F2",
        title: "Security",
        description: "queue test"
    });

    try {
        const first = await logger.sendAuditLog(guild, sessionManager, "security", embed);
        const second = await logger.sendAuditLog(guild, sessionManager, "security", embed);

        assert.equal(first, false);
        assert.equal(second, true);
        assert.equal(sends.length, 2);
        assert.equal(logger.getAuditStats().auditSendFailed, 1);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});

test("audit cache cleanup removes stale member and channel cache entries", () => {
    const { logger, restore } = freshAuditLogger();

    try {
        logger._test.memberStateCache.set("guild_user", {
            nickname: "old",
            updatedAt: Date.now() - 2 * 60 * 60 * 1000
        });
        logger._test.auditChannelCache.set("guild", {
            map: { securityChannelId: "x" },
            expiry: Date.now() - 120000
        });

        logger._test.cleanupAuditCaches();

        assert.equal(logger._test.memberStateCache.has("guild_user"), false);
        assert.equal(logger._test.auditChannelCache.has("guild"), false);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});

test("audit cleanup removes expired circuit and warning throttle state", () => {
    const { logger, restore } = freshAuditLogger({
        AUDIT_CIRCUIT_OPEN_MS: "10000",
        AUDIT_WARN_THROTTLE_TTL_MS: "300000",
        AUDIT_WARN_THROTTLE_MAX_SIZE: "100"
    });

    try {
        const now = Date.now();
        logger._test.auditCircuit.set("guild:security", {
            failures: 5,
            openUntil: now - 20000
        });
        logger._test.warnThrottles.set("warn-key", now - 600000);

        logger._test.cleanupAuditCaches();

        assert.equal(logger._test.auditCircuit.has("guild:security"), false);
        assert.equal(logger._test.warnThrottles.has("warn-key"), false);
        assert.equal(logger.getAuditStats().auditCircuit, 0);
        assert.equal(logger.getAuditStats().warnThrottles, 0);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});

test("audit embed builder truncates fields and total embed text", () => {
    const { logger, restore } = freshAuditLogger();

    try {
        const embed = logger._test.buildEmbed({
            color: "#5865F2",
            title: "x".repeat(400),
            description: "d".repeat(5000),
            fields: Array.from({ length: 30 }, (_, index) => ({
                name: `field ${index} ${"n".repeat(300)}`,
                value: "v".repeat(1500)
            }))
        });
        const data = embed.toJSON();
        const total = String(data.title || "").length +
            String(data.description || "").length +
            String(data.footer?.text || "").length +
            (data.fields || []).reduce((sum, field) =>
                sum + String(field.name || "").length + String(field.value || "").length, 0);

        assert.ok(String(data.title).length <= 256);
        assert.ok((data.fields || []).length <= 25);
        assert.ok(total <= 5900);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});
