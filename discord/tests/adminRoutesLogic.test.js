'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    validateCommandToggleRequest,
    getCommandToggleCooldown,
    createCommandTogglePlan,
    persistCommandToggle,
    recordCommandToggleAudit,
    buildApprovedKickWarning,
    removeApprovedGuildRecord,
    stopGuildVoiceSessions,
    handleCommandToggle,
    handleApprovedGuildKick
} = require('../index/adminRoutes');

test('validateCommandToggleRequest: rejects missing or non-string command names', () => {
    const commands = { slashCommandsData: [{ name: 'ping' }] };
    assert.deepEqual(validateCommandToggleRequest(commands, null), {
        ok: false,
        status: 400,
        error: 'ไม่ระบุชื่อคำสั่ง'
    });
    assert.deepEqual(validateCommandToggleRequest(commands, ''), {
        ok: false,
        status: 400,
        error: 'ไม่ระบุชื่อคำสั่ง'
    });
    assert.deepEqual(validateCommandToggleRequest(commands, 123), {
        ok: false,
        status: 400,
        error: 'ไม่ระบุชื่อคำสั่ง'
    });
});

test('validateCommandToggleRequest: rejects commands not present in slashCommandsData', () => {
    const commands = { slashCommandsData: [{ name: 'ping' }] };
    assert.deepEqual(validateCommandToggleRequest(commands, 'unknown'), {
        ok: false,
        status: 404,
        error: 'ไม่พบคำสั่ง /unknown'
    });
});

test('validateCommandToggleRequest: accepts existing command', () => {
    const commands = { slashCommandsData: [{ name: 'ping' }, { name: 'help' }] };
    assert.deepEqual(validateCommandToggleRequest(commands, 'ping'), {
        ok: true,
        commandName: 'ping'
    });
});

test('getCommandToggleCooldown: calculates cooldown properly', () => {
    const cooldowns = new Map();
    const key = 'user1:ping';
    const now = 100000;

    // No prior toggle
    assert.equal(getCommandToggleCooldown(cooldowns, key, now), 0);

    // Recent toggle 2s ago (cooldown is 5000ms, remaining should be 3000ms)
    cooldowns.set(key, now - 2000);
    assert.equal(getCommandToggleCooldown(cooldowns, key, now), 3000);

    // Old toggle 6s ago (cooldown expired)
    cooldowns.set(key, now - 6000);
    assert.equal(getCommandToggleCooldown(cooldowns, key, now), 0);
});

test('createCommandTogglePlan: toggles command presence in disabled set', () => {
    const disabled = new Set(['help']);

    // Enabling 'help' by removing it from disabled
    const plan1 = createCommandTogglePlan(disabled, 'help');
    assert.equal(plan1.nowEnabled, true);
    assert.equal(plan1.nextDisabledCommands.has('help'), false);

    // Disabling 'ping' by adding it to disabled
    const plan2 = createCommandTogglePlan(disabled, 'ping');
    assert.equal(plan2.nowEnabled, false);
    assert.equal(plan2.nextDisabledCommands.has('ping'), true);
});

test('persistCommandToggle: updates sessionManager and active disabledCommands set on success', async () => {
    const disabled = new Set(['old']);
    let savedKey = null;
    let savedVal = null;

    const sessionManager = {
        async setSetting(key, val) {
            savedKey = key;
            savedVal = val;
            return true;
        }
    };

    const res = await persistCommandToggle(sessionManager, disabled, 'ping');
    assert.equal(res.ok, true);
    assert.equal(res.nowEnabled, false);
    assert.equal(savedKey, 'disabledCommands');
    assert.deepEqual(savedVal.sort(), ['old', 'ping'].sort());
    assert.equal(disabled.has('ping'), true);
});

test('persistCommandToggle: handles persistence failure gracefully', async () => {
    const disabled = new Set(['ping']);
    const sessionManager = {
        async setSetting() {
            return false;
        }
    };

    const res = await persistCommandToggle(sessionManager, disabled, 'ping');
    assert.equal(res.ok, false);
    assert.equal(res.nowEnabled, false);
    assert.equal(disabled.has('ping'), true); // Set remains unchanged
});

