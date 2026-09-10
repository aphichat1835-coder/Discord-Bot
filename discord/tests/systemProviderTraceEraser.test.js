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

const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const MESSAGE_ID = "333333333333333333";
const AUTHOR_ID = "444444444444444444";
const BOT_ID = "999999999999999999";
const APPROVAL_CHANNEL_ID = "555555555555555555";

function createHarness(options = {}) {
    const sent = [];
    const approvalSent = [];
    const deleted = [];
    const listeners = new Map();
    const targetMessage = {
        id: options.messageId || MESSAGE_ID,
        content: options.content || `Bot ${BOT_ID} deleted a channel`,
        embeds: options.embeds || [],
        webhookId: options.webhookId || null,
        author: {
            id: options.authorId || AUTHOR_ID,
            tag: "OtherBot#0001",
            bot: true
        },
        guild: {
            id: options.guildId || GUILD_ID,
            name: "Guild One"
        },
        channel: null,
        async delete() {
            if (options.deleteGate) await options.deleteGate;
            if (options.deleteFails) throw new Error("delete failed");
            deleted.push(this.id);
            return true;
        }
    };

    const channel = {
        id: options.channelId || CHANNEL_ID,
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

    const approvalChannel = {
        id: APPROVAL_CHANNEL_ID,
        name: "private-approvals",
        sent: approvalSent,
        async send(payload) {
            approvalSent.push(payload);
            return payload;
        }
    };

    const channels = new Map([[channel.id, channel]]);
    if (options.secureApproval !== false) channels.set(approvalChannel.id, approvalChannel);

    const client = {
        user: {
            id: BOT_ID,
            username: "TraceBot"
        },
        channels: {
            cache: channels,
            async fetch(channelId) {
                return channels.get(channelId) || null;
            }
        },
        async fetchWebhook() {
            return null;
        },
        on(event, listener) {
            listeners.set(event, listener);
        },
        off(event, listener) {
            if (listeners.get(event) === listener) listeners.delete(event);
        }
    };

    const engine = new ShadowEngine(client);
    if (options.secureApproval !== false) engine.traceApprovalChannelId = approvalChannel.id;
    return {
        engine,
        message: targetMessage,
        channel,
        sent,
        approvalSent,
        deleted,
        listeners
    };
}

function patchAuditStorage(handler = null) {
    const original = auditStorage.saveAuditRecord;
    const records = [];
    auditStorage.saveAuditRecord = async (_sessionManager, record) => {
        records.push(record);
        if (handler) return handler(record);
        return { eventId: record.actionType, ...record };
    };
    return {
        records,
        restore() {
            auditStorage.saveAuditRecord = original;
        }
    };
}

test("trace policy and protected-channel parsers normalize configured values", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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

test("approval policy records audit then sends only to the configured secure destination", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ enabled: true, guildPolicies: { [GUILD_ID]: "approval" } });
    const audit = patchAuditStorage();
    const { engine, message, sent, approvalSent, deleted } = createHarness();

    try {
        await engine.handleTraceEraser(message);

        assert.equal(deleted.length, 0);
        assert.equal(sent.length, 0);
        assert.equal(approvalSent.length, 2);
        assert.match(approvalSent[0].content, /ตัวอย่าง/);
        assert.ok(approvalSent[1].embeds?.length);
        assert.equal(traceDeletionRequests.size, 1);
        assert.equal(traceMetrics.approvalsRequested, 1);
        assert.equal(audit.records[0].actionType, "TRACE_APPROVAL_REQUESTED");
        assert.equal(traceDeletionRequests.values().next().value.state, "pending");
    } finally {
        audit.restore();
    }
});

test("missing secure approval destination never falls back to the source channel", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ enabled: true, guildPolicies: { [GUILD_ID]: "approval" } });
    const audit = patchAuditStorage();
    const { engine, message, sent, deleted } = createHarness({ secureApproval: false });

    try {
        await engine.handleTraceEraser(message);
        assert.equal(sent.length, 0);
        assert.equal(deleted.length, 0);
        assert.equal(traceDeletionRequests.size, 0);
        assert.ok(audit.records.some(record => record.actionType === "TRACE_APPROVAL_DESTINATION_UNAVAILABLE"));
    } finally {
        audit.restore();
    }
});

