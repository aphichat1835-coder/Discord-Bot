"use strict";

const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const { AuditLogEvent, ChannelType, PermissionFlagsBits } = require("discord.js");
const voiceAdmin = require("../features/voiceAdmin");
const config = require("../config.json");

const { _test, IDS, VoiceAdminLock, VoiceAdminNotice } = voiceAdmin;
const originalLockUpdate = VoiceAdminLock.updateOne;
const originalLockDelete = VoiceAdminLock.deleteOne;
const originalLockDeleteMany = VoiceAdminLock.deleteMany;
const originalNoticeUpdate = VoiceAdminNotice.updateOne;
const originalNoticeDeleteMany = VoiceAdminNotice.deleteMany;

function member(id, administrator = false, options = {}) {
    const calls = [];
    return {
        id,
        permissions: { has: permission => administrator && permission === PermissionFlagsBits.Administrator },
        voice: {
            channel: options.channel || null,
            async setMute(value) { calls.push(["mute", value]); if (options.failMute) throw new Error("mute failed"); },
            async setDeaf(value) { calls.push(["deaf", value]); if (options.failDeaf) throw new Error("deaf failed"); },
            async disconnect() { calls.push(["disconnect"]); if (options.failDisconnect) throw new Error("disconnect failed"); },
            async setChannel(channel) { calls.push(["move", channel.id]); if (options.failMove) throw new Error("move failed"); }
        },
        calls
    };
}

function guildFixture(members = []) {
    const guild = {
        id: "guild-voice-admin",
        ownerId: "guild-owner",
        client: { user: { id: "bot" } },
        members: {
            cache: new Map(members.map(item => [item.id, item])),
            me: { permissions: { has: () => true } },
            fetch: async id => guild.members.cache.get(id) || null
        },
        channels: { cache: new Map(), fetch: async id => guild.channels.cache.get(id) || null },
        fetchAuditLogs: async () => ({ entries: [] })
    };
    return guild;
}

function voiceChannel(guild, members = [], id = "voice-source") {
    const channel = {
        id, type: ChannelType.GuildVoice, guild, members: new Map(members.map(item => [item.id, item])),
        permissionsFor: () => ({ has: () => true }),
        messages: { fetch: async () => null },
        async send(payload) { channel.sent.push(payload); return { id: `notice-${channel.sent.length}` }; },
        sent: []
    };
    for (const item of members) item.voice.channel = channel;
    guild.channels.cache.set(id, channel);
    return channel;
}

function acknowledged({ upsert = false } = {}) {
    return { acknowledged: true, matchedCount: upsert ? 0 : 1, upsertedCount: upsert ? 1 : 0 };
}

beforeEach(() => {
    _test.reset();
    _test.setInitialized(true);
    VoiceAdminLock.updateOne = async (_filter, _update, options) => acknowledged({ upsert: options?.upsert === true });
    VoiceAdminLock.deleteOne = async () => ({ acknowledged: true, deletedCount: 1 });
    VoiceAdminLock.deleteMany = async () => ({ acknowledged: true, deletedCount: 1 });
    VoiceAdminNotice.updateOne = async () => acknowledged({ upsert: true });
    VoiceAdminNotice.deleteMany = async () => ({ acknowledged: true, deletedCount: 1 });
});
afterEach(async () => {
    await voiceAdmin.stop();
    VoiceAdminLock.updateOne = originalLockUpdate;
    VoiceAdminLock.deleteOne = originalLockDelete;
    VoiceAdminLock.deleteMany = originalLockDeleteMany;
    VoiceAdminNotice.updateOne = originalNoticeUpdate;
    VoiceAdminNotice.deleteMany = originalNoticeDeleteMany;
});

test("secret parser prioritises /// and rejects malformed syntax", () => {
    assert.deepEqual(_test.parseSecretCommand("///ปิดไมค์หมด"), { prefix: "///", command: "ปิดไมค์หมด", argument: null, includeAdministrators: true });
    assert.deepEqual(_test.parseSecretCommand("//ย้ายหมด 12345678901234567"), { prefix: "//", command: "ย้ายหมด", argument: "12345678901234567", includeAdministrators: false });
    assert.equal(_test.parseSecretCommand("//ย้ายหมด").invalid, true);
    assert.equal(_test.parseSecretCommand("//เปิดหมด anything").invalid, true);
    assert.equal(_test.parseSecretCommand("ข้อความปกติ"), null);
});

test("panel is Administrator-only, voice-only, and has stable rows", () => {
    const guild = guildFixture();
    const channel = voiceChannel(guild);
    const admin = member("admin", true);
    assert.equal(_test.verifyVoiceAdminAccess(admin, channel), null);
    assert.equal(_test.verifyVoiceAdminAccess(member("regular"), channel), "ต้องเป็น Administrator");
    assert.equal(_test.verifyVoiceAdminAccess(admin, { ...channel, type: ChannelType.GuildStageVoice }), "ต้องใช้คำสั่งในแชทของห้องเสียงปกติ");
    const rows = _test.buildPanel(channel).components.map(row => row.toJSON());
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].components.map(component => component.custom_id), [IDS.DISCONNECT, IDS.LOCK_MUTE, IDS.LOCK_DEAF, IDS.UNLOCK_MUTE, IDS.UNLOCK_DEAF]);
    assert.equal(rows[1].components[0].custom_id, IDS.MOVE);
    assert.equal(rows[2].components[0].custom_id, IDS.REFRESH);
});

test("panel and /// snapshots follow the Administrator and Owner rules", () => {
    const admin = member("admin", true);
    const regular = member("regular");
    const owner = member("owner", true);
    const guild = guildFixture([admin, regular, owner]);
    const channel = voiceChannel(guild, [admin, regular, owner]);
    assert.deepEqual(_test.sourceMembers(channel).map(item => item.id), ["regular"]);
    assert.deepEqual(_test.sourceMembers(channel, { includeAdministrators: true, excludeId: "owner" }).map(item => item.id), ["admin", "regular"]);
});

