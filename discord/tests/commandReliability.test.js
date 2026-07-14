const assert = require("node:assert/strict");
const test = require("node:test");

const { registerCommandsWithRetry } = require("../commands/registration");
const { markCommandAccepted } = require("../guards/commandGuards");
const information = require("../commands/information");
const commands = require("../commands");
const sessionManager = require("../sessionManager");

test("command registration retries without blocking after a transient failure", async () => {
    let calls = 0;
    const waited = [];
    const result = await registerCommandsWithRetry({
        application: { commands: { set: async () => { if (++calls < 2) throw new Error("temporary"); } } },
        payload: [{ name: "ping" }],
        delaysMs: [0, 5, 10],
        wait: async ms => waited.push(ms)
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(waited, [5]);
});

test("command registration returns a degraded result after bounded retries", async () => {
    const result = await registerCommandsWithRetry({
        application: { commands: { set: async () => { throw new Error("down"); } } },
        payload: [], delaysMs: [0, 0], wait: async () => {}
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
});

test("accepted command marker is explicit and leaves rejected interactions untouched", () => {
    let acceptedAt = 0;
    const accepted = { isCommand: () => true, __onCommandAccepted: () => { acceptedAt++; } };
    const rejected = { isCommand: () => false };
    markCommandAccepted(accepted);
    markCommandAccepted(rejected);
    assert.equal(accepted.__commandAccepted, true);
    assert.equal(acceptedAt, 1);
    assert.equal(rejected.__commandAccepted, undefined);
});

test("serverinfo shares one in-flight member fetch per guild", async () => {
    information._test.serverInfoCounts.clear();
    information._test.serverInfoInFlight.clear();
    let fetches = 0;
    const members = {
        filter(fn) {
            const values = [{ user: { bot: false } }, { user: { bot: true } }].filter(fn);
            return { size: values.length };
        }
    };
    const guild = { id: "guild", members: { cache: members, fetch: async () => { fetches++; return members; } } };
    const [first, second] = await Promise.all([
        information._test.getServerMemberCounts(guild),
        information._test.getServerMemberCounts(guild)
    ]);
    assert.equal(fetches, 1);
    assert.deepEqual(first, second);
});

test("voice panel update reports persistence failure", async () => {
    const originalSave = sessionManager.savePanelState;
    const panel = {
        id: "panel",
        guild: { id: "guild" },
        channel: { id: "channel" },
        edit: async () => ({})
    };
    commands.getPanelMessages().set("guild", panel);
    sessionManager.savePanelState = async () => false;
    try {
        assert.equal(await commands.updatePanel("guild"), false);
    } finally {
        commands.getPanelMessages().delete("guild");
        sessionManager.savePanelState = originalSave;
    }
});

test("command router delegates registered command groups without changing handlers", () => {
    assert.equal(commands._test.delegatedCommandHandler("ping"), information.handle);
    assert.equal(typeof commands._test.delegatedCommandHandler("ban"), "function");
    assert.equal(typeof commands._test.delegatedCommandHandler("backup"), "function");
    assert.equal(commands._test.delegatedCommandHandler("voice-online"), null);
    assert.equal(commands._test.delegatedCommandHandler("unknown"), null);
});

test("latest setting prefix rejects values that could alter a Mongo query", async () => {
    await assert.rejects(
        sessionManager.getLatestSettingByPrefix({ $ne: "" }),
        /INVALID_SETTING_PREFIX/
    );
    await assert.rejects(
        sessionManager.getLatestSettingByPrefix("verify_config_123_.*"),
        /INVALID_SETTING_PREFIX/
    );
});

test("serverinfo skips full member fetch for large guilds with incomplete cache", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    information._test.serverInfoCounts.clear();
    information._test.serverInfoInFlight.clear();
    let fetches = 0;
    const members = {
        size: 2,
        filter(fn) {
            const values = [{ user: { bot: false } }, { user: { bot: true } }].filter(fn);
            return { size: values.length };
        }
    };
    const guild = {
        id: "large-guild",
        memberCount: information._test.SERVERINFO_FULL_FETCH_MAX_MEMBERS + 1,
        members: { cache: members, fetch: async () => { fetches++; return members; } }
    };
    const result = await information._test.getServerMemberCounts(guild);
    assert.equal(fetches, 0);
    assert.equal(result.human, null);
    assert.equal(result.bots, null);
    assert.match(result.source, /เกินเพดาน full fetch/);
});


test("serverinfo bounds member fetch time and falls back to cache on timeout", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    information._test.serverInfoCounts.clear();
    information._test.serverInfoInFlight.clear();
    const cachedMembers = {
        size: 2,
        filter(fn) {
            const values = [{ user: { bot: false } }, { user: { bot: true } }].filter(fn);
            return { size: values.length };
        }
    };
    let optionsSeen = null;
    const guild = {
        id: "bounded-guild",
        memberCount: 100,
        members: {
            cache: cachedMembers,
            async fetch(options) { optionsSeen = options; throw new Error("timeout"); }
        }
    };
    const result = await information._test.getServerMemberCounts(guild);
    assert.equal(optionsSeen.time, information._test.SERVERINFO_FETCH_TIMEOUT_MS);
    assert.equal(result.human, 1);
    assert.equal(result.bots, 1);
    assert.match(result.source, /cache/);
});