test('recordCommandToggleAudit: records logs and evicts oldest entries at limit', () => {
    const auditLog = [];
    for (let i = 0; i < 100; i++) {
        recordCommandToggleAudit(auditLog, `cmd${i}`, true, 'ip#1', 1000 + i);
    }
    assert.equal(auditLog.length, 100);
    assert.equal(auditLog[0].commandName, 'cmd0');

    // Add 101st entry
    recordCommandToggleAudit(auditLog, 'cmd100', false, 'ip#2', 2000);
    assert.equal(auditLog.length, 100);
    assert.equal(auditLog[0].commandName, 'cmd1');
    assert.equal(auditLog[99].commandName, 'cmd100');
    assert.equal(auditLog[99].action, 'disabled');
});

test('buildApprovedKickWarning: formats warnings for partial failures', () => {
    assert.equal(buildApprovedKickWarning(0, false), null);
    assert.equal(
        buildApprovedKickWarning(1, false),
        'บอทถูกนำออกแล้ว แต่มี voice sessions บางรายการหยุดไม่สำเร็จ'
    );
    assert.equal(
        buildApprovedKickWarning(0, true),
        'บอทถูกนำออกแล้ว แต่ลบ approved guild record ไม่สำเร็จ'
    );
    assert.equal(
        buildApprovedKickWarning(2, true),
        'บอทถูกนำออกแล้ว แต่มี voice sessions บางรายการหยุดไม่สำเร็จ | บอทถูกนำออกแล้ว แต่ลบ approved guild record ไม่สำเร็จ'
    );
});

test('removeApprovedGuildRecord: deletes guild record or retries on failure', async () => {
    let callCount = 0;
    const sessionManagerSuccess = {
        ApprovedGuildModel: {
            async deleteOne() {
                callCount++;
                return { deletedCount: 1 };
            }
        }
    };

    const ok = await removeApprovedGuildRecord(sessionManagerSuccess, '123456');
    assert.equal(ok, true);
    assert.equal(callCount, 1);

    // Failure with retry exhausted
    let failAttempts = 0;
    const sessionManagerFail = {
        ApprovedGuildModel: {
            async deleteOne() {
                failAttempts++;
                throw new Error('database locked');
            }
        }
    };

    const failRes = await removeApprovedGuildRecord(sessionManagerFail, '123456', 2);
    assert.equal(failRes, false);
    assert.equal(failAttempts, 2);
});

test('stopGuildVoiceSessions: stops only matching guild sessions', async () => {
    const sessions = new Map([
        ['s1', { sessionId: 's1', serverId: 'guild-a' }],
        ['s2', { sessionId: 's2', serverId: 'guild-b' }],
        ['s3', { sessionId: 's3', serverId: 'guild-a' }]
    ]);

    const stopped = [];
    const voiceWorker = {
        async stopSession(id, opts) {
            stopped.push({ id, opts });
            return true;
        }
    };

    const sessionManager = {
        getAllSessions() {
            return sessions;
        }
    };

    const failedCount = await stopGuildVoiceSessions(sessionManager, voiceWorker, 'guild-a');
    assert.equal(failedCount, 0);
    assert.equal(stopped.length, 2);
    assert.deepEqual(stopped.map(s => s.id).sort(), ['s1', 's3']);
});

