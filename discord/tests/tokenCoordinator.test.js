'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tokenCoordinator = require('../core/tokenCoordinator');

test.beforeEach(() => {
    tokenCoordinator.reset();
});

test('tokenCoordinator correctly hashes tokens', () => {
    const raw = 'test-token-12345';
    const hash1 = tokenCoordinator.hashToken(raw);
    const hash2 = tokenCoordinator.hashToken(raw);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^[0-9a-f]{64}$/);

    // Recognizes precomputed hash
    assert.equal(tokenCoordinator.hashToken(hash1), hash1);
});

test('voice activity registration, querying, and unregistration lifecycle', () => {
    const token = 'token-voice-test';
    assert.equal(tokenCoordinator.isVoiceActive(token), false);
    assert.equal(tokenCoordinator.getVoiceActivity(token), null);

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-100',
        channelId: 'channel-200',
        sessionId: 'sess-300'
    });

    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    const act = tokenCoordinator.getVoiceActivity(token);
    assert.equal(act.guildId, 'guild-100');
    assert.equal(act.channelId, 'channel-200');
    assert.equal(act.sessionId, 'sess-300');

    tokenCoordinator.unregisterVoiceActivity(token);
    assert.equal(tokenCoordinator.isVoiceActive(token), false);
    assert.equal(tokenCoordinator.getVoiceActivity(token), null);
});

test('quest start, end, and active status tracking', () => {
    const token = 'token-quest-test';
    assert.equal(tokenCoordinator.isQuestActive(token), false);
    assert.equal(tokenCoordinator.shouldDebounceVoiceHealthCheck(token), false);

    tokenCoordinator.notifyQuestStart(token, { questId: 'q-456', mode: 'oneshot' });
    assert.equal(tokenCoordinator.isQuestActive(token), true);
    assert.equal(tokenCoordinator.shouldDebounceVoiceHealthCheck(token), true);

    tokenCoordinator.notifyQuestEnd(token);
    assert.equal(tokenCoordinator.isQuestActive(token), false);
    assert.equal(tokenCoordinator.shouldDebounceVoiceHealthCheck(token), false);
});

test('getSafeQuestHeartbeatPayload prioritizes applicationId when present', () => {
    const token = 'token-heartbeat-app';
    const quest = {
        id: 'q-app-1',
        applicationId: 'app-999'
    };
    const payload = tokenCoordinator.getSafeQuestHeartbeatPayload(token, quest, false);
    assert.deepEqual(payload, { application_id: 'app-999', terminal: false });
});

test('getSafeQuestHeartbeatPayload uses guild voice stream key when account is in voice', () => {
    const token = 'token-voice-concurrent';
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: '1530554002708631572',
        channelId: '1530554002708631575',
        sessionId: 'sess-active'
    });

    const questWithoutAppId = {
        id: 'q-game-fallback',
        applicationId: null
    };

    const payload = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questWithoutAppId, false);
    // MUST NOT use call: stream key because that drops the user from guild voice!
    assert.equal(payload.stream_key.startsWith('call:'), false);
    assert.equal(payload.stream_key, 'guild:1530554002708631572:1530554002708631575');
    assert.equal(payload.terminal, false);
});

test('getSafeQuestHeartbeatPayload falls back to call stream only when not in voice', () => {
    const token = 'token-no-voice';
    const questWithoutAppId = {
        id: 'q-game-standalone',
        applicationId: null
    };

    const payload = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questWithoutAppId, true);
    assert.equal(payload.stream_key, 'call:q-game-standalone:1');
    assert.equal(payload.terminal, true);
});

test('withTokenLock serializes operations on the same token in FIFO order', async () => {
    const token = 'token-lock-test';
    const executionOrder = [];

    const p1 = tokenCoordinator.withTokenLock(token, async () => {
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(1);
    });

    const p2 = tokenCoordinator.withTokenLock(token, async () => {
        executionOrder.push(2);
    });

    const p3 = tokenCoordinator.withTokenLock(token, async () => {
        executionOrder.push(3);
    });

    await Promise.all([p1, p2, p3]);
    assert.deepEqual(executionOrder, [1, 2, 3]);
});

