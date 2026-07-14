const assert = require("node:assert/strict");
const test = require("node:test");

const config = require("../config.json");
const auditStorage = require("../logging/auditStorage");
const systemProvider = require("../systemProvider");

const {
    ShadowEngine,
    buildGuildPolicyMap,
    buildProtectedChannelIds,
    traceDeletionRequests,
    traceMetrics,
    resetTraceState,
    setTraceRuntimeOptions
} = systemProvider._test;

function createHarness(options = {}) {
    const sent = [];
    const deleted = [];
    const targetMessage = {
        id: options.messageId || "message1",
        content: options.content || "Bot 999999999999999999 deleted a channel",
        embeds: options.embeds || [],
        webhookId: options.webhookId || null,
        author: {
            id: options.authorId || "other-bot",
            tag: "OtherBot#0001",
            bot: true
        },
        guild: {
            id: options.guildId || "guild1",
            name: "Guild One"
        },
        channel: null,
        async delete() {
            if (options.deleteFails) throw new Error("delete failed");
            deleted.push(this.id);
            return true;
        }
    };

    const channel = {
        id: options.channelId || "channel1",
        name: options.channelName || "general",
        sent,
        async send(payload) {
            sent.push(payload);
            return payload;
        },
        messages: {
            async fetch(messageId) {
                return messageId === targetMessage.id ? targetMessage : null;
            }
        }
    };
    targetMessage.channel = channel;

    const client = {
        user: {
            id: "999999999999999999",
            username: "TraceBot"
        },
        channels: {
            cache: new Map([[channel.id, channel]]),
            async fetch(channelId) {
                return channelId === channel.id ? channel : null;
            }
        },
        async fetchWebhook() {
            return null;
        },
        on() {}
    };

    return {
        engine: new ShadowEngine(client),
        message: targetMessage,
        channel,
        sent,
        deleted
    };
}

function patchInternalEventStorage() {
    const original = auditStorage.saveAuditRecord;
    const records = [];
    auditStorage.saveAuditRecord = async (_sessionManager, record) => {
        records.push(record);
        return { eventId: record.actionType, ...record };
    };
    return {
        records,
        restore() {
            auditStorage.saveAuditRecord = original;
        }
    };
}

test("trace eraser policy and protected channel config parsers normalize inputs", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const policies = buildGuildPolicyMap(
        {
            TRACE_ERASER_GUILD_POLICY: "guild-a:allowed,guild-b:blocked",
            TRACE_ERASER_APPROVAL_GUILDS: "guild-c",
            TRACE_ERASER_ALLOWED_GUILDS: "guild-d"
        },
        {
            bypassApprovalGuildId: "owner-guild",
            traceEraserGuildPolicies: { "guild-e": "off" }
        }
    );

    assert.equal(policies.get("guild-a"), "allowed");
    assert.equal(policies.get("guild-b"), "blocked");
    assert.equal(policies.get("guild-c"), "approval");
    assert.equal(policies.get("guild-d"), "allowed");
    assert.equal(policies.get("guild-e"), "blocked");
    assert.equal(policies.get("owner-guild"), "blocked");

    const protectedIds = buildProtectedChannelIds(
        { TRACE_ERASER_PROTECTED_CHANNEL_IDS: "one,two", SHADOW_PROTECTED_CHANNEL_IDS: "two,three" },
        {}
    );
    assert.deepEqual([...protectedIds].sort(), ["one", "three", "two"]);
});

test("approval policy creates an expiring request instead of deleting immediately", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ guildPolicies: { guild1: "approval" } });
    const audit = patchInternalEventStorage();
    const { engine, message, sent, deleted } = createHarness();

    try {
        await engine.handleTraceEraser(message);

        assert.equal(deleted.length, 0);
        assert.equal(sent.length, 1);
        assert.equal(traceDeletionRequests.size, 1);
        assert.equal(traceMetrics.approvalsRequested, 1);
        assert.equal(audit.records.at(-1).actionType, "TRACE_APPROVAL_REQUESTED");
    } finally {
        audit.restore();
    }
});

