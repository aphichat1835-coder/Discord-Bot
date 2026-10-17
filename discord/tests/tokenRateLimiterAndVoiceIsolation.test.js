'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tokenCoordinator = require('../tokens/tokenCoordinator');

// Pre-warm lazy requires so subsequent backoff timing assertions are precise
try {
    tokenCoordinator.applyTokenBackoff('warmup-token', 10, { subsystem: 'warmup' });
} catch {}

test.beforeEach(() => {
    tokenCoordinator.reset();
});

// ══════════════════════════════════════════════════════════════════════════════
// PART A: TOKEN RATE LIMITER CONCURRENCY & RESERVATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

test('Rate Limiter: concurrent requests exceeding initial capacity are paced correctly via queue', async () => {
    const token = 'token-rate-limit-concurrency';
    const totalRequests = 8;
    const completedTimestamps = [];

    // Capacity is 4, refill rate is 2 per second (1 token per 500ms)
    const promises = Array.from({ length: totalRequests }, (_, i) =>
        tokenCoordinator.executeWithToken(token, 'worker', async () => {
            completedTimestamps.push(Date.now());
            return i;
        }, { maxWaitMs: 10000 })
    );

    const results = await Promise.all(promises);
    assert.equal(results.length, totalRequests);

    // First 4 requests should execute almost immediately (burst)
    const burstCompleted = completedTimestamps.slice(0, 4);
    const burstDuration = burstCompleted[3] - burstCompleted[0];
    assert.ok(burstDuration < 150, `Initial burst duration was ${burstDuration}ms`);

    // The remaining 4 requests must wait for refill: at 2 tokens/sec, each takes ~500ms
    const totalDuration = completedTimestamps[completedTimestamps.length - 1] - completedTimestamps[0];
    assert.ok(totalDuration >= 1800, `Total duration for 8 requests was ${totalDuration}ms, expected >= 1800ms`);
});

test('Rate Limiter: concurrent requests when bucket is exhausted do not thunder-herd', async () => {
    const token = 'token-exhausted-herd';

    // Exhaust initial capacity
    for (let i = 0; i < 4; i++) {
        await tokenCoordinator.executeWithToken(token, 'drain', async () => 'drained');
    }

    // Now fire 4 concurrent requests when bucket is empty
    const startTime = Date.now();
    const timestamps = [];
    const promises = Array.from({ length: 4 }, (_, i) =>
        tokenCoordinator.executeWithToken(token, 'concurrentDrain', async () => {
            timestamps.push(Date.now() - startTime);
            return i;
        }, { maxWaitMs: 5000 })
    );

    await Promise.all(promises);
    assert.equal(timestamps.length, 4);

    // Each request must be paced by refill (refillRatePerSec = 2 => ~500ms between each)
    for (let i = 1; i < timestamps.length; i++) {
        const gap = timestamps[i] - timestamps[i - 1];
        assert.ok(gap >= 350, `Gap between request ${i - 1} and ${i} was only ${gap}ms, expected >= 350ms`);
    }
});

test('Rate Limiter: respects shared backoff across different subsystems using same token', async () => {
    const token = 'token-shared-backoff';

    const startTime = Date.now();
    // Apply 400ms backoff
    tokenCoordinator.applyTokenBackoff(token, 400, { subsystem: 'subsystemA', reason: '429_test' });

    let subBExecutedAt = 0;

    // Subsystem B attempts to execute on the same token
    await tokenCoordinator.executeWithToken(token, 'subsystemB', async () => {
        subBExecutedAt = Date.now();
        return 'done';
    }, { maxWaitMs: 3000 });

    const elapsed = subBExecutedAt - startTime;
    assert.ok(elapsed >= 350, `Subsystem B waited only ${elapsed}ms, expected to honor shared backoff >= 350ms`);
});