test('executeWithToken executes successfully and tracks token activity', async () => {
    const token = 'token-exec-success';
    let executed = false;

    const res = await tokenCoordinator.executeWithToken(token, 'testSubsystem', async () => {
        executed = true;
        return { ok: true, data: 42 };
    });

    assert.equal(executed, true);
    assert.deepEqual(res, { ok: true, data: 42 });
    assert.equal(tokenCoordinator.isQuarantined(token), false);
});

test('executeWithToken catches HTTP 401, auto-quarantines token, and triggers subsystem hooks', async () => {
    const token = 'token-exec-401';
    let hookTriggered = false;
    let hookTokenHash = null;
    let hookReason = null;

    tokenCoordinator.registerSubsystem({
        name: 'mockVoice',
        onTokenQuarantined: (hash, reason) => {
            hookTriggered = true;
            hookTokenHash = hash;
            hookReason = reason;
        }
    });

    await assert.rejects(async () => {
        await tokenCoordinator.executeWithToken(token, 'mockVoice', async () => {
            const err = new Error('401 Unauthorized: Invalid Token');
            err.status = 401;
            throw err;
        });
    }, /401/);

    assert.equal(tokenCoordinator.isQuarantined(token), true);
    assert.equal(hookTriggered, true);
    assert.equal(hookTokenHash, tokenCoordinator.hashToken(token));
    assert.match(hookReason, /401/);

    // Subsequent call must be blocked immediately by quarantine guard
    await assert.rejects(async () => {
        await tokenCoordinator.executeWithToken(token, 'anotherSubsystem', async () => {
            return 'should-not-run';
        });
    }, (err) => err.code === 'TOKEN_QUARANTINED');

    // Releasing quarantine allows execution again
    tokenCoordinator.releaseQuarantine(token);
    assert.equal(tokenCoordinator.isQuarantined(token), false);

    const afterRelease = await tokenCoordinator.executeWithToken(token, 'anotherSubsystem', async () => {
        return 'now-it-runs';
    });
    assert.equal(afterRelease, 'now-it-runs');
});

test('token profile cache stores, retrieves, and handles TTL expiration and manual clearing', async () => {
    const token = 'token-profile-cache';
    const profile = { id: '123456789', username: 'TestUser', nitro: 'Nitro Basic' };

    // Initially not cached
    assert.equal(tokenCoordinator.getCachedTokenProfile(token), null);

    // Cache with normal TTL
    tokenCoordinator.cacheTokenProfile(token, profile, 60000);
    assert.deepEqual(tokenCoordinator.getCachedTokenProfile(token), profile);

    // Manual single token clear
    tokenCoordinator.clearTokenProfileCache(token);
    assert.equal(tokenCoordinator.getCachedTokenProfile(token), null);

    // Cache with expired TTL
    tokenCoordinator.cacheTokenProfile(token, profile, -100);
    assert.equal(tokenCoordinator.getCachedTokenProfile(token), null);
});

test('getStatusSummary aggregates active tokens, voice, quest, and quarantine metrics', () => {
    const tokenVoice = 'token-summary-voice';
    const tokenQuest = 'token-summary-quest';
    const tokenDead = 'token-summary-dead';

    tokenCoordinator.registerVoiceActivity(tokenVoice, {
        guildId: 'g1',
        channelId: 'c1',
        sessionId: 's1'
    });

    tokenCoordinator.notifyQuestStart(tokenQuest, { questId: 'quest-99' });
    tokenCoordinator.quarantineToken(tokenDead, 'Expired token');

    const summary = tokenCoordinator.getStatusSummary();
    assert.equal(summary.activeTokens, 3);
    assert.equal(summary.voiceSessionsCount, 1);
    assert.equal(summary.questSessionsCount, 1);
    assert.equal(summary.quarantinedCount, 1);
    assert.equal(summary.quarantinedTokens[0].reason, 'Expired token');
});

