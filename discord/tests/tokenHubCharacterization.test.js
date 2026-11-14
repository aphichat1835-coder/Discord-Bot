'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tokenCoordinator = require('../tokens/tokenCoordinator');
const oauthTokenManager = require('../tokens/oauthTokenManager');
const tokensIndex = require('../tokens');

test('Token Hub Entrypoint Contract: index.js exports match legacy references', () => {
    assert.equal(tokensIndex.tokenCoordinator, tokenCoordinator, 'tokens.tokenCoordinator must strictly equal tokenCoordinator singleton');
    assert.equal(tokensIndex.oauthTokenManager, oauthTokenManager, 'tokens.oauthTokenManager must strictly equal oauthTokenManager');
    assert.equal(tokensIndex.TokenCoordinator, tokenCoordinator.TokenCoordinator, 'TokenCoordinator class matches');
    assert.equal(typeof tokensIndex.TokenCoordinator, 'function');
    assert.equal(typeof tokenCoordinator.attachTelemetryListeners, 'function');
});

test('TokenCoordinator: Hashing and precomputed hash detection', () => {
    const raw = 'my-secret-token-value-999';
    const hash = tokenCoordinator.hashToken(raw);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(tokenCoordinator.hashToken(hash), hash, 'Precomputed 64-char hex hash is preserved');
    assert.equal(tokenCoordinator.hashToken(''), '');
    assert.equal(tokenCoordinator.hashToken(null), '');
});

test('TokenCoordinator: Same-token lock FIFO and parallel isolation', async () => {
    tokenCoordinator.reset();
    const tokenA = 'token-lock-a';
    const tokenB = 'token-lock-b';

    const order = [];
    const p1 = tokenCoordinator.withTokenLock(tokenA, async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push('a1');
    });
    const p2 = tokenCoordinator.withTokenLock(tokenA, async () => {
        order.push('a2');
    });
    const p3 = tokenCoordinator.withTokenLock(tokenB, async () => {
        order.push('b1');
    });

    await Promise.all([p1, p2, p3]);
    assert.equal(order.indexOf('a1') < order.indexOf('a2'), true, 'Token A operations run in FIFO order');
    assert.equal(order.includes('b1'), true, 'Token B operation runs in parallel');

    // Release after operation throws
    await assert.rejects(
        tokenCoordinator.withTokenLock(tokenA, async () => {
            throw new Error('Lock operation failed');
        }),
        /Lock operation failed/
    );

    // Subsequent operation on tokenA succeeds without deadlock
    let unlocked = false;
    await tokenCoordinator.withTokenLock(tokenA, async () => {
        unlocked = true;
    });
    assert.equal(unlocked, true, 'Subsequent lock succeeds after previous rejection');
});

test('TokenCoordinator: Activity lifecycle and event emission contracts', () => {
    tokenCoordinator.reset();
    const token = 'token-activity-test';
    const events = [];

    const onStart = (e) => events.push({ event: 'start', ...e });
    const onEnd = (e) => events.push({ event: 'end', ...e });
    tokenCoordinator.on('token:activity_start', onStart);
    tokenCoordinator.on('token:activity_end', onEnd);

    const acquired = tokenCoordinator.acquireActivity(token, 'customWorker', { jobId: 'job-1' });
    assert.equal(acquired, true);
    assert.equal(tokenCoordinator.hasActivity(token, 'customWorker'), true);

    const activities = tokenCoordinator.getActivities(token);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].subsystem, 'customWorker');
    assert.equal(activities[0].metadata.jobId, 'job-1');

    const released = tokenCoordinator.releaseActivity(token, 'customWorker');
    assert.equal(released, true);
    assert.equal(tokenCoordinator.hasActivity(token, 'customWorker'), false);

    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'start');
    assert.equal(events[0].subsystem, 'customWorker');
    assert.equal(events[1].event, 'end');
    assert.equal(events[1].subsystem, 'customWorker');

    tokenCoordinator.off('token:activity_start', onStart);
    tokenCoordinator.off('token:activity_end', onEnd);
});