test("lock persistence is one member at a time and a Discord failure rolls back only that version", async () => {
    const first = member("first");
    const second = member("second", false, { failMute: true });
    const guild = guildFixture([first, second]);
    voiceChannel(guild, [first, second]);
    const writes = [];
        VoiceAdminLock.updateOne = async (filter, update, options) => {
            const setFields = Object.keys(update.$set || {});
            const insertFields = Object.keys(update.$setOnInsert || {});
            if (setFields.some(field => insertFields.includes(field))) {
                const error = new Error("MongoDB update path conflict");
                error.code = 40;
                throw error;
            }
            writes.push({ filter, update, options });
        return acknowledged({ upsert: options?.upsert === true });
    };
    const result = await _test.lockVoiceState(guild, [first, second], "mute", "owner");
    assert.deepEqual({ targeted: result.targeted, succeeded: result.succeeded, failed: result.failed, timedOut: result.timedOut }, { targeted: 2, succeeded: 1, failed: 1, timedOut: 0 });
    assert.equal(writes.length, 3, "write first, write second, then conditional rollback second");
    assert.equal(_test.getLock(guild.id, first.id).muteLocked, true);
    assert.equal(_test.getLock(guild.id, second.id), null);
});

test("unacknowledged persistence is counted as failure and never added to cache", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);
    VoiceAdminLock.updateOne = async () => ({ acknowledged: false, matchedCount: 0, upsertedCount: 0 });
    const result = await _test.lockVoiceState(guild, [target], "mute", "owner");
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.persistenceFailed, 1);
    assert.equal(_test.getLock(guild.id, target.id), null);
    assert.deepEqual(target.calls, []);
});

test("lock writes keep MongoDB update paths disjoint for new and versioned locks", async () => {
    const writes = [];
    VoiceAdminLock.updateOne = async (filter, update, options) => {
        writes.push({ filter, update, options });
        return acknowledged({ upsert: options?.upsert === true });
    };

    await _test.writeLock("guild", "mute-user", "mute", "owner");
    await _test.writeLock("guild", "deaf-user", "deaf", "owner");
    await _test.writeLock("guild", "restore-user", "mute", "owner", "cleared-version");

    for (const write of writes) {
        const overlap = Object.keys(write.update.$set || {}).filter(key => Object.hasOwn(write.update.$setOnInsert || {}, key));
        assert.deepEqual(overlap, []);
    }
    assert.equal(writes[0].options.upsert, true);
    assert.equal(writes[0].options.setDefaultsOnInsert, false);
    assert.equal(writes[0].update.$setOnInsert.muteLocked, undefined);
    assert.equal(writes[1].update.$setOnInsert.deafLocked, undefined);
    assert.equal(writes[2].options.upsert, false);
    assert.equal(writes[2].update.$setOnInsert, undefined);
});

test("persistence alerts expose a bounded error code and never include an error message", () => {
    const error = new Error("mongodb://user:secret@example.test/private");
    error.code = "MONGO_WRITE_FAILED";
    const context = _test.buildPersistenceFailureContext("write_lock", {
        guildId: "guild", userId: "member", type: "mute", error
    });
    assert.deepEqual(context, {
        "การทำงาน": "write_lock", "Guild ID": "guild", "User ID": "member", "ประเภท": "mute", "รหัสข้อผิดพลาด": "MONGO_WRITE_FAILED"
    });
    assert.equal(JSON.stringify(context).includes("secret@example.test"), false);
});

test("timeout accounts for targets that never start and leaves them without a new lock", async () => {
    const members = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const result = await _test.runBulkUnsafe(members, async () => {}, { cancelled: false, sleeps: new Set() }, { startedAt: Date.now() - 5, maxDurationMs: 1 });
    assert.deepEqual({ targeted: result.targeted, succeeded: result.succeeded, failed: result.failed, timedOut: result.timedOut }, { targeted: 3, succeeded: 0, failed: 0, timedOut: 3 });
    assert.equal(result.succeeded + result.failed + result.timedOut, result.targeted);
});

test("bulk actions fill eight workers immediately and start the next target without a fixed delay", async () => {
    const members = Array.from({ length: 10 }, (_value, index) => ({ id: `member-${index}` }));
    const gates = new Map(); const started = []; let active = 0; let maxActive = 0;
    const running = _test.runBulkUnsafe(members, member => {
        started.push(member.id);
        if (started.length > 8) return Promise.resolve();
        return new Promise(resolve => {
            active++; maxActive = Math.max(maxActive, active);
            gates.set(member.id, () => { active--; resolve(); });
        });
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.length, 8);
    assert.equal(maxActive, 8);
    gates.get("member-0")();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(started.length >= 9);
    for (const release of gates.values()) release();
    const result = await running;
    assert.deepEqual({ targeted: result.targeted, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped, timedOut: result.timedOut }, { targeted: 10, succeeded: 10, failed: 0, skipped: 0, timedOut: 0 });
});

test("bulk actions across Guilds never exceed the shared twelve-member limit", async () => {
    const first = Array.from({ length: 8 }, (_value, index) => ({ id: `first-${index}` }));
    const second = Array.from({ length: 8 }, (_value, index) => ({ id: `second-${index}` }));
    const gates = []; let active = 0; let maxActive = 0; let started = 0;
    const runOne = member => new Promise(resolve => {
        started++;
        if (started > 12) return resolve(member.id);
        active++; maxActive = Math.max(maxActive, active);
        gates.push(() => { active--; resolve(member.id); });
    });
    const one = _test.runBulkUnsafe(first, runOne);
    const two = _test.runBulkUnsafe(second, runOne);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 12);
    assert.equal(maxActive, 12);
    for (const release of gates.splice(0)) release();
    await Promise.all([one, two]);
    assert.equal(_test.getGlobalMemberOperationCount(), 0);
});

