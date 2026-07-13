const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

function freshMemoryMonitor(env = {}) {
    const path = require.resolve("../index/memoryMonitor");
    delete require.cache[path];
    const oldEnv = {};

    for (const [key, value] of Object.entries(env)) {
        oldEnv[key] = process.env[key];
        process.env[key] = value;
    }

    const monitor = require("../index/memoryMonitor");

    return {
        monitor,
        restore() {
            monitor.stopMemoryMonitor();
            delete require.cache[path];
            for (const [key, value] of Object.entries(oldEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    };
}

function withMutedConsole(fn) {
    const oldLog = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = oldLog;
    }
}

function makeFakeClient() {
    const client = new EventEmitter();
    client.isReady = () => true;
    client.guilds = { cache: new Map() };
    client.channels = { cache: new Map() };
    client.users = { cache: new Map([["u1", {}]]) };
    client.on("messageCreate", () => {});
    return client;
}

test("memory monitor trend stays bounded and compact", () => {
    const { monitor, restore } = freshMemoryMonitor({ MEMORY_TREND_MAX: "2" });

    try {
        const voiceWorker = {
            getNaturalSettings: () => ({ activeTimers: 1 }),
            getAutoDeafSettings: () => ({ activeTimers: 2 }),
            getWorkerDiagnostics: () => ({
                selfClientCaches: { messages: 3, users: 4 },
                selfClientListeners: { total: 5 },
                loginQueue: 0,
                recoveryQueue: 0
            }),
            getClientPoolSize: () => 6
        };
        const sessionManager = {
            getAllSessions: () => new Map([["s1", {}]]),
            getSessionDiagnostics: () => ({ total: 1 })
        };
        const client = makeFakeClient();

        withMutedConsole(() => {
            monitor.captureMemorySnapshot("one", { voiceWorker, sessionManager, client });
            monitor.captureMemorySnapshot("two", { voiceWorker, sessionManager, client });
            monitor.captureMemorySnapshot("three", { voiceWorker, sessionManager, client });
        });

        const state = monitor.getMemoryMonitorState();

        assert.equal(state.trend.length, 2);
        assert.equal(state.lastSnapshot.config.trendMax, 2);
        assert.equal(state.trend[1].sessions, 1);
        assert.equal(state.trend[1].clientPool, 6);
        assert.equal(state.trend[1].selfClientMessages, 3);
        assert.equal(state.trend[1].selfClientListeners, 5);
        assert.equal(state.trend[1].discordUsers, 1);
        assert.equal(state.trend[1].discordListeners, 1);
        assert.equal(state.trend[1].naturalTimers, 1);
        assert.equal(state.trend[1].autoDeafTimers, 2);
        assert.equal(Object.hasOwn(state.trend[1], "auditQueues"), false);
        assert.equal(Object.hasOwn(state.trend[1], "workerDiagnostics"), false);
        assert.equal(Object.hasOwn(state.trend[1], "selfClientCacheDetails"), false);
    } finally {
        restore();
    }
});