test('TokenCoordinator: Multi-voice session registration and ambiguous release safety', () => {
    tokenCoordinator.reset();
    const token = 'token-multi-voice';

    // Register Session 1 and Session 2
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-1',
        channelId: 'chan-1',
        sessionId: 'session-1'
    });
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-2',
        channelId: 'chan-2',
        sessionId: 'session-2'
    });

    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-1'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-2'), true);

    // Release session-1 explicitly
    const rel1 = tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-1' });
    assert.equal(rel1, true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-1'), false);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-2'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.getVoiceActivity(token)?.sessionId, 'session-2');

    // Register another session to test ambiguous release
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-3',
        channelId: 'chan-3',
        sessionId: 'session-3'
    });

    // Ambiguous unregister without sessionId when 2 sessions exist returns false without wiping
    const ambiguousRel = tokenCoordinator.unregisterVoiceActivity(token);
    assert.equal(ambiguousRel, false, 'Ambiguous release when multiple sessions exist returns false');
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-2'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-3'), true);

    // Explicit unregister of remaining sessions
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-2' });
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-3' });
    assert.equal(tokenCoordinator.isVoiceActive(token), false);
});

test('TokenCoordinator: Isolation between tokens during backoff and quarantine', () => {
    tokenCoordinator.reset();
    const tokenA = 'token-isolation-a';
    const tokenB = 'token-isolation-b';

    tokenCoordinator.applyTokenBackoff(tokenA, 5000, { subsystem: 'test' });
    assert.equal(tokenCoordinator.tokenStates.get(tokenCoordinator.hashToken(tokenA))?.backoffUntil > Date.now(), true);
    assert.equal(tokenCoordinator.tokenStates.get(tokenCoordinator.hashToken(tokenB))?.backoffUntil || 0, 0);

    tokenCoordinator.quarantineToken(tokenA, 'Invalid Token');
    assert.equal(tokenCoordinator.isQuarantined(tokenA), true);
    assert.equal(tokenCoordinator.isQuarantined(tokenB), false);

    tokenCoordinator.releaseQuarantine(tokenA);
    assert.equal(tokenCoordinator.isQuarantined(tokenA), false);
});

test('TokenCoordinator: Subsystem registration and callback isolation', () => {
    tokenCoordinator.reset();
    const token = 'token-subsystem-test';
    let subACalled = false;
    let subBCalled = false;

    tokenCoordinator.registerSubsystem({
        name: 'subA',
        onTokenQuarantined: () => {
            subACalled = true;
            throw new Error('Exploding subsystem A');
        }
    });

    tokenCoordinator.registerSubsystem({
        name: 'subB',
        onTokenQuarantined: () => {
            subBCalled = true;
        }
    });

    // Subsystem A throwing must not prevent Subsystem B from being notified
    tokenCoordinator.quarantineToken(token, 'Auth failure');
    assert.equal(subACalled, true);
    assert.equal(subBCalled, true);

    assert.equal(tokenCoordinator.unregisterSubsystem('subA'), true);
    assert.equal(tokenCoordinator.unregisterSubsystem('subB'), true);
    assert.equal(tokenCoordinator.unregisterSubsystem('nonExistent'), false);
});

test('TokenCoordinator: Quest heartbeat resolution across all branches', () => {
    tokenCoordinator.reset();
    const token = 'token-quest-heartbeat';

    // 1. Application ID priority
    const resApp = tokenCoordinator.getSafeQuestHeartbeatPayload(token, { id: 'q1', applicationId: 'app-100' });
    assert.deepEqual(resApp, { application_id: 'app-100', terminal: false });

    // 2. Specific guild match when in voice
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-abc',
        channelId: 'chan-abc',
        sessionId: 'sess-abc'
    });
    const resGuild = tokenCoordinator.getSafeQuestHeartbeatPayload(token, { id: 'q2', guildId: 'guild-abc' });
    assert.deepEqual(resGuild, { stream_key: 'guild:guild-abc:chan-abc', terminal: false });

    // 3. Fallback when not matching guild
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'sess-abc' });
    const resFallback = tokenCoordinator.getSafeQuestHeartbeatPayload(token, { id: 'q3' });
    assert.deepEqual(resFallback, { stream_key: 'call:q3:1', terminal: false });
});