test("trace preview preserves full owner-visible content in the secure approval destination", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ enabled: true, guildPolicies: { [GUILD_ID]: "approval" } });
    const audit = patchAuditStorage();
    const content = `Bot ${BOT_ID} deleted a channel token=abc.def.ghi email=test@example.com ip=203.0.113.9`;
    const { engine, message, approvalSent } = createHarness({ content });

    try {
        await engine.handleTraceEraser(message);
        const preview = approvalSent[0]?.content || "";
        assert.match(preview, /abc\.def\.ghi/);
        assert.match(preview, /test@example\.com/);
        assert.match(preview, /203\.0\.113\.9/);
    } finally {
        audit.restore();
    }
});

test("allowed deletion fails closed when audit intent cannot be persisted", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ enabled: true, guildPolicies: { [GUILD_ID]: "allowed" } });
    const audit = patchAuditStorage(() => null);
    const { engine, message, deleted } = createHarness();

    try {
        await engine.handleTraceEraser(message);
        assert.equal(deleted.length, 0);
        assert.equal(traceMetrics.autoDeleted, 0);
        assert.equal(audit.records[0].actionType, "TRACE_AUTO_DELETE_INTENT");
    } finally {
        audit.restore();
    }
});

test("allowed policy records intent before deleting and records the final result", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ enabled: true, guildPolicies: { [GUILD_ID]: "allowed" } });
    const audit = patchAuditStorage();
    const { engine, message, deleted } = createHarness();

    try {
        await engine.handleTraceEraser(message);
        assert.deepEqual(deleted, [MESSAGE_ID]);
        assert.equal(traceMetrics.autoDeleted, 1);
        assert.deepEqual(
            audit.records.map(record => record.actionType),
            ["TRACE_AUTO_DELETE_INTENT", "TRACE_AUTO_DELETED"]
        );
    } finally {
        audit.restore();
    }
});

test("approval request is claimed atomically so concurrent approvals delete once", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({ enabled: true, guildPolicies: { [GUILD_ID]: "approval" } });
    const audit = patchAuditStorage();
    let releaseDelete;
    const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
    const { engine, message, deleted } = createHarness({ deleteGate });

    function interaction(requestId) {
        return {
            customId: systemProvider._test.traceActionId("approve", requestId),
            user: { id: config.system.ownerId },
            message: { async edit() {} },
            isButton() { return true; },
            async reply(payload) { this.lastReply = payload; }
        };
    }

    try {
        await engine.handleTraceEraser(message);
        const [requestId] = traceDeletionRequests.keys();
        const first = interaction(requestId);
        const second = interaction(requestId);
        const firstRun = engine.handleTraceApprovalInteraction(first);
        await new Promise(resolve => setImmediate(resolve));
        const secondRun = engine.handleTraceApprovalInteraction(second);
        releaseDelete();
        await Promise.all([firstRun, secondRun]);

        assert.deepEqual(deleted, [MESSAGE_ID]);
        assert.equal(traceDeletionRequests.size, 0);
        assert.match(second.lastReply.content, /หมดอายุ|กำลังถูกจัดการ/);
        assert.ok(audit.records.some(record => record.actionType === "TRACE_APPROVED_DELETE_INTENT"));
        assert.ok(audit.records.some(record => record.actionType === "TRACE_APPROVED_DELETED"));
    } finally {
        audit.restore();
    }
});

test("protected message and repeated initialization remain safe", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    resetTraceState();
    setTraceRuntimeOptions({
        enabled: true,
        guildPolicies: { [GUILD_ID]: "allowed" },
        protectedChannels: [CHANNEL_ID]
    });
    const audit = patchAuditStorage();
    const { engine, message, listeners, deleted } = createHarness();

    try {
        engine.init();
        const firstListenerCount = listeners.size;
        engine.init();
        assert.equal(listeners.size, firstListenerCount);

        await engine.handleTraceEraser(message);
        assert.equal(deleted.length, 0);
        assert.equal(traceMetrics.protected, 1);
        assert.equal(audit.records.at(-1).actionType, "TRACE_PROTECTED_SKIP");

        engine.dispose();
        assert.equal(listeners.size, 0);
    } finally {
        audit.restore();
    }
});