test("bulk scheduler accounts for large rooms without creating more than eight active member operations", async () => {
    for (const count of [100, 500]) {
        const members = Array.from({ length: count }, (_value, index) => ({ id: `large-${count}-${index}` }));
        const gates = []; let active = 0; let maxActive = 0; let started = 0;
        const running = _test.runBulkUnsafe(members, () => {
            started++;
            if (started > 8) return Promise.resolve();
            return new Promise(resolve => {
                active++; maxActive = Math.max(maxActive, active);
                gates.push(() => { active--; resolve(); });
            });
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(active, 8);
        assert.equal(maxActive, 8);
        for (const release of gates) release();
        const result = await running;
        assert.deepEqual({ targeted: result.targeted, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped, timedOut: result.timedOut }, { targeted: count, succeeded: count, failed: 0, skipped: 0, timedOut: 0 });
    }
});

test("deadline stops unstarted targets and waits for the started target before returning a final result", async () => {
    const members = [{ id: "started" }, { id: "never-started" }];
    const started = []; let release;
    const running = _test.runBulkUnsafe(members, member => {
        started.push(member.id);
        return new Promise(resolve => { release = resolve; });
    }, null, { workerLimit: 1, maxDurationMs: 10 });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    const result = await running;
    assert.deepEqual(started, ["started"]);
    assert.deepEqual({ succeeded: result.succeeded, failed: result.failed, skipped: result.skipped, timedOut: result.timedOut }, { succeeded: 1, failed: 0, skipped: 0, timedOut: 1 });
});

test("shutdown cancels global permit waiters and drains already-started Voice Admin work", async () => {
    const gates = [];
    const makeMembers = prefix => Array.from({ length: 8 }, (_value, index) => {
        const target = member(`${prefix}-${index}`);
        target.voice.setMute = async () => new Promise(resolve => gates.push(resolve));
        return target;
    });
    const firstMembers = makeMembers("first"); const secondMembers = makeMembers("second");
    const firstGuild = guildFixture(firstMembers); const secondGuild = guildFixture(secondMembers);
    firstGuild.id = "voice-admin-first"; secondGuild.id = "voice-admin-second";
    voiceChannel(firstGuild, firstMembers); voiceChannel(secondGuild, secondMembers);
    const first = _test.lockVoiceState(firstGuild, firstMembers, "mute", "owner");
    const second = _test.lockVoiceState(secondGuild, secondMembers, "mute", "owner");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getGlobalMemberOperationCount(), 12);
    assert.equal(_test.globalActionWaiters.length, 4);
    const stopping = voiceAdmin.stop();
    for (const release of gates.splice(0)) release();
    await Promise.all([first, second, stopping]);
    assert.equal(_test.globalActionWaiters.length, 0);
    assert.equal(_test.getGlobalMemberOperationCount(), 0);
});

test("source snapshot targets that leave first are skipped instead of being followed into another room", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const source = voiceChannel(guild, [target]);
    const other = voiceChannel(guild, [], "other-voice");
    target.voice.channel = other;
    const disconnected = await _test.disconnectMembers(guild, source, [target]);
    assert.equal(disconnected.skipped, 1);
    assert.deepEqual(target.calls, []);

    target.voice.channel = source;
    VoiceAdminLock.updateOne = async (_filter, _update, options) => {
        target.voice.channel = other;
        return acknowledged({ upsert: options?.upsert === true });
    };
    const muted = await _test.lockVoiceState(guild, [target], "mute", "owner", { source });
    assert.equal(muted.skipped, 1);
    assert.equal(_test.getLock(guild.id, target.id), null);
    assert.deepEqual(target.calls, []);
});

test("unlock actions retain locks when a target leaves before or during persistence", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const source = voiceChannel(guild, [target]);
    const other = voiceChannel(guild, [], "other-voice");
    const updates = [];
    VoiceAdminLock.updateOne = async (_filter, update, options) => {
        updates.push({ update, options });
        return acknowledged({ upsert: options?.upsert === true });
    };

    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "before", muteLockedBy: "owner", muteLockedAt: 123456 });
    target.voice.channel = other;
    const before = await _test.unlockVoiceState(guild, [target], "mute", { source });
    assert.equal(before.skipped, 1);
    assert.equal(_test.getLock(guild.id, target.id).muteLocked, true);
    assert.equal(updates.length, 0);

    target.voice.channel = source;
    VoiceAdminLock.updateOne = async (_filter, update, options) => {
        updates.push({ update, options });
        if (updates.length === 1) target.voice.channel = other;
        return acknowledged({ upsert: options?.upsert === true });
    };
    const during = await _test.unlockVoiceState(guild, [target], "mute", { source });
    assert.equal(during.skipped, 1);
    assert.equal(_test.getLock(guild.id, target.id).muteLocked, true);
    assert.equal(updates.length, 2, "clear then version-bound restore");
    assert.equal(updates.at(-1).options.upsert, false);
    assert.equal(updates.at(-1).update.$setOnInsert, undefined);
    assert.equal(updates.at(-1).update.$set.muteLockedAt, 123456, "rollback keeps the original lock timestamp");
    assert.deepEqual(target.calls, []);
});

test("an unlock rollback never overwrites a lock replacement made by another action", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const source = voiceChannel(guild, [target]);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "old", muteLockedBy: "old-owner" });
    let writes = 0;
    VoiceAdminLock.updateOne = async (_filter, _update, options) => {
        writes++;
        if (writes === 1) {
            _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "new", muteLockedBy: "new-owner" });
            target.voice.setMute = async () => { throw new Error("Discord unlock failed"); };
            return acknowledged();
        }
        assert.equal(options.upsert, false);
        return { acknowledged: true, matchedCount: 0, upsertedCount: 0 };
    };

    const result = await _test.unlockVoiceState(guild, [target], "mute", { source });
    assert.equal(result.failed, 1);
    assert.equal(writes, 1, "a detected replacement aborts before Discord or a stale rollback");
    assert.equal(_test.getLock(guild.id, target.id).muteVersion, "new");
    assert.equal(_test.getLock(guild.id, target.id).muteLockedBy, "new-owner");
});

test("unlock all restores both locks when a target leaves during the durable clear", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const source = voiceChannel(guild, [target]);
    const other = voiceChannel(guild, [], "other-voice");
    const updates = [];
    _test.setCachedLock({
        guildId: guild.id, userId: target.id,
        muteLocked: true, deafLocked: true,
        muteVersion: "mute-before", deafVersion: "deaf-before",
        muteLockedBy: "owner", deafLockedBy: "owner"
    });
    VoiceAdminLock.updateOne = async (_filter, update, options) => {
        updates.push({ update, options });
        if (updates.length === 1) target.voice.channel = other;
        return acknowledged({ upsert: options?.upsert === true });
    };

    const result = await _test.unlockBoth(guild, [target], { source });
    assert.equal(result.skipped, 1);
    const restored = _test.getLock(guild.id, target.id);
    assert.equal(restored.muteLocked, true);
    assert.equal(restored.deafLocked, true);
    assert.equal(updates.length, 3, "clear both then restore mute and deaf");
    assert.deepEqual(target.calls, []);
});

test("member deadline preserves an original rejection without an unhandled follow-up", async () => {
    await assert.rejects(() => _test.withDeadline(Promise.reject(new Error("Discord rejected")), 100), /Discord rejected/);
});