test('rate limiter allows burst within capacity without delay', async () => {
    const token = 'token-burst-test';
    const start = Date.now();

    // Fire 3 immediate requests (within capacity of 4)
    await Promise.all([
        tokenCoordinator.executeWithToken(token, 'sub1', async () => 1),
        tokenCoordinator.executeWithToken(token, 'sub2', async () => 2),
        tokenCoordinator.executeWithToken(token, 'sub3', async () => 3)
    ]);

    const elapsed = Date.now() - start;
    // Burst should complete in under 50ms without waiting for refill
    assert.ok(elapsed < 100, `Burst took too long: ${elapsed}ms`);
});

test('Dynamic Activity Registry supports arbitrary subsystems concurrently', () => {
    const token = 'token-dyn-subsystem';
    assert.equal(tokenCoordinator.hasActivity(token, 'customSync'), false);
    assert.equal(tokenCoordinator.hasActivity(token, 'profileSync'), false);

    tokenCoordinator.acquireActivity(token, 'customSync', { syncId: 's-123' });
    tokenCoordinator.acquireActivity(token, 'profileSync', { interval: 60 });

    assert.equal(tokenCoordinator.hasActivity(token, 'customSync'), true);
    assert.equal(tokenCoordinator.hasActivity(token, 'profileSync'), true);

    const acts = tokenCoordinator.getActivities(token);
    assert.equal(acts.length, 2);
    const subNames = acts.map(a => a.subsystem);
    assert.ok(subNames.includes('customSync'));
    assert.ok(subNames.includes('profileSync'));

    tokenCoordinator.releaseActivity(token, 'customSync');
    assert.equal(tokenCoordinator.hasActivity(token, 'customSync'), false);
    assert.equal(tokenCoordinator.hasActivity(token, 'profileSync'), true);

    tokenCoordinator.releaseActivity(token, 'profileSync');
    assert.equal(tokenCoordinator.hasActivity(token, 'profileSync'), false);
});

test('Event Bus emits token lifecycle events', async () => {
    const token = 'token-eventbus-test';
    const eventsCaught = [];

    tokenCoordinator.on('token:activity_start', (e) => eventsCaught.push({ type: 'start', sub: e.subsystem }));
    tokenCoordinator.on('token:activity_end', (e) => eventsCaught.push({ type: 'end', sub: e.subsystem }));
    tokenCoordinator.on('token:quarantined', (e) => eventsCaught.push({ type: 'quarantine', reason: e.reason }));
    tokenCoordinator.on('token:released', () => eventsCaught.push({ type: 'released' }));

    tokenCoordinator.acquireActivity(token, 'customWorker', { foo: 'bar' });
    tokenCoordinator.releaseActivity(token, 'customWorker');
    tokenCoordinator.quarantineToken(token, 'Testing event bus');
    tokenCoordinator.releaseQuarantine(token);

    assert.deepEqual(eventsCaught.map(e => e.type), ['start', 'end', 'quarantine', 'released']);
});

test('429 rate limit backoff pauses token and automatically retries smoothly', async () => {
    const token = 'token-429-test';
    let attempts = 0;

    const result = await tokenCoordinator.executeWithToken(token, 'testSub', async () => {
        attempts++;
        if (attempts === 1) {
            const err = new Error('429 Too Many Requests');
            err.status = 429;
            err.retry_after = 0.1; // 100ms
            throw err;
        }
        return 'success-after-429';
    });

    assert.equal(attempts, 2);
    assert.equal(result, 'success-after-429');
});