test('TokenCoordinator: Reset clears state, maps, timers, and reattaches telemetry once', () => {
    tokenCoordinator.reset();
    const token = 'token-reset-test';

    tokenCoordinator.acquireActivity(token, 'someTask');
    tokenCoordinator.quarantineToken(token, 'Test');
    tokenCoordinator.cacheTokenProfile('other-token', { username: 'testuser' });

    assert.equal(tokenCoordinator.tokenStates.size > 0, true);
    assert.equal(tokenCoordinator.profileCache.size > 0, true);

    tokenCoordinator.reset();

    assert.equal(tokenCoordinator.tokenStates.size, 0);
    assert.equal(tokenCoordinator.tokenLocks.size, 0);
    assert.equal(tokenCoordinator.subsystems.size, 0);
    assert.equal(tokenCoordinator.profileCache.size, 0);
    assert.equal(tokenCoordinator.alertHistory.size, 0);
    assert.equal(tokenCoordinator.listenerCount('token:rate_limited'), 1, 'Telemetry listener attached exactly once');
    assert.equal(tokenCoordinator.listenerCount('token:quarantined'), 1, 'Telemetry listener attached exactly once');
    assert.equal(tokenCoordinator.listenerCount('token:released'), 1, 'Telemetry listener attached exactly once');
    assert.equal(tokenCoordinator.listenerCount('token:error'), 1, 'Telemetry listener attached exactly once');
});

test('OAuthTokenManager Contract: Public exports, aliases, and _test integrity', () => {
    assert.equal(typeof oauthTokenManager.getAccessToken, 'function');
    assert.equal(typeof oauthTokenManager.refreshDueTokens, 'function');
    assert.equal(typeof oauthTokenManager.listAccessTokenCandidates, 'function');
    assert.equal(typeof oauthTokenManager.getOwnerTokenState, 'function');
    assert.equal(typeof oauthTokenManager.getOwnerTokenMetadata, 'function');
    assert.equal(typeof oauthTokenManager.getRecoveryStatuses, 'function');
    assert.equal(typeof oauthTokenManager.recoveryReasonLabel, 'function');
    assert.equal(typeof oauthTokenManager.migrateStoredTokenEncryption, 'function');
    assert.equal(typeof oauthTokenManager.revokeToken, 'function');
    assert.equal(typeof oauthTokenManager.start, 'function');
    assert.equal(typeof oauthTokenManager.stop, 'function');
    assert.equal(typeof oauthTokenManager.getDiagnostics, 'function');
    assert.equal(typeof oauthTokenManager.withTokenRefreshLock, 'function');
    assert.equal(oauthTokenManager.withOAuthTokenStateLock, oauthTokenManager.withTokenRefreshLock, 'Alias must match exactly');

    // Constants
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_MARGIN_MS, 24 * 60 * 60 * 1000);
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_SCAN_LIMIT, 100);
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_FAIL_MAX, 5);
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_INTERVAL_MS, 10 * 60 * 1000);
    assert.equal(oauthTokenManager.DEFAULT_ON_DEMAND_MARGIN_MS, 5 * 60 * 1000);
    assert.deepEqual(oauthTokenManager.TOKEN_FIELDS, ['oauth']);

    // _test API integrity
    const expectedTestFunctions = [
        'dispatchOAuthAlert', 'resolveFailMax', 'isInvalidGrantError', 'assertValidTokenField',
        'validateTokenData', 'tokenPath', 'versionCondition', 'conflictOutcome',
        'readFreshOAuthDocument', 'markRefreshFailure', 'performTokenRefreshUnderLock',
        'buildRefreshQuery', 'refreshStateIsDue', 'applyRefreshOutcome', 'refreshTokenField',
        'revealTokenStateForOwner', 'tokenMetadataState', 'checkTokenCryptoReasons',
        'collectMissingScopeReasons', 'resetInternalStateForTesting', 'encryptToken',
        'decryptToken', 'decryptTokenForMigration'
    ];
    for (const fn of expectedTestFunctions) {
        assert.equal(typeof oauthTokenManager._test[fn], 'function', `_test.${fn} must be a function`);
    }
    assert.equal(oauthTokenManager._test.refreshLocks instanceof Map, true);
});