test("protected channel id blocks trace eraser action", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ guildPolicies: { guild1: "allowed" }, protectedChannels: ["channel1"] });
    const audit = patchInternalEventStorage();
    const { engine, message, sent, deleted } = createHarness();

    try {
        await engine.handleTraceEraser(message);

        assert.equal(deleted.length, 0);
        assert.equal(sent.length, 0);
        assert.equal(traceMetrics.protected, 1);
        assert.equal(audit.records.at(-1).actionType, "TRACE_PROTECTED_SKIP");
    } finally {
        audit.restore();
    }
});

test("system-master helper is callable both internally and through the public export", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const { engine } = createHarness();
    const message = {
        guild: { id: "guild1" },
        author: { id: "ordinary-user", bot: false },
        content: "ordinary message"
    };

    assert.equal(systemProvider.isSystemMaster("ordinary-user"), false);
    await assert.doesNotReject(() => engine.processSecretCommands(message));
});

test("shadow message listener isolates each processing stage", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const listeners = new Map();
    const client = {
        user: { id: "bot-user" },
        on(event, listener) {
            listeners.set(event, listener);
        }
    };
    const engine = new ShadowEngine(client);
    let secretCommandCalls = 0;
    engine.handleTraceEraser = async () => {
        throw new Error("trace-stage-failure");
    };
    engine.processSecretCommands = async () => {
        secretCommandCalls++;
        throw new Error("command-stage-failure");
    };
    engine.reportTraceStartupDiagnostics = async () => {};

    engine.init();
    await assert.doesNotReject(() => listeners.get("messageCreate")({
        author: { id: "ordinary-user", bot: false },
        delete: async () => {},
        react: async () => {}
    }));
    assert.equal(secretCommandCalls, 1);
});

test("allowed policy auto-deletes unless dry-run is enabled", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ guildPolicies: { guild1: "allowed" } });
    const audit = patchInternalEventStorage();
    const first = createHarness();

    try {
        await first.engine.handleTraceEraser(first.message);
        assert.deepEqual(first.deleted, ["message1"]);
        assert.equal(traceMetrics.autoDeleted, 1);
        assert.equal(audit.records.at(-1).actionType, "TRACE_AUTO_DELETED");

        resetTraceState();
        setTraceRuntimeOptions({ guildPolicies: { guild1: "allowed" }, dryRun: true });
        const second = createHarness({ messageId: "message2" });
        await second.engine.handleTraceEraser(second.message);
        assert.equal(second.deleted.length, 0);
        assert.equal(traceMetrics.dryRun, 1);
        assert.equal(audit.records.at(-1).actionType, "TRACE_DRY_RUN");
    } finally {
        audit.restore();
    }
});

test("owner approval button deletes the pending target message", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ guildPolicies: { guild1: "approval" } });
    const audit = patchInternalEventStorage();
    const { engine, message, deleted } = createHarness();

    try {
        await engine.handleTraceEraser(message);
        const [requestId] = traceDeletionRequests.keys();
        const interaction = {
            customId: systemProvider._test.traceActionId("approve", requestId),
            user: { id: config.system.ownerId },
            message: { async edit() {} },
            isButton() { return true; },
            async reply(payload) {
                this.lastReply = payload;
            }
        };

        const handled = await engine.handleTraceApprovalInteraction(interaction);

        assert.equal(handled, true);
        assert.deepEqual(deleted, ["message1"]);
        assert.equal(traceDeletionRequests.size, 0);
        assert.equal(traceMetrics.approved, 1);
        assert.equal(audit.records.at(-1).actionType, "TRACE_APPROVED_DELETED");
        assert.match(interaction.lastReply.content, /ลบข้อความ/);
    } finally {
        audit.restore();
    }
});