test("missing Audit executor fails closed when Discord member lookup is unavailable", async () => {
    const guild = guildFixture();
    guild.members.fetch = async () => { throw new Error("member lookup failed"); };
    assert.equal(await _test.resolveExecutorMember(guild, "missing-executor"), null);
});

test("unlock both uses one member edit and restores durable lock only after a Discord failure", async () => {
    const target = member("target");
    target.edit = async () => { throw new Error("edit failed"); };
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, deafLocked: true, muteVersion: "old-m", deafVersion: "old-d", muteLockedBy: "owner", deafLockedBy: "owner" });
    const result = await _test.unlockBoth(guild, [target]);
    assert.equal(result.failed, 1);
    const restored = _test.getLock(guild.id, target.id);
    assert.equal(restored.muteLocked, true);
    assert.equal(restored.deafLocked, true);
});

test("unlock-both attempts both durable rollbacks even when the first rollback fails", async () => {
    const target = member("target");
    target.edit = async () => { throw new Error("edit failed"); };
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, deafLocked: true, muteVersion: "old-m", deafVersion: "old-d", muteLockedBy: "owner", deafLockedBy: "owner" });
    const writes = [];
    VoiceAdminLock.updateOne = async (_filter, update) => {
        writes.push(update);
        if (writes.length === 2) throw new Error("mute rollback failed");
        return acknowledged();
    };
    const result = await _test.unlockBoth(guild, [target]);
    assert.equal(result.failed, 1);
    assert.equal(writes.length, 3, "clear, mute rollback, and deaf rollback must all be attempted");
    assert.equal(writes[2].$set.deafLocked, true);
});

test("command records cooldown only after an ephemeral panel was created", async () => {
    const admin = member("admin", true);
    const guild = guildFixture([admin]);
    const channel = voiceChannel(guild, [admin]);
    const interaction = {
        member: admin, channel, guild, isCommand: () => true,
        async reply(payload) { interaction.payload = payload; return "reply"; }
    };
    await voiceAdmin.handleVoiceAdminCommand(interaction);
    assert.equal(interaction.__commandAccepted, true);
    assert.equal(interaction.payload.ephemeral, true);
});

test("audit entries older than the lock cannot clear a newer lock", () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const channel = voiceChannel(guild, [target]);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "new", muteLockedAt: Date.now(), updatedAt: Date.now() });
    voiceAdmin.handleAuditLogEntry({ id: "old", action: AuditLogEvent.MemberUpdate, targetId: target.id, executorId: "actor", createdTimestamp: Date.now() - 10000, changes: [{ key: "mute", new: false }] }, guild, { user: { id: "bot" } });
    voiceAdmin.handleVoiceStateUpdate({ guild, id: target.id, member: target, channel, serverMute: true }, { guild, id: target.id, member: target, channel, serverMute: false }, { user: { id: "bot" } });
    assert.equal(_test.getLock(guild.id, target.id).muteLocked, true);
    assert.equal(_test.pendingEnforcement.size, 1);
});

test("a matching audit entry makes an Administrator unlock durable, while non-admin is re-enforced", async () => {
    const target = member("target");
    const admin = member("admin", true);
    const regular = member("regular");
    const guild = guildFixture([target, admin, regular]);
    const channel = voiceChannel(guild, [target, admin, regular]);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "lock-v", muteLockedAt: Date.now() - 1, updatedAt: Date.now() - 1 });
    voiceAdmin.handleVoiceStateUpdate({ guild, id: target.id, member: target, channel, serverMute: true }, { guild, id: target.id, member: target, channel, serverMute: false }, { user: { id: "bot" } });
    voiceAdmin.handleAuditLogEntry({ id: "admin-entry", action: AuditLogEvent.MemberUpdate, targetId: target.id, executorId: admin.id, createdTimestamp: Date.now(), changes: [{ key: "mute", new: false }] }, guild, { user: { id: "bot" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getLock(guild.id, target.id), null);

    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "lock-v2", muteLockedAt: Date.now() - 1, updatedAt: Date.now() - 1 });
    voiceAdmin.handleVoiceStateUpdate({ guild, id: target.id, member: target, channel, serverMute: true }, { guild, id: target.id, member: target, channel, serverMute: false }, { user: { id: "bot" } });
    voiceAdmin.handleAuditLogEntry({ id: "regular-entry", action: AuditLogEvent.MemberUpdate, targetId: target.id, executorId: regular.id, createdTimestamp: Date.now(), changes: [{ key: "mute", new: false }] }, guild, { user: { id: "bot" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getLock(guild.id, target.id).muteLocked, true);
    assert.deepEqual(target.calls.at(-1), ["mute", true]);
    assert.equal(channel.sent.length, 1);
});

test("voice rejoin is enforced directly, no audit actor is required", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const channel = voiceChannel(guild, [target]);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, deafLocked: true, deafVersion: "d1", deafLockedAt: Date.now() });
    voiceAdmin.handleVoiceStateUpdate({ guild, id: target.id, member: target, channel: null }, { guild, id: target.id, member: target, channel, serverDeaf: false }, { user: { id: "bot" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(target.calls.at(-1), ["deaf", true]);
});

test("enforcement retries transient Discord failures, stops after three attempts, and honours a replaced lock version", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);
    let attempts = 0;
    target.voice.setMute = async value => {
        attempts++;
        target.calls.push(["mute", value]);
        if (attempts === 1) throw new Error("transient Discord failure");
    };
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "retry-v", muteLockedAt: Date.now() });
    assert.equal(await _test.enforceLock(guild, target.id, "mute", "retry-v", { retryDelaysMs: [0, 0, 0] }), true);
    assert.equal(attempts, 2);

    const alwaysFails = member("always-fails", false, { failMute: true });
    guild.members.cache.set(alwaysFails.id, alwaysFails);
    voiceChannel(guild, [alwaysFails], "voice-failing");
    _test.setCachedLock({ guildId: guild.id, userId: alwaysFails.id, muteLocked: true, muteVersion: "failure-v", muteLockedAt: Date.now() });
    await assert.rejects(
        () => _test.enforceLock(guild, alwaysFails.id, "mute", "failure-v", { retryDelaysMs: [0, 0, 0] }),
        { code: "VOICE_ADMIN_ENFORCEMENT_FAILED" }
    );
    assert.equal(alwaysFails.calls.filter(call => call[0] === "mute").length, 3);

    let replacedAttempts = 0;
    target.voice.setMute = async value => {
        replacedAttempts++;
        target.calls.push(["mute", value]);
        _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "newer-v", muteLockedAt: Date.now() });
        throw new Error("old attempt failed");
    };
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "old-v", muteLockedAt: Date.now() });
    assert.equal(await _test.enforceLock(guild, target.id, "mute", "old-v", { retryDelaysMs: [0, 0] }), false);
    assert.equal(replacedAttempts, 1);
});