test('Rate Limiter: parses retry-after in various header and error formats', () => {
    // 1. HTTP header format string in seconds
    const err1 = { response: { headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1.5' : null } } };
    assert.equal(tokenCoordinator._parse429WaitMs(err1), 1600); // 1500 + 100

    // 2. Object headers with case insensitivity
    const err2 = { headers: { 'Retry-After': '2' } };
    assert.equal(tokenCoordinator._parse429WaitMs(err2), 2100);

    // 3. DiscordAPIError retryAfter in milliseconds
    const err3 = { retryAfter: 800 };
    assert.equal(tokenCoordinator._parse429WaitMs(err3), 900); // 800 + 100

    // 4. DiscordAPIError retry_after in seconds (< 100)
    const err4 = { retry_after: 3.5 };
    assert.equal(tokenCoordinator._parse429WaitMs(err4), 3600);

    // 5. Raw error payload retry_after
    const err5 = { rawError: { retry_after: 500 } }; // 500ms (> 100)
    assert.equal(tokenCoordinator._parse429WaitMs(err5), 600);

    // 6. Minimum bounded floor check
    const errMin = { retry_after: 0.05 }; // 50ms
    assert.ok(tokenCoordinator._parse429WaitMs(errMin) >= 300);
});

test('Rate Limiter: timeout rejects gracefully without corrupting subsequent queue items', async () => {
    const token = 'token-timeout-queue';

    // Drain capacity
    for (let i = 0; i < 4; i++) {
        await tokenCoordinator.executeWithToken(token, 'drain', async () => 'ok');
    }

    // Queue item 1 with short maxWaitMs (100ms) - should timeout because refill takes 500ms
    const timeoutPromise = tokenCoordinator.executeWithToken(token, 'timedOutTask', async () => 'never', { maxWaitMs: 100 });

    await assert.rejects(
        () => timeoutPromise,
        (err) => err.code === 'RATE_LIMIT_TIMEOUT'
    );

    // Queue item 2 with sufficient maxWaitMs (3000ms) - should still succeed when refilled!
    const successResult = await tokenCoordinator.executeWithToken(token, 'patientTask', async () => 'success', { maxWaitMs: 3000 });
    assert.equal(successResult, 'success');
});

test('Rate Limiter: priority CRITICAL is scheduled ahead of NORMAL in the queue without unlimited bypass', async () => {
    const token = 'token-priority-order';

    // Drain capacity
    for (let i = 0; i < 4; i++) {
        await tokenCoordinator.executeWithToken(token, 'drain', async () => 'ok');
    }

    const executionOrder = [];

    // Enqueue 2 NORMAL tasks
    const p1 = tokenCoordinator.executeWithToken(token, 'normalTask1', async () => {
        executionOrder.push('normal-1');
    }, { priority: 'NORMAL', maxWaitMs: 5000 });

    const p2 = tokenCoordinator.executeWithToken(token, 'normalTask2', async () => {
        executionOrder.push('normal-2');
    }, { priority: 'NORMAL', maxWaitMs: 5000 });

    // Enqueue CRITICAL task right after
    const pCrit = tokenCoordinator.executeWithToken(token, 'criticalVoiceKeepalive', async () => {
        executionOrder.push('critical-voice');
    }, { priority: 'CRITICAL', maxWaitMs: 5000 });

    await Promise.all([p1, p2, pCrit]);

    // Critical task jumps ahead of normal tasks waiting in the queue
    assert.deepEqual(executionOrder, ['critical-voice', 'normal-1', 'normal-2']);
});

test('Rate Limiter: different tokens do not block or serialize each other', async () => {
    const tokenA = 'token-independent-A';
    const tokenB = 'token-independent-B';

    // Drain token A
    for (let i = 0; i < 4; i++) {
        await tokenCoordinator.executeWithToken(tokenA, 'drainA', async () => 'ok');
    }

    const start = Date.now();
    // Token B has fresh capacity and should execute immediately without waiting for Token A
    const resB = await tokenCoordinator.executeWithToken(tokenB, 'taskB', async () => 'immediate-b');
    const elapsedB = Date.now() - start;

    assert.equal(resB, 'immediate-b');
    assert.ok(elapsedB < 100, `Token B took ${elapsedB}ms, expected immediate execution`);
});

test('runTask: timeout aborts controller and does not prematurely wipe ongoing activity state', async () => {
    const token = 'token-runtask-abort';
    let receivedSignal = null;

    const timeoutPromise = tokenCoordinator.runTask(token, { subsystem: 'longTask', timeoutMs: 150 }, async ({ signal }) => {
        receivedSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'late-result';
    });

    await assert.rejects(
        () => timeoutPromise,
        (err) => err.code === 'TASK_TIMEOUT'
    );

    // Verify AbortSignal was triggered
    assert.ok(receivedSignal);
    assert.equal(receivedSignal.aborted, true);

    // While the background promise is still sleeping, activity remains active
    assert.equal(tokenCoordinator.hasActivity(token, 'longTask'), true);

    // After background task finishes, activity is cleanly released
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(tokenCoordinator.hasActivity(token, 'longTask'), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// PART B: VOICE STATE SESSION ISOLATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

test('Voice State: Case A - Two sessions sharing same token preserve isolation when one closes', () => {
    const token = 'token-shared-sessions';

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-alpha',
        channelId: 'channel-alpha',
        sessionId: 'session-alpha-1'
    });

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-beta',
        channelId: 'channel-beta',
        sessionId: 'session-beta-2'
    });

    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-alpha-1'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-beta-2'), true);

    // Close session Alpha only
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-alpha-1' });

    // Session Alpha is gone, but Session Beta MUST still be active
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-alpha-1'), false);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-beta-2'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token), true);

    const activeVoice = tokenCoordinator.getVoiceActivity(token);
    assert.ok(activeVoice);
    assert.equal(activeVoice.sessionId, 'session-beta-2');
    assert.equal(activeVoice.guildId, 'guild-beta');
});