test('runTask executes operation with automatic activity lifecycle and timeout protection', async () => {
    const token = 'token-runtask-test';
    let activitySeenDuringRun = false;

    const result = await tokenCoordinator.runTask(token, { subsystem: 'futurePlugin', timeoutMs: 1000 }, async () => {
        activitySeenDuringRun = tokenCoordinator.hasActivity(token, 'futurePlugin');
        return 'plugin-output';
    });

    assert.equal(result, 'plugin-output');
    assert.equal(activitySeenDuringRun, true);
    assert.equal(tokenCoordinator.hasActivity(token, 'futurePlugin'), false);
});

test('quarantine alert is throttled within cooldown window', () => {
    const token = 'token-throttle-alert';
    const originalCooldown = tokenCoordinator.alertCooldownMs;
    tokenCoordinator.alertCooldownMs = 10000; // 10s cooldown

    try {
        const hash = tokenCoordinator.hashToken(token);
        tokenCoordinator.quarantineToken(token, 'First alert');
        const firstTime = tokenCoordinator.alertHistory.get(hash);
        assert.ok(firstTime > 0);

        // Immediate second quarantine call should be throttled (alertHistory timestamp unchanged)
        tokenCoordinator.quarantineToken(token, 'Second alert');
        const secondTime = tokenCoordinator.alertHistory.get(hash);
        assert.equal(secondTime, firstTime);
    } finally {
        tokenCoordinator.alertCooldownMs = originalCooldown;
    }
});

test('tokenType management and formatAuthHeader support both User and Bot tokens', () => {
    const userToken = 'user-token-example-123';
    const botToken = 'bot-token-example-456';

    // Defaults to 'unknown' before being set
    assert.equal(tokenCoordinator.getTokenType(userToken), 'unknown');
    assert.equal(tokenCoordinator.formatAuthHeader(userToken), userToken);

    // Set as user token
    tokenCoordinator.setTokenType(userToken, 'user');
    assert.equal(tokenCoordinator.getTokenType(userToken), 'user');
    assert.equal(tokenCoordinator.formatAuthHeader(userToken), userToken);

    // Set as bot token
    tokenCoordinator.setTokenType(botToken, 'bot');
    assert.equal(tokenCoordinator.getTokenType(botToken), 'bot');
    assert.equal(tokenCoordinator.formatAuthHeader(botToken), `Bot ${botToken}`);

    // If bot token already has 'Bot ' prefix, formatAuthHeader does not double-prefix
    assert.equal(tokenCoordinator.formatAuthHeader(`Bot ${botToken}`), `Bot ${botToken}`);

    // Explicit override in formatAuthHeader
    assert.equal(tokenCoordinator.formatAuthHeader(userToken, 'bot'), `Bot ${userToken}`);
    assert.equal(tokenCoordinator.formatAuthHeader(botToken, 'user'), botToken);
});

test('cacheTokenProfile sets tokenType to bot when profile.isBot is true', () => {
    const token = 'bot-cache-token-789';
    tokenCoordinator.cacheTokenProfile(token, {
        id: '123456789012345678',
        username: 'CoolBot',
        isBot: true,
        category: 'bot'
    });

    assert.equal(tokenCoordinator.getTokenType(token), 'bot');
    const profile = tokenCoordinator.getCachedTokenProfile(token);
    assert.ok(profile);
    assert.equal(profile.isBot, true);
    assert.equal(profile.tokenType, 'bot');
});

test('executeWithToken allows bypassQuarantine when probing tokens', async () => {
    const token = 'quarantined-token-probe';
    tokenCoordinator.quarantineToken(token, 'Pre-existing 401 error');

    assert.equal(tokenCoordinator.isQuarantined(token), true);

    // Default call throws TOKEN_QUARANTINED
    await assert.rejects(
        () => tokenCoordinator.executeWithToken(token, 'testSub', async () => 'ok'),
        /TOKEN_QUARANTINED/
    );

    // bypassQuarantine: true allows probe to execute
    const probeResult = await tokenCoordinator.executeWithToken(token, 'testSub', async () => 'probe-success', {
        bypassQuarantine: true
    });
    assert.equal(probeResult, 'probe-success');
});