test("a new enforcement version replaces a stale in-flight retry while the same version shares work", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);

    let sameVersionCalls = 0;
    let releaseSameVersion;
    target.voice.setMute = async value => {
        sameVersionCalls++;
        target.calls.push(["mute", value]);
        await new Promise(resolve => { releaseSameVersion = resolve; });
    };
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "shared", muteLockedAt: Date.now() });
    const sharedOne = _test.enforceLock(guild, target.id, "mute", "shared", { retryDelaysMs: [0] });
    const sharedTwo = _test.enforceLock(guild, target.id, "mute", "shared", { retryDelaysMs: [0] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sameVersionCalls, 1);
    releaseSameVersion();
    assert.deepEqual(await Promise.all([sharedOne, sharedTwo]), [true, true]);

    let rejectOld;
    let calls = 0;
    target.voice.setMute = async value => {
        calls++;
        target.calls.push(["mute", value]);
        return new Promise((_, reject) => { rejectOld = reject; });
    };
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "old", muteLockedAt: Date.now() });
    const oldWork = _test.enforceLock(guild, target.id, "mute", "old", { retryDelaysMs: [0, 0] });
    await new Promise(resolve => setImmediate(resolve));

    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "new", muteLockedAt: Date.now() });
    target.voice.setMute = async value => { calls++; target.calls.push(["mute", value]); };
    const newWork = _test.enforceLock(guild, target.id, "mute", "new", { retryDelaysMs: [0] });
    rejectOld(new Error("old Discord request failed"));
    assert.deepEqual(await Promise.all([oldWork, newWork]), [false, true]);
    assert.equal(calls, 2, "the new lock receives its own Discord request");
    assert.equal(_test.enforcementActions.size, 0);
});

test("startup reconciliation enforces regular and Owner-forced locks while preserving offline locks", async () => {
    const regular = member("regular");
    const forcedAdmin = member("forced-admin", true);
    const normalAdmin = member("normal-admin", true);
    const offline = member("offline");
    const guild = guildFixture([regular, forcedAdmin, normalAdmin, offline]);
    voiceChannel(guild, [regular, forcedAdmin, normalAdmin]);
    _test.setCachedLock({ guildId: guild.id, userId: regular.id, muteLocked: true, muteVersion: "regular-v", muteLockedAt: Date.now() });
    _test.setCachedLock({ guildId: guild.id, userId: forcedAdmin.id, muteLocked: true, muteOwnerForced: true, muteVersion: "forced-v", muteLockedAt: Date.now() });
    _test.setCachedLock({ guildId: guild.id, userId: normalAdmin.id, muteLocked: true, muteVersion: "admin-v", muteLockedAt: Date.now() });
    _test.setCachedLock({ guildId: guild.id, userId: offline.id, deafLocked: true, deafVersion: "offline-v", deafLockedAt: Date.now() });

    const summary = await _test.reconcileConnectedLocks({ guilds: { cache: new Map([[guild.id, guild]]) } }, { retryDelaysMs: [0] });
    assert.equal(summary.enforced, 2);
    assert.equal(_test.getLock(guild.id, normalAdmin.id), null);
    assert.equal(_test.getLock(guild.id, offline.id).deafLocked, true);
    assert.deepEqual(regular.calls.at(-1), ["mute", true]);
    assert.deepEqual(forcedAdmin.calls.at(-1), ["mute", true]);
});

test("startup reconciliation removes only confirmed missing Guild/member locks and preserves locks on lookup failure", async () => {
    const guild = guildFixture();
    guild.members.fetch = async () => {
        const error = new Error("Unknown Member");
        error.code = 10007;
        throw error;
    };
    _test.setCachedLock({ guildId: guild.id, userId: "deleted-member", muteLocked: true, muteVersion: "deleted-v" });
    await _test.reconcileConnectedLocks({ guilds: { cache: new Map([[guild.id, guild]]) } }, { retryDelaysMs: [0] });
    assert.equal(_test.getLock(guild.id, "deleted-member"), null);

    guild.members.fetch = async () => { throw new Error("temporary Discord outage"); };
    _test.setCachedLock({ guildId: guild.id, userId: "unresolved-member", muteLocked: true, muteVersion: "unresolved-v" });
    await _test.reconcileConnectedLocks({ guilds: { cache: new Map([[guild.id, guild]]) } }, { retryDelaysMs: [0] });
    assert.equal(_test.getLock(guild.id, "unresolved-member").muteLocked, true);

    _test.setCachedLock({ guildId: "departed-guild", userId: "member", muteLocked: true, muteVersion: "gone-v" });
    await _test.reconcileConnectedLocks({ guilds: { cache: new Map() } }, { retryDelaysMs: [0] });
    assert.equal(_test.getLock("departed-guild", "member"), null);
});

test("member and Guild cleanup prevent an in-flight stale action from recreating a durable lock", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);
    let releaseWrite;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    VoiceAdminLock.updateOne = async (_filter, _update, options) => {
        if (options?.upsert) return writeGate;
        return acknowledged();
    };
    const running = _test.lockVoiceState(guild, [target], "mute", "owner");
    await new Promise(resolve => setImmediate(resolve));
    await _test.clearAllLocksForMember(guild.id, target.id, { retire: true });
    releaseWrite(acknowledged({ upsert: true }));
    const result = await running;
    assert.equal(result.failed, 1);
    assert.equal(_test.getLock(guild.id, target.id), null);
    assert.deepEqual(target.calls, []);

    await voiceAdmin.clearGuildData("departed-guild");
    assert.equal(_test.retiredGuilds.has("departed-guild"), true);
    voiceAdmin.handleGuildCreate("departed-guild");
    assert.equal(_test.retiredGuilds.has("departed-guild"), false);
});