test('Voice State: Case B - Delayed Destroyed event from old session does not wipe new session', () => {
    const token = 'token-delayed-destroy';

    // Step 1: Session A is active
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-1',
        channelId: 'channel-1',
        sessionId: 'session-old-A'
    });

    // Step 2: Session B joins (e.g. reconnect or second server)
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-2',
        channelId: 'channel-2',
        sessionId: 'session-new-B'
    });

    // Step 3: Delayed Destroyed event for Session A arrives late
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-old-A' });

    // Session B must NOT be wiped
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-new-B'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.getVoiceActivity(token)?.sessionId, 'session-new-B');
});

test('Voice State: Case C - Idempotent repeated cleanup has no side effect on other sessions', () => {
    const token = 'token-repeated-cleanup';

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-stay',
        channelId: 'channel-stay',
        sessionId: 'session-stay'
    });

    // Repeated unregister calls for non-existent or already dead session
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-dead' });
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-dead' });
    tokenCoordinator.unregisterVoiceActivity(token, 'session-dead');

    // Remaining session must be completely unharmed
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-stay'), true);
    assert.equal(tokenCoordinator.getVoiceActivity(token)?.sessionId, 'session-stay');
});

test('Voice State: Case D - Safe Quest Heartbeat matches specific guild or falls back safely when ambiguous', () => {
    const token = 'token-quest-multisession';

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-111',
        channelId: 'channel-111',
        sessionId: 'session-111'
    });

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-222',
        channelId: 'channel-222',
        sessionId: 'session-222'
    });

    // Subcase 1: Quest specifies guildId matching guild-111 -> should pick guild-111
    const questWithGuild = { id: 'q-specific', guildId: 'guild-111' };
    const payload1 = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questWithGuild);
    assert.equal(payload1.stream_key, 'guild:guild-111:channel-111');

    // Subcase 2: Quest has no guildId and 2 sessions active -> ambiguous, fallback to call stream to prevent voice drop
    const questAmbiguous = { id: 'q-ambig' };
    const payload2 = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questAmbiguous);
    assert.equal(payload2.stream_key, 'call:q-ambig:1');

    // Subcase 3: After one session stops, single remaining session is unambiguously chosen
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-111' });
    const payload3 = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questAmbiguous);
    assert.equal(payload3.stream_key, 'guild:guild-222:channel-222');
});