test('handleCommandToggle: enforces authentication, validation, cooldown, and handles execution', async () => {
    const commands = { slashCommandsData: [{ name: 'status' }] };
    const disabledCommands = new Set();
    const commandAuditLog = [];
    const toggleCooldowns = new Map();
    const sessionManager = {
        async setSetting() {
            return true;
        }
    };

    function createMockRes() {
        const res = {
            statusCode: 200,
            body: null,
            status(code) {
                res.statusCode = code;
                return res;
            },
            json(payload) {
                res.body = payload;
                return res;
            }
        };
        return res;
    }

    // 1. Auth rejected
    const unauthReq = { body: { commandName: 'status' }, ip: '127.0.0.1' };
    const unauthRes = createMockRes();
    await handleCommandToggle({
        req: unauthReq,
        res: unauthRes,
        checkAuth: () => false,
        commands,
        sessionManager,
        disabledCommands,
        commandAuditLog,
        toggleCooldowns
    });
    assert.equal(unauthRes.body, null);

    // 2. Invalid command
    const invalidReq = { body: { commandName: 'missing' }, ip: '127.0.0.1' };
    const invalidRes = createMockRes();
    await handleCommandToggle({
        req: invalidReq,
        res: invalidRes,
        checkAuth: () => true,
        commands,
        sessionManager,
        disabledCommands,
        commandAuditLog,
        toggleCooldowns
    });
    assert.equal(invalidRes.statusCode, 404);
    assert.equal(invalidRes.body.success, false);

    // 3. Successful toggle
    const validReq = { body: { commandName: 'status' }, ip: '127.0.0.1' };
    const validRes = createMockRes();
    await handleCommandToggle({
        req: validReq,
        res: validRes,
        checkAuth: () => true,
        commands,
        sessionManager,
        disabledCommands,
        commandAuditLog,
        toggleCooldowns,
        now: () => 500000
    });
    assert.equal(validRes.statusCode, 200);
    assert.equal(validRes.body.success, true);
    assert.equal(validRes.body.enabled, false);

    // 4. Cooldown triggered immediately after
    const cdRes = createMockRes();
    await handleCommandToggle({
        req: validReq,
        res: cdRes,
        checkAuth: () => true,
        commands,
        sessionManager,
        disabledCommands,
        commandAuditLog,
        toggleCooldowns,
        now: () => 501000 // 1s later
    });
    assert.equal(cdRes.statusCode, 429);
    assert.equal(cdRes.body.success, false);
});

test('handleApprovedGuildKick: handles unauth, missing guildId, missing guild and success', async () => {
    function createMockRes() {
        const res = {
            statusCode: 200,
            body: null,
            status(code) {
                res.statusCode = code;
                return res;
            },
            json(payload) {
                res.body = payload;
                return res;
            }
        };
        return res;
    }

    const sessionManager = {
        getAllSessions() {
            return new Map();
        },
        ApprovedGuildModel: {
            async deleteOne() {
                return { deletedCount: 1 };
            }
        }
    };
    const voiceWorker = {
        async stopSession() {
            return true;
        }
    };

    // 1. Missing guildId
    const badReq = { body: {} };
    const badRes = createMockRes();
    await handleApprovedGuildKick({
        req: badReq,
        res: badRes,
        checkAuth: () => true,
        client: { guilds: { cache: new Map() } },
        sessionManager,
        voiceWorker
    });
    assert.equal(badRes.statusCode, 400);

    // 2. Guild not found in cache
    const notFoundReq = { body: { guildId: 'g999' } };
    const notFoundRes = createMockRes();
    await handleApprovedGuildKick({
        req: notFoundReq,
        res: notFoundRes,
        checkAuth: () => true,
        client: { guilds: { cache: new Map() } },
        sessionManager,
        voiceWorker
    });
    assert.equal(notFoundRes.statusCode, 404);
    assert.equal(notFoundRes.body.approvalRemoved, true);

    // 3. Guild found and left successfully
    let left = false;
    const mockGuild = {
        id: 'g1',
        name: 'Test Guild',
        iconURL() { return 'https://cdn.discordapp.com/icons/g1/icon.png'; },
        async leave() { left = true; }
    };
    const client = {
        guilds: {
            cache: new Map([['g1', mockGuild]])
        }
    };

    const goodReq = { body: { guildId: 'g1' } };
    const goodRes = createMockRes();
    await handleApprovedGuildKick({
        req: goodReq,
        res: goodRes,
        checkAuth: () => true,
        client,
        sessionManager,
        voiceWorker
    });
    assert.equal(goodRes.statusCode, 200);
    assert.equal(goodRes.body.success, true);
    assert.equal(left, true);
});