test("audit and notice caches expire and keep their configured bounds", () => {
    const now = Date.now();
    for (let index = 0; index < 2002; index++) _test.cachedAuditUnlocks.set(`audit:${index}`, [{ createdTimestamp: now }]);
    for (let index = 0; index < 5002; index++) _test.processedAuditEntries.set(`processed:${index}`, { at: now, guildId: "g", userId: "u" });
    for (let index = 0; index < 5002; index++) _test.notices.set(`notice:${index}`, { notifiedAt: new Date(now) });
    _test.cachedAuditUnlocks.set("old-audit", [{ createdTimestamp: now - 6000 }]);
    _test.processedAuditEntries.set("old-processed", { at: now - 16000 });
    _test.auditWatermarks.set("old-watermark", now - 16000);
    _test.notices.set("old-notice", { notifiedAt: new Date(now - (24 * 60 * 60 * 1000)) });
    _test.pruneRuntimeCaches(now);
    assert.ok(_test.cachedAuditUnlocks.size <= 2000);
    assert.ok(_test.processedAuditEntries.size <= 5000);
    assert.ok(_test.notices.size <= 5000);
    assert.equal(_test.cachedAuditUnlocks.has("old-audit"), false);
    assert.equal(_test.processedAuditEntries.has("old-processed"), false);
    assert.equal(_test.auditWatermarks.has("old-watermark"), false);
    assert.equal(_test.notices.has("old-notice"), false);
});

test("stop cancels pending enforcement and does not leave a running guild action", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    voiceChannel(guild, [target]);
    const gate = new Promise(resolve => setTimeout(resolve, 100));
    const running = _test.runBulkUnsafe([target, member("other")], async () => gate, { cancelled: false, sleeps: new Set() });
    await voiceAdmin.stop();
    const result = await running;
    assert.equal(result.targeted, 2);
    assert.equal(_test.pendingEnforcement.size, 0);
});

test("component matcher and result format include new numeric result fields", () => {
    assert.equal(_test.isVoiceAdminInteraction({ isButton: () => true, customId: IDS.LOCK_MUTE }), true);
    assert.equal(_test.isVoiceAdminInteraction({ isChannelSelectMenu: () => true, customId: IDS.MOVE }), true);
    assert.equal(_test.isVoiceAdminInteraction({ isButton: () => true, customId: "btn_start" }), false);
    assert.match(_test.buildResult("งาน", { targeted: 3, succeeded: 1, failed: 1, timedOut: 1, persistenceFailed: 1 }), /หมดเวลา 1 คน/);
    assert.equal(_test.resultEmoji({ targeted: 2, succeeded: 2, failed: 0, skipped: 0, timedOut: 0, persistenceFailed: 0 }), config.emojis.success);
    assert.equal(_test.resultEmoji({ targeted: 2, succeeded: 1, failed: 1, skipped: 0, timedOut: 0, persistenceFailed: 0 }), config.emojis.warning);
    assert.equal(_test.resultEmoji({ targeted: 2, succeeded: 0, failed: 2, skipped: 0, timedOut: 0, persistenceFailed: 2 }), config.emojis.error);
    assert.equal(_test.resultEmoji({ targeted: 0, succeeded: 0, failed: 0, skipped: 0, timedOut: 0, persistenceFailed: 0 }), config.emojis.warning);
});

test("initialization and durable cleanup keep cache aligned only after acknowledged writes", async () => {
    const originalLockFind = VoiceAdminLock.find;
    const originalNoticeFind = VoiceAdminNotice.find;
    VoiceAdminLock.find = () => ({ lean: async () => [{ guildId: "g-init", userId: "u-init", muteLocked: true, lockedBy: "owner" }] });
    VoiceAdminNotice.find = () => ({ lean: async () => [{ guildId: "g-init", actorId: "a", targetId: "u-init", channelId: "c", messageId: "m", notifiedAt: new Date() }] });
    try {
        const loaded = await voiceAdmin.initialize();
        assert.deepEqual(loaded, { locks: 1, notices: 1 });
        assert.equal(_test.getLock("g-init", "u-init").muteLocked, true);
        await _test.clearAllLocksForMember("g-init", "u-init");
        assert.equal(_test.getLock("g-init", "u-init"), null);
        await voiceAdmin.clearGuildData("g-init");
    } finally {
        VoiceAdminLock.find = originalLockFind;
        VoiceAdminNotice.find = originalNoticeFind;
    }
});

test("unlock, disconnect, move, and permission validation use the source snapshot correctly", async () => {
    const first = member("first");
    const guild = guildFixture([first]);
    const source = voiceChannel(guild, [first]);
    const destination = voiceChannel(guild, [], "voice-destination");
    _test.setCachedLock({ guildId: guild.id, userId: first.id, muteLocked: true, muteVersion: "v", muteLockedBy: "owner" });
    const unlocked = await _test.unlockVoiceState(guild, [first], "mute");
    assert.equal(unlocked.succeeded, 1);
    assert.deepEqual(first.calls.at(-1), ["mute", false]);
    assert.equal(_test.getLock(guild.id, first.id), null);
    assert.equal((await _test.disconnectMembers(guild, [first])).succeeded, 1);
    assert.equal((await _test.moveMembers(guild, source, destination, [first])).succeeded, 1);
    await assert.rejects(() => _test.ensureBotPermission(guild, source, "move", source), { code: "VOICE_ADMIN_DESTINATION_INVALID" });
});

test("panel interactions refresh, reject invalid controls, and execute selected action", async () => {
    const target = member("target");
    const admin = member("admin", true);
    const guild = guildFixture([target, admin]);
    const channel = voiceChannel(guild, [target, admin]);
    const base = {
        member: admin, user: admin, channel, guild,
        async deferUpdate() { base.deferred = true; },
        async editReply(payload) { base.edited = payload; },
        async update(payload) { base.updated = payload; }
    };
    await voiceAdmin.handleVoiceAdminInteraction({ ...base, customId: IDS.REFRESH });
    assert.ok(base.updated);
    await voiceAdmin.handleVoiceAdminInteraction({ ...base, customId: "voiceadmin:unknown" });
    assert.equal(base.deferred, true);
    await voiceAdmin.handleVoiceAdminInteraction({ ...base, customId: IDS.DISCONNECT });
    assert.deepEqual(target.calls.at(-1), ["disconnect"]);
});