test('TokenCoordinator: Releasing quarantine preserves active multi-session voice state', () => {
    tokenCoordinator.reset();
    const token = 'token-multi-voice-quarantine';

    // Register 2 voice sessions
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-q1',
        channelId: 'chan-q1',
        sessionId: 'session-q1'
    });
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-q2',
        channelId: 'chan-q2',
        sessionId: 'session-q2'
    });

    // Quarantine the token
    tokenCoordinator.quarantineToken(token, '401 Unauthorized');
    assert.equal(tokenCoordinator.isQuarantined(token), true);

    // Release quarantine: state MUST NOT be deleted while voiceSessions has active sessions
    const released = tokenCoordinator.releaseQuarantine(token);
    assert.equal(released, true);
    assert.equal(tokenCoordinator.isQuarantined(token), false);

    const hash = tokenCoordinator.hashToken(token);
    const state = tokenCoordinator.tokenStates.get(hash);
    assert.ok(state, 'Token state must be preserved after quarantine release because voice sessions exist');
    assert.equal(state.voiceSessions.size, 2, 'Both voice sessions must remain intact');
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-q1'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-q2'), true);
});

test('TokenCoordinator: 429 waitMs parsing clamps malformed headers, negatives, and large values safely', () => {
    const parse = tokenCoordinator._parse429WaitMs;

    // Standard valid header
    const validWait = parse({ headers: { 'retry-after': '3' } });
    assert.equal(validWait >= 3000 && validWait <= 4000, true);

    // Negative header clamped to fallback
    const negativeWait = parse({ headers: { 'retry-after': '-10' } });
    assert.equal(negativeWait >= 300 && negativeWait <= 3000, true);

    // NaN / garbage header
    const garbageWait = parse({ headers: { 'retry-after': 'not-a-number' } });
    assert.equal(garbageWait >= 300 && garbageWait <= 3000, true);

    // Excessively large header clamped to 60s
    const largeWait = parse({ headers: { 'retry-after': '99999' } });
    assert.equal(largeWait, 60000);
});

test('OAuthTokenManager: checkTokenCryptoReasons catches corrupt ciphertext exceptions and records failure', () => {
    const check = oauthTokenManager._test.checkTokenCryptoReasons;

    // Token with corrupt base64/hex ciphertext that would throw in decryptToken
    const corruptToken = {
        encryptedAccessToken: 'v3:corrupt:invalid:payload:!!!',
        encryptedRefreshToken: 'v3:corrupt:invalid:refresh:!!!'
    };

    // Must not throw uncaught error; must catch and push decrypt_failed reasons
    assert.doesNotThrow(() => {
        const reasons = check(corruptToken, Date.now());
        assert.ok(reasons.includes('access_token_decrypt_failed'));
        assert.ok(reasons.includes('refresh_token_decrypt_failed'));
    });
});

test('OAuthTokenManager: Candidate query listAccessTokenCandidates respects seenUsers as read-only exclusion check and does not mutate it', async () => {
    const { listAccessTokenCandidates } = require('../tokens/oauth/candidateQuery');

    const seenUsers = new Set();
    const mockDocs = [
        {
            _id: '507f1f77bcf86cd799439011',
            discord: { userId: 'user-cand-1' },
            oauth: {
                encryptedAccessToken: 'dummy',
                scope: 'identify email connections guilds guilds.members.read guilds.join',
                revokedAt: null
            }
        },
        {
            _id: '507f1f77bcf86cd799439012',
            discord: { userId: 'user-cand-2' },
            oauth: {
                encryptedAccessToken: 'dummy',
                scope: 'identify email connections guilds guilds.members.read guilds.join',
                revokedAt: null
            }
        }
    ];

    const mockModel = {
        find: () => ({
            select: () => ({
                sort: () => ({
                    limit: () => ({
                        lean: async () => mockDocs
                    })
                })
            })
        })
    };

    const result = await listAccessTokenCandidates({
        model: mockModel,
        allowAllGuilds: true,
        seenUsers,
        limit: 10
    });

    assert.equal(result.candidates.length, 2);
    assert.equal(seenUsers.has('user-cand-1'), false, 'seenUsers Set must NOT be mutated by listAccessTokenCandidates (owned by consumer)');
    assert.equal(seenUsers.has('user-cand-2'), false, 'seenUsers Set must NOT be mutated by listAccessTokenCandidates (owned by consumer)');

    // Exclusion test: callers pass seenUsers to filter out already-enqueued users
    const exclusionSet = new Set(['user-cand-1']);
    const resultFiltered = await listAccessTokenCandidates({
        model: mockModel,
        allowAllGuilds: true,
        seenUsers: exclusionSet,
        limit: 10
    });
    assert.equal(resultFiltered.candidates.length, 1);
    assert.equal(resultFiltered.candidates[0].userId, 'user-cand-2');
});

