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
    const { logger, restore } = freshAuditLogger({ LOG_CORE_MAX_QUEUE_PER_GUILD: "5" });
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
        category: "security",
        severity: "info",
        title: "Security",
        description: "queue test"
    });

    try {
        const first = await logger.sendAuditLog(guild, sessionManager, "security", embed);
        const second = await logger.sendAuditLog(guild, sessionManager, "security", embed);

        assert.equal(first, false);
        assert.equal(second, true);
        assert.equal(sends.length, 2);
        assert.equal(logger.getAuditStats().failed, 1);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});

test("audit cleanup removes stale duplicate keys and expired message snapshots", () => {
    const { logger, restore } = freshAuditLogger();

    try {
        logger._test.recentEventKeys.set("stale", Date.now() - 11 * 60 * 1000);
        const cache = logger._test.defaultMessageSnapshots;
        cache.cache.set(cache.key("guild", "message"), {
            messageId: "message",
            guildId: "guild",
            channelId: "channel",
            content: "old",
            cachedAt: Date.now() - cache.ttlMs - 1000
        });

        logger._test.cleanupCaches();

        assert.equal(logger._test.recentEventKeys.has("stale"), false);
        assert.equal(cache.get("guild", "message"), null);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});

test("audit embed builder truncates fields and total embed text", () => {
    const { logger, restore } = freshAuditLogger();

    try {
        const embed = logger._test.buildEmbed({
            category: "message",
            severity: "info",
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
            String(data.author?.name || "").length +
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

test("audit send stores gateway records for audit API reads", async () => {
    const { logger, restore } = freshAuditLogger();
    const data = {};
    const sends = [];
    const channel = { send: async payload => sends.push(payload) };
    const guild = {
        id: "guild1",
        channels: { cache: new Map([["security-channel", channel]]) }
    };
    const sessionManager = {
        async getLogChannelMap() {
            return { securityChannelId: "security-channel" };
        },
        async getSetting(key, fallback) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
        },
        async setSetting(key, value) {
            data[key] = value;
            return true;
        }
    };
    const embed = logger._test.buildEmbed({
        category: "security",
        severity: "danger",
        title: "Security Event",
        description: "stored for dashboard"
    });

    try {
        const ok = await logger.sendAuditLog(guild, sessionManager, "security", embed, {
            actionType: "SECURITY_EVENT",
            severity: "danger"
        });
        assert.equal(ok, true);
        assert.equal(sends.length, 1);
        const index = data.audit_event_index_guild1;
        assert.equal(index.length, 1);
        const record = data[`audit_event_guild1_${index[0]}`];
        assert.equal(record.actionType, "SECURITY_EVENT");
        assert.equal(record.category, "security");
        assert.equal(record.severity, "danger");
        assert.match(record.summary, /Security Event/);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});

test("audit settings disabled category prevents gateway send and storage", async () => {
    const { logger, restore } = freshAuditLogger();
    const data = {
        audit_settings_guild1: {
            categories: { security: false }
        }
    };
    const sends = [];
    const guild = {
        id: "guild1",
        channels: { cache: new Map([["security-channel", { send: async payload => sends.push(payload) }]]) }
    };
    const sessionManager = {
        async getLogChannelMap() {
            return { securityChannelId: "security-channel" };
        },
        async getSetting(key, fallback) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
        },
        async setSetting(key, value) {
            data[key] = value;
            return true;
        }
    };
    const embed = logger._test.buildEmbed({ category: "security", title: "Hidden" });

    try {
        const ok = await logger.sendAuditLog(guild, sessionManager, "security", embed);
        assert.equal(ok, false);
        assert.equal(sends.length, 0);
        assert.equal(data.audit_event_index_guild1, undefined);
        assert.equal(logger.getAuditStats().skippedBySettings, 1);
    } finally {
        logger.stopAuditCleanup();
        restore();
    }
});