test("owner message commands are handled before normal processing and malformed messages only show usage", async () => {
    const target = member("target");
    const owner = member(config.system.ownerId, true);
    const guild = guildFixture([target, owner]);
    const channel = voiceChannel(guild, [target, owner]);
    const replies = [];
    const message = { guild, channel, author: { id: config.system.ownerId, bot: false }, content: "//ตัดหมด", async reply(payload) { replies.push(payload); } };
    assert.equal(await voiceAdmin.handleSecretMessage(message), true);
    assert.deepEqual(target.calls.at(-1), ["disconnect"]);
    message.content = "//ย้ายหมด";
    await voiceAdmin.handleSecretMessage(message);
    assert.match(replies.at(-1).content, /ใช้:/);
    assert.equal(await voiceAdmin.handleSecretMessage({ ...message, author: { id: "not-owner", bot: false }, content: "//ตัดหมด" }), false);
});

test("secret lock persistence failures are reported as an error and never call Discord", async () => {
    const target = member("target");
    const owner = member(config.system.ownerId, true);
    const guild = guildFixture([target, owner]);
    const channel = voiceChannel(guild, [target, owner]);
    const replies = [];
    VoiceAdminLock.updateOne = async () => ({ acknowledged: false, matchedCount: 0, upsertedCount: 0 });
    const message = {
        guild, channel, author: { id: config.system.ownerId, bot: false }, content: "//ปิดไมค์หมด",
        async reply(payload) { replies.push(payload); }
    };

    assert.equal(await voiceAdmin.handleSecretMessage(message), true);
    assert.match(replies.at(-1).content, new RegExp(`^> ${config.emojis.error}`));
    assert.match(replies.at(-1).content, /บันทึกสถานะไม่สำเร็จ 1 คน/);
    assert.deepEqual(target.calls, []);
});

test("notice replacement and audit fallback are bounded and do not need an executor", async () => {
    const target = member("target");
    const guild = guildFixture([target]);
    const channel = voiceChannel(guild, [target]);
    let noticeAttempts = 0;
    VoiceAdminNotice.updateOne = async () => {
        noticeAttempts++;
        if (noticeAttempts === 1) throw new Error("transient Mongo error");
        return acknowledged({ upsert: true });
    };
    await _test.sendUnauthorizedNotice(guild, "actor", target.id);
    await _test.sendUnauthorizedNotice(guild, "actor", target.id);
    assert.equal(noticeAttempts, 3);
    assert.equal(channel.sent.length, 2);
    guild.fetchAuditLogs = async () => ({ entries: [{ id: "fetched", targetId: target.id, createdTimestamp: Date.now(), changes: [{ key: "mute", new: false }] }] });
    const pending = { lockedAt: Date.now() - 1, stateAt: Date.now() - 1 };
    assert.equal((await _test.findRecentAuditUnlock(guild, target.id, "mute", pending)).id, "fetched");
    guild.fetchAuditLogs = async () => { throw new Error("audit unavailable"); };
    assert.equal(await _test.findRecentAuditUnlock(guild, target.id, "mute", pending), null);
    await _test.deletePreviousNotice(guild, { channelId: channel.id, messageId: "missing" });
    channel.messages.fetch = async () => { throw new Error("message unavailable"); };
    await _test.deletePreviousNotice(guild, { channelId: channel.id, messageId: "missing-again" });
    channel.send = async () => { throw new Error("send unavailable"); };
    assert.equal(await _test.sendUnauthorizedNotice(guild, "another-actor", target.id), false);
});

test("member elevation and removal clear locks without affecting a different member", async () => {
    const elevated = member("elevated", true);
    const gone = member("gone");
    const guild = guildFixture([elevated, gone]);
    elevated.guild = guild;
    gone.guild = guild;
    _test.setCachedLock({ guildId: guild.id, userId: elevated.id, muteLocked: true, muteVersion: "a" });
    _test.setCachedLock({ guildId: guild.id, userId: gone.id, deafLocked: true, deafVersion: "b" });
    voiceAdmin.handleMemberUpdate(null, elevated);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getLock(guild.id, elevated.id), null);
    voiceAdmin.handleMemberRemove(gone);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getLock(guild.id, gone.id), null);
});

test("persistence exceptions and version conflicts fail closed without changing the cached lock", async () => {
    assert.equal(_test.lockKey("g", "u"), "g:u");
    VoiceAdminLock.updateOne = async () => { throw new Error("mongo down"); };
    await assert.rejects(() => _test.writeLock("g", "u", "mute", "owner"), { code: "VOICE_ADMIN_PERSISTENCE_FAILED" });
    VoiceAdminLock.updateOne = async () => ({ acknowledged: true, matchedCount: 0, upsertedCount: 0 });
    await assert.rejects(() => _test.clearLockField("g", "u", "mute", "old-version"), { code: "VOICE_ADMIN_LOCK_CONFLICT" });
    assert.equal(_test.getLock("g", "u"), null);
});

test("temporary Administrator lock is not persisted, while a failed unlock restores its version", async () => {
    const admin = member("admin", true);
    const target = member("target", false, { failMute: true });
    const guild = guildFixture([admin, target]);
    voiceChannel(guild, [admin, target]);
    const temporary = await _test.lockVoiceState(guild, [admin], "mute", "owner");
    assert.equal(temporary.succeeded, 1);
    assert.equal(_test.getLock(guild.id, admin.id), null);
    _test.setCachedLock({ guildId: guild.id, userId: target.id, muteLocked: true, muteVersion: "restore", muteLockedBy: "owner" });
    const result = await _test.unlockVoiceState(guild, [target], "mute");
    assert.equal(result.failed, 1);
    assert.equal(_test.getLock(guild.id, target.id).muteLocked, true);
});

test("///ปิดไมค์หมด persists an Owner-only mute lock for Administrators and ordinary members", async () => {
    const targetAdmin = member("target-admin", true);
    const regular = member("regular");
    const owner = member(config.system.ownerId, true);
    const guild = guildFixture([targetAdmin, regular, owner]);
    const channel = voiceChannel(guild, [targetAdmin, regular, owner]);
    const replies = [];
    const message = {
        guild, channel,
        author: { id: config.system.ownerId, bot: false },
        content: "///ปิดไมค์หมด",
        async reply(payload) { replies.push(payload); }
    };

    assert.equal(await voiceAdmin.handleSecretMessage(message), true);
    assert.equal(_test.getLock(guild.id, targetAdmin.id).muteOwnerForced, true);
    assert.equal(_test.getLock(guild.id, regular.id).muteOwnerForced, true);
    assert.equal(_test.getLock(guild.id, owner.id), null);
    assert.deepEqual(targetAdmin.calls.at(-1), ["mute", true]);
    assert.match(replies.at(-1).content, /สำเร็จ 2 คน/);
});