test('OAuthTokenManager: Token payload validation accepts valid data and rejects invalid inputs with proper error codes', () => {
    const validate = oauthTokenManager.validateTokenData;

    assert.throws(() => validate(null), { code: 'oauth_token_invalid_payload' });
    assert.throws(() => validate('string'), { code: 'oauth_token_invalid_payload' });
    assert.throws(() => validate({}), { code: 'oauth_token_missing_access_token' });
    assert.throws(() => validate({ access_token: 'acc' }), { code: 'oauth_token_missing_refresh_token' });
    assert.throws(() => validate({ access_token: 'acc', refresh_token: 'ref', expires_in: 0 }), { code: 'oauth_token_invalid_expires_in' });
    assert.throws(() => validate({ access_token: 'acc', refresh_token: 'ref', expires_in: -5 }), { code: 'oauth_token_invalid_expires_in' });
    assert.throws(() => validate({ access_token: 'acc', refresh_token: 'ref', expires_in: 'not-num' }), { code: 'oauth_token_invalid_expires_in' });
    assert.throws(() => validate({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, scope: 12345 }), { code: 'oauth_token_invalid_scope' });
    assert.throws(() => validate({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, token_type: 12345 }), { code: 'oauth_token_invalid_token_type' });

    assert.equal(validate({
        access_token: 'valid_access_token',
        refresh_token: 'valid_refresh_token',
        expires_in: 3600,
        scope: 'identify guilds'
    }), true);
});

test('TokenCoordinator: reset() rejects queued rate-limit tickets with COORDINATOR_RESET and clears abort listeners', async () => {
    tokenCoordinator.reset();
    const token = 'token-reset-queue-test';
    const hash = tokenCoordinator.hashToken(token);
    const state = tokenCoordinator._getOrCreateState(hash);
    state.rateLimiter.tokens = 0; // Deplete tokens to force queueing

    const controller = new AbortController();
    const waitPromise = tokenCoordinator._acquireRateLimitSlot(hash, {
        maxWaitMs: 10000,
        signal: controller.signal
    });

    assert.equal(state.rateLimiter.queue.length, 1);

    // Call reset
    tokenCoordinator.reset();

    await assert.rejects(waitPromise, (err) => {
        assert.equal(err.code, 'COORDINATOR_RESET');
        return true;
    });
});

test('TokenCoordinator: _handleVoiceRelease with guildId resolves to matching voice session when sessionId omitted', () => {
    tokenCoordinator.reset();
    const token = 'token-voice-guild-release';

    // Register 2 sessions in different guilds
    tokenCoordinator.registerVoiceActivity(token, { guildId: 'guild-aaa', channelId: 'chan-1' });
    tokenCoordinator.registerVoiceActivity(token, { guildId: 'guild-bbb', channelId: 'chan-2' });

    assert.equal(tokenCoordinator.isVoiceActive(token, 'guild-aaa'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'guild-bbb'), true);

    // Unregister by guildId only
    const unreg = tokenCoordinator.unregisterVoiceActivity(token, { guildId: 'guild-aaa' });
    assert.equal(unreg, true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'guild-aaa'), false);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'guild-bbb'), true);
});