test('Voice State: Case E - Different tokens remain completely isolated', () => {
    const tokenA = 'token-user-A';
    const tokenB = 'token-user-B';

    tokenCoordinator.registerVoiceActivity(tokenA, {
        guildId: 'guild-A',
        channelId: 'channel-A',
        sessionId: 'session-A'
    });

    tokenCoordinator.registerVoiceActivity(tokenB, {
        guildId: 'guild-B',
        channelId: 'channel-B',
        sessionId: 'session-B'
    });

    // Unregister token A
    tokenCoordinator.unregisterVoiceActivity(tokenA, { sessionId: 'session-A' });

    assert.equal(tokenCoordinator.isVoiceActive(tokenA), false);
    assert.equal(tokenCoordinator.isVoiceActive(tokenB), true);
    assert.equal(tokenCoordinator.getVoiceActivity(tokenB)?.sessionId, 'session-B');
});

test('Rate Limiter: queue reservation aborts cleanly when AbortSignal is triggered while queued', async () => {
    const token = 'token-queue-abort-signal';

    // Drain initial capacity
    for (let i = 0; i < 4; i++) {
        await tokenCoordinator.executeWithToken(token, 'drain', async () => 'ok');
    }

    const controller = new AbortController();
    const abortReason = new Error('Custom abort reason');

    const queuedPromise = tokenCoordinator.executeWithToken(token, 'abortedQueuedTask', async () => 'should-not-run', {
        maxWaitMs: 5000,
        signal: controller.signal
    });

    // Abort while waiting in queue
    setTimeout(() => {
        controller.abort(abortReason);
    }, 50);

    await assert.rejects(
        () => queuedPromise,
        (err) => err === abortReason || err.message === 'Custom abort reason'
    );

    // Ensure queue is clean and next request can execute when refilled
    const nextResult = await tokenCoordinator.executeWithToken(token, 'subsequentTask', async () => 'next-ok', {
        maxWaitMs: 3000
    });
    assert.equal(nextResult, 'next-ok');
});

test('Rate Limiter: operation rejection does not break or poison subsequent queue requests', async () => {
    const token = 'token-operation-rejection';

    // Queue operation that fails
    const failingPromise = tokenCoordinator.executeWithToken(token, 'failingTask', async () => {
        throw new Error('INTERNAL_OPERATION_FAILURE');
    });

    await assert.rejects(
        () => failingPromise,
        (err) => err.message === 'INTERNAL_OPERATION_FAILURE'
    );

    // Subsequent operation must still execute cleanly
    const followUp = await tokenCoordinator.executeWithToken(token, 'followUpTask', async () => 'follow-up-success');
    assert.equal(followUp, 'follow-up-success');
});

test('Rate Limiter: repeated 429 after retry throws and keeps coordinator in consistent state', async () => {
    const token = 'token-repeated-429';

    const err429 = new Error('429 Too Many Requests');
    err429.status = 429;
    err429.retryAfter = 100; // 100ms

    let attemptCount = 0;
    const repeated429Promise = tokenCoordinator.executeWithToken(token, 'repeated429Task', async () => {
        attemptCount++;
        throw err429;
    }, { retryOn429: true, maxWaitMs: 5000 });

    await assert.rejects(
        () => repeated429Promise,
        (err) => err.status === 429
    );

    assert.equal(attemptCount, 2, 'Should have attempted initial try and 1 retry');

    // Wait until backoff expires (300ms + buffer)
    await new Promise((r) => setTimeout(r, 400));

    // Next normal request must succeed
    const res = await tokenCoordinator.executeWithToken(token, 'recoveryTask', async () => 'recovered');
    assert.equal(res, 'recovered');
});

test('Voice State: Case F - Reconnect session registration is not wiped by old connection destroyed event', () => {
    const token = 'token-reconnect-lifecycle';

    // Step 1: Initial connection
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-reconnect',
        channelId: 'channel-reconnect',
        sessionId: 'session-gen-1'
    });

    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-gen-1'), true);

    // Step 2: Reconnection creates new connection / session
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-reconnect',
        channelId: 'channel-reconnect',
        sessionId: 'session-gen-2'
    });

    // Step 3: Old connection emits Destroyed
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-gen-1', guildId: 'guild-reconnect' });

    // Session 1 is gone, but Session 2 is preserved
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-gen-1'), false);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-gen-2'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.getVoiceActivity(token)?.sessionId, 'session-gen-2');
});