test("an Administrator cannot release an Owner-forced mute but the configured Owner can", async () => {
    const targetAdmin = member("target-admin", true);
    const owner = member(config.system.ownerId, true);
    const guild = guildFixture([targetAdmin, owner]);
    const channel = voiceChannel(guild, [targetAdmin, owner]);
    const lockedAt = Date.now() - 1;
    _test.setCachedLock({
        guildId: guild.id, userId: targetAdmin.id,
        muteLocked: true, muteVersion: "owner-lock", muteLockedAt: lockedAt,
        muteLockedBy: config.system.ownerId, muteOwnerForced: true
    });

    voiceAdmin.handleVoiceStateUpdate(
        { guild, id: targetAdmin.id, member: targetAdmin, channel, serverMute: true },
        { guild, id: targetAdmin.id, member: targetAdmin, channel, serverMute: false },
        { user: { id: "bot" } }
    );
    voiceAdmin.handleAuditLogEntry({
        id: "admin-self-unmute", action: AuditLogEvent.MemberUpdate,
        targetId: targetAdmin.id, executorId: targetAdmin.id,
        createdTimestamp: Date.now(), changes: [{ key: "mute", new: false }]
    }, guild, { user: { id: "bot" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getLock(guild.id, targetAdmin.id).muteOwnerForced, true);
    assert.deepEqual(targetAdmin.calls.at(-1), ["mute", true]);

    const panelUnlock = await _test.unlockVoiceState(guild, [targetAdmin], "mute");
    assert.equal(panelUnlock.failed, 1);
    assert.equal(_test.getLock(guild.id, targetAdmin.id).muteOwnerForced, true);

    voiceAdmin.handleVoiceStateUpdate(
        { guild, id: targetAdmin.id, member: targetAdmin, channel, serverMute: true },
        { guild, id: targetAdmin.id, member: targetAdmin, channel, serverMute: false },
        { user: { id: "bot" } }
    );
    voiceAdmin.handleAuditLogEntry({
        id: "owner-unmute", action: AuditLogEvent.MemberUpdate,
        targetId: targetAdmin.id, executorId: config.system.ownerId,
        createdTimestamp: Date.now(), changes: [{ key: "mute", new: false }]
    }, guild, { user: { id: "bot" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(_test.getLock(guild.id, targetAdmin.id), null);
});

test("permission and component errors stay ephemeral and panel actions cover mute and move", async () => {
    const target = member("target");
    const admin = member("admin", true);
    const guild = guildFixture([target, admin]);
    const source = voiceChannel(guild, [target, admin]);
    const destination = voiceChannel(guild, [], "destination");
    const denied = { ...source, permissionsFor: () => ({ has: () => false }) };
    await assert.rejects(() => _test.ensureBotPermission(guild, denied, "mute"), { code: "VOICE_ADMIN_BOT_PERMISSION_MISSING" });
    const interaction = { member: admin, user: admin, channel: source, guild };
    assert.equal((await _test.runPanelAction(interaction, "mute")).succeeded, 1);
    assert.equal((await _test.runPanelAction(interaction, "move", destination)).succeeded, 1);
    await assert.rejects(() => _test.runPanelAction(interaction, "invalid"), { code: "VOICE_ADMIN_ACTION_INVALID" });
    const noAccess = { member: target, channel: source, async reply(payload) { noAccess.payload = payload; } };
    await voiceAdmin.handleVoiceAdminInteraction(noAccess);
    assert.equal(noAccess.payload.ephemeral, true);
});

test("secret mute, deafen, unlock and move commands cover both prefixes", async () => {
    const target = member("target");
    const admin = member("admin", true);
    const owner = member(config.system.ownerId, true);
    const guild = guildFixture([target, admin, owner]);
    const source = voiceChannel(guild, [target, admin, owner]);
    const destination = voiceChannel(guild, [], "12345678901234567");
    const replies = [];
    const message = { guild, channel: source, author: { id: config.system.ownerId, bot: false }, content: "//ปิดไมค์หมด", async reply(payload) { replies.push(payload); } };
    await voiceAdmin.handleSecretMessage(message);
    assert.equal(_test.getLock(guild.id, target.id).muteLocked, true);
    message.content = "//ปิดหูหมด";
    await voiceAdmin.handleSecretMessage(message);
    assert.equal(_test.getLock(guild.id, target.id).deafLocked, true);
    message.content = "///เปิดหมด";
    await voiceAdmin.handleSecretMessage(message);
    assert.equal(_test.getLock(guild.id, target.id), null);
    message.content = "///ย้ายหมด 12345678901234567";
    await voiceAdmin.handleSecretMessage(message);
    assert.deepEqual(target.calls.at(-1), ["move", destination.id]);
    assert.ok(replies.length >= 4);
});

test("fallback fetch and cleanup failure callbacks are contained without leaking a rejection", async () => {
    const target = member("target");
    const owner = member(config.system.ownerId, true);
    const guild = guildFixture([target, owner]);
    const source = voiceChannel(guild, [target, owner]);
    const destination = voiceChannel(guild, [], "12345678901234567");
    guild.channels.cache.delete(destination.id);
    guild.channels.fetch = async id => id === destination.id ? destination : Promise.reject(new Error("not found"));
    const message = { guild, channel: source, author: { id: config.system.ownerId, bot: false }, content: "//ย้ายหมด 12345678901234567", async reply() {} };
    await voiceAdmin.handleSecretMessage(message);
    assert.deepEqual(target.calls.at(-1), ["move", destination.id]);
    guild.channels.cache.clear();
    await _test.deletePreviousNotice(guild, { channelId: "gone", messageId: "gone" });
    guild.members.cache.delete(target.id);
    guild.members.fetch = async () => { throw new Error("fetch failed"); };
    assert.equal(await _test.sendUnauthorizedNotice(guild, "actor", target.id), false);
    _test.setCachedLock({ guildId: guild.id, userId: owner.id, muteLocked: true, muteVersion: "e" });
    owner.guild = guild;
    VoiceAdminLock.deleteOne = async () => { throw new Error("delete failed"); };
    voiceAdmin.handleMemberUpdate(null, owner);
    voiceAdmin.handleMemberRemove(owner);
    await new Promise(resolve => setImmediate(resolve));
});