test('TokenCoordinator: _extractBodyRetryAfter accurately respects ms vs sec units across Discord error shapes', () => {
    const parse = tokenCoordinator._parse429WaitMs;

    // err.retryAfter is milliseconds (e.g. 500ms) -> waitMs should be ~600ms
    const msErr = { retryAfter: 500 };
    const msWait = parse(msErr);
    assert.equal(msWait, 600); // 500ms + 100ms

    // err.retry_after is seconds (e.g. 2.5s) -> waitMs should be ~2600ms
    const secErr = { retry_after: 2.5 };
    const secWait = parse(secErr);
    assert.equal(secWait, 2600); // ceil(2.5 * 1000) + 100

    // err.rawError.retry_after is seconds (e.g. 3.0s) -> waitMs should be ~3100ms
    const rawErr = { rawError: { retry_after: 3.0 } };
    const rawWait = parse(rawErr);
    assert.equal(rawWait, 3100);
});

test('OAuthTokenManager: markRefreshFailure defers revokedCount and alert until CAS write succeeds', async () => {
    const markFailure = oauthTokenManager._test.markRefreshFailure;
    const { diagnosticStats } = require('../tokens/oauth/state');

    const initialRevoked = diagnosticStats.revokedCount;

    // Simulate CAS conflict: modifiedCount = 0
    const mockModelConflict = {
        updateOne: async () => ({ modifiedCount: 0 })
    };

    const doc = {
        _id: '507f1f77bcf86cd799439011',
        discord: { userId: 'user-conflict' },
        oauth: {
            encryptedRefreshToken: 'dummy-refresh',
            version: 1,
            refreshFailCount: 10 // >= effectiveFailMax, shouldRevoke would be true
        }
    };

    const outcome = await markFailure(doc, new Error('invalid_grant'), {
        model: mockModelConflict,
        tokenField: 'oauth',
        failMax: 5
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.skipped, true);
    assert.equal(outcome.reason, 'failure_state_changed');
    assert.equal(diagnosticStats.revokedCount, initialRevoked, 'revokedCount must NOT increment when CAS update fails');
});

test('TokenCoordinator: shouldRetainTokenState retains state when backoff, pump timer, or depleted tokens exist', () => {
    const { shouldRetainTokenState } = require('../tokens/coordinator/tokenState');
    tokenCoordinator.reset();
    const token = 'token-retain-test';
    const hash = tokenCoordinator.hashToken(token);
    const state = tokenCoordinator._getOrCreateState(hash);

    // Initial fresh state has no activity, voice, quest, quarantine, backoff, or depleted tokens
    assert.equal(shouldRetainTokenState(tokenCoordinator, state), false);

    // Backoff active -> should retain
    state.backoffUntil = Date.now() + 5000;
    assert.equal(shouldRetainTokenState(tokenCoordinator, state), true);
    state.backoffUntil = 0;

    // Recently depleted tokens -> should retain
    state.rateLimiter.tokens = 2; // < capacity 4
    state.rateLimiter.lastRefill = Date.now();
    assert.equal(shouldRetainTokenState(tokenCoordinator, state), true, 'Recently depleted token must be retained');

    // Stale/idle depleted tokens where refill has elapsed -> should NOT retain (prevents memory leak)
    state.rateLimiter.lastRefill = Date.now() - 5000; // 5 seconds ago at 2/s refills 10 tokens > capacity 4
    assert.equal(shouldRetainTokenState(tokenCoordinator, state), false, 'Idle token whose projected refill reached capacity must not be retained');
    state.rateLimiter.tokens = 4;
    state.rateLimiter.lastRefill = Date.now();

    // Queued tickets -> should retain
    state.rateLimiter.queue = [{ cancelled: false }];
    assert.equal(shouldRetainTokenState(tokenCoordinator, state), true);
    state.rateLimiter.queue = [];

    // Pump timer -> should retain
    state.rateLimiter.pumpTimer = setTimeout(() => {}, 1000);
    assert.equal(shouldRetainTokenState(tokenCoordinator, state), true);
    clearTimeout(state.rateLimiter.pumpTimer);
    state.rateLimiter.pumpTimer = null;

    assert.equal(shouldRetainTokenState(tokenCoordinator, state), false);
});
