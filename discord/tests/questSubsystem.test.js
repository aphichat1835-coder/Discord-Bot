'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    encryptToken,
    decryptToken,
    maskToken
} = require('../quest/core/tokenCrypto');
const {
    buildSuperProperties,
    buildUserHeaders,
    getUserAgent
} = require('../quest/core/clientProfile');
const {
    isVideoEvent,
    isGameEvent,
    isSupportedEvent,
    selectQuestClaimPlatform,
    isRunnableQuest
} = require('../quest/core/questSession');
const {
    getUserJobs,
    stopAllForUser,
    stopJob,
    startRunner
} = require('../quest/core/runnerManager');
const {
    formatRunnerStatusContent,
    clampCodeBlockContent
} = require('../quest/core/runnerStatusHeader');
const {
    createOneShotQuestSession,
    getNextPendingOneShotQuest,
    markOneShotQuestRunning,
    markOneShotProgressMutationSent,
    recordOneShotVerifiedProgress,
    completeOneShotQuest,
    failOneShotQuest,
    getOneShotSessionSummary,
    isOneShotSessionComplete,
    ONE_SHOT_QUEST_STATUS,
    EXTERNAL_COMPLETION_REASON
} = require('../quest/core/oneShotSession');
const {
    SCHEDULE_HOURS,
    nextScheduledCheck,
    nextRecheckState,
    addScheduleJitter,
    formatScheduleTime,
    RECHECK_INTERVAL_MS
} = require('../quest/core/runnerSchedule');
const {
    withOwnerAdmissionLock,
    withAccountAdmissionLock
} = require('../quest/core/admissionLock');
const {
    handleQuestCommand,
    handleQuestButton,
    handleQuestSelect
} = require('../commands/quest');
const {
    questSummaryTone,
    buildQuestSummaryEmbed,
    buildQuestAuthFailureEmbed,
    sendQuestSummaryDM,
    sendQuestAuthFailureDM
} = require('../quest/core/questDm');

test('tokenCrypto correctly encrypts, decrypts, and masks tokens', () => {
    const rawToken = 'mock_quest_token_for_encryption_test_string_1234567890abcdef';
    const encrypted = encryptToken(rawToken, 'user_123', 'acc_456');

    assert.ok(encrypted.ciphertext);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.tag);
    assert.ok(encrypted.salt);
    assert.ok(encrypted.packed.includes(':'));

    const decrypted = decryptToken(encrypted.packed, 'user_123', 'acc_456');
    assert.equal(decrypted, rawToken);

    const masked = maskToken(rawToken);
    assert.ok(masked.startsWith('mock_q'));
    assert.ok(masked.endsWith('cdef'));
    assert.ok(masked.includes('...'));
});

test('clientProfile generates valid Discord desktop client headers and super properties', () => {
    const ua = getUserAgent();
    assert.match(ua, /Mozilla\/5\.0/);
    assert.match(ua, /discord\//);

    const superPropsBase64 = buildSuperProperties();
    assert.ok(superPropsBase64);
    const parsed = JSON.parse(Buffer.from(superPropsBase64, 'base64').toString('utf8'));
    assert.equal(parsed.os, 'Windows');
    assert.equal(parsed.browser, 'Discord Client');
    assert.ok(parsed.client_build_number > 0);

    const headers = buildUserHeaders('test_token', '/quests/123');
    assert.equal(headers.Authorization, 'test_token');
    assert.equal(headers['X-Super-Properties'], superPropsBase64);
    assert.equal(headers.Referer, 'https://discord.com/quest-home');
});

test('questSession correctly classifies quest event types and reward platforms', () => {
    assert.equal(isVideoEvent('WATCH_VIDEO'), true);
    assert.equal(isVideoEvent('WATCH_VIDEO_ON_MOBILE'), true);
    assert.equal(isVideoEvent('PLAY_ON_DESKTOP'), false);

    assert.equal(isGameEvent('PLAY_ON_DESKTOP'), true);
    assert.equal(isGameEvent('PLAY_ON_DESKTOP_V2'), true);
    assert.equal(isGameEvent('STREAM_ON_DESKTOP'), false);

    assert.equal(isSupportedEvent('WATCH_VIDEO'), true);
    assert.equal(isSupportedEvent('PLAY_ON_DESKTOP'), true);
    assert.equal(isSupportedEvent('ACHIEVEMENT_IN_GAME'), false);

    const platformWithDiscord = selectQuestClaimPlatform({ rewardPlatforms: [0, 4] });
    assert.equal(platformWithDiscord, 4);

    const platformSingle = selectQuestClaimPlatform({ rewardPlatforms: [2] });
    assert.equal(platformSingle, 2);

    const runnable = isRunnableQuest({
        eventName: 'WATCH_VIDEO',
        autoSupported: true,
        enrolled: true,
        startsAt: new Date(Date.now() - 10000).toISOString(),
        expiresAt: new Date(Date.now() + 10000).toISOString()
    });
    assert.equal(runnable, true);
});

test('runnerStatusHeader correctly formats status lines and clamps codeblocks', () => {
    const rawContent = '```\n✅ LOGIN : TestUser\n🔎 TestUser: พบ 2 QUESTS\n🎉 TestUser: ทำสำเร็จ 1 QUESTS\n▶️ TestUser: ทำเควสต์เกม\n```';
    const formatted = formatRunnerStatusContent(rawContent);
    assert.ok(formatted.includes('✅ LOGIN : TestUser'));
    assert.ok(formatted.includes('บอทตรวจพบ Quest ที่ทำได้ทั้งหมด : 2'));
    assert.ok(formatted.includes('บอททำ Quest ให้อัตโนมัติไปแล้วทั้งหมด : 1'));
    assert.ok(formatted.includes('────────────────────────'));
    assert.ok(formatted.includes('▶️ TestUser: ทำเควสต์เกม'));

    // Test clamp
    const large = '```\n' + 'A'.repeat(3000) + '\n```';
    const clamped = clampCodeBlockContent(large);
    assert.ok(clamped.length <= 1950);
});

test('oneShotSession manages lifecycle, external completions, and final summary', () => {
    const session = createOneShotQuestSession([
        { id: 'q1', name: 'Quest 1', eventName: 'WATCH_VIDEO', progressSecs: 0 },
        { id: 'q2', name: 'Quest 2', eventName: 'PLAY_ON_DESKTOP', progressSecs: 10 }
    ]);

    assert.equal(session.totalSupportedQuests, 2);
    const q1 = getNextPendingOneShotQuest(session);
    assert.equal(q1.id, 'q1');

    // Start q1 and complete by bot
    markOneShotQuestRunning(session, 'q1', 0);
    markOneShotProgressMutationSent(session, 'q1');
    recordOneShotVerifiedProgress(session, 'q1', 15, { completed: true });
    const status1 = completeOneShotQuest(session, 'q1');
    assert.equal(status1, ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);

    // Complete q2 externally (without bot progress)
    const status2 = completeOneShotQuest(session, 'q2');
    assert.equal(status2, ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL);
    assert.equal(session.quests.get('q2').reason, EXTERNAL_COMPLETION_REASON);

    assert.equal(isOneShotSessionComplete(session), true);
    const summary = getOneShotSessionSummary(session);
    assert.equal(summary.completedByBotCount, 1);
    assert.equal(summary.completedExternalCount, 1);
    assert.equal(summary.failedCount, 0);
});

test('runnerSchedule calculates Bangkok scheduled checks and jitter', () => {
    assert.deepEqual(SCHEDULE_HOURS, [0, 8, 16]);

    const now = new Date('2026-09-06T03:00:00Z'); // 10:00 in Bangkok (UTC+7)
    const nextCheck = nextScheduledCheck(now, 'Asia/Bangkok');
    assert.ok(nextCheck.getTime() > now.getTime());

    // Jitter adds bounded ms
    const jittered = addScheduleJitter(now, () => 0.5, 60000);
    assert.equal(jittered.getTime(), now.getTime() + 30000);

    // Recheck state logic
    const initialRecheck = nextRecheckState({ attempted: true, progressed: true });
    assert.equal(initialRecheck.shouldRecheck, true);
    assert.equal(initialRecheck.rechecksRemaining, 3);
    assert.equal(initialRecheck.delayMs, RECHECK_INTERVAL_MS);

    const nextRecheck = nextRecheckState({ isRecheck: true, rechecksRemaining: 3 });
    assert.equal(nextRecheck.rechecksRemaining, 2);

    const formattedTime = formatScheduleTime(now, 'Asia/Bangkok');
    assert.ok(typeof formattedTime === 'string');
});

test('admissionLock serializes operations for owner and account', async () => {
    const sequence = [];
    const p1 = withAccountAdmissionLock('acc_1', async () => {
        sequence.push('start_1');
        await new Promise((r) => setTimeout(r, 10));
        sequence.push('end_1');
    });

    const p2 = withAccountAdmissionLock('acc_1', async () => {
        sequence.push('start_2');
        sequence.push('end_2');
    });

    await Promise.all([p1, p2]);
    assert.deepEqual(sequence, ['start_1', 'end_1', 'start_2', 'end_2']);
});

test('runnerManager tracks jobs and stops jobs for a user', () => {
    const initialJobs = getUserJobs('non_existent_user');
    assert.equal(initialJobs.length, 0);

    const stopped = stopAllForUser('non_existent_user');
    assert.equal(stopped, 0);
});

test('handleQuestCommand enforces bot owner check for panel', async () => {
    let replyPayload = null;
    const nonOwnerInteraction = {
        user: { id: '999999999999999999' },
        options: { getSubcommand: () => 'panel' },
        reply: (payload) => { replyPayload = payload; return Promise.resolve(payload); },
        isRepliable: () => true,
        deferred: false,
        replied: false
    };

    await handleQuestCommand(nonOwnerInteraction);
    assert.ok(replyPayload);
    assert.match(replyPayload.content, /เฉพาะ \*\*เจ้าของบอท/);

    const ownerId = process.env.OWNER_ID || require('../config.json').system?.ownerId || '661415152146710558';
    let ownerReply = null;
    const ownerInteraction = {
        user: { id: ownerId },
        options: { getSubcommand: () => 'panel' },
        reply: (payload) => { ownerReply = payload; return Promise.resolve(payload); },
        isRepliable: () => true,
        deferred: false,
        replied: false
    };

    await handleQuestCommand(ownerInteraction);
    assert.ok(ownerReply);
    assert.ok(ownerReply.embeds && ownerReply.embeds.length > 0);
    assert.ok(ownerReply.components && ownerReply.components.length > 0);
    assert.ok(ownerReply.files && ownerReply.files.length > 0);
    assert.equal(ownerReply.embeds[0].data.image.url, 'attachment://quest-banner.gif');
});

test('handleQuestButton allows users to open modal and view stop controls', async () => {
    let modalShown = null;
    const runInteraction = {
        customId: 'quest_panel:run_oneshot',
        showModal: (modal) => { modalShown = modal; return Promise.resolve(); }
    };
    await handleQuestButton(runInteraction);
    assert.ok(modalShown);
    assert.ok(modalShown.data.custom_id.startsWith('quest_run_modal'));

    let stopReply = null;
    const stopInteraction = {
        customId: 'quest_panel:stop',
        user: { id: 'some_user_123' },
        reply: (payload) => { stopReply = payload; return Promise.resolve(payload); }
    };
    await handleQuestButton(stopInteraction);
    assert.ok(stopReply);
    assert.ok(stopReply.embeds && stopReply.embeds.length > 0);
});

test('runnerManager routes status updates to DM and falls back to channel when DM fails', async () => {
    const dmDeliveries = [];
    const mockDm = {
        id: 'dm_12345',
        isTextBased: () => true,
        send: async (payload) => {
            dmDeliveries.push(payload);
            return { edit: async () => {} };
        }
    };
    const mockUser = {
        createDM: async () => mockDm
    };
    const mockClient = {
        users: {
            fetch: async (id) => (id === 'user_dm_target' ? mockUser : null)
        },
        channels: {
            fetch: async () => null
        }
    };

    const runner = await startRunner({
        jobKey: 'test:dm:routing:1',
        ownerId: 'user_dm_target',
        userToken: 'invalid_dummy_token_for_test',
        channelId: 'channel_guild_fallback',
        client: mockClient,
        mode: 'oneshot',
        username: 'TestUserDM'
    });

    // Wait a brief tick for the flush to run
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.controller.abort();
    await runner.task.catch(() => {});

    assert.ok(dmDeliveries.length > 0, 'Status message should be delivered to DM');
    assert.match(dmDeliveries[0].content, /✅ LOGIN : TestUserDM/);

    // Test fallback when DM sending fails (e.g. DMs closed)
    const channelDeliveries = [];
    const mockClosedDm = {
        id: 'dm_closed',
        isTextBased: () => true,
        send: async () => {
            const err = new Error('Cannot send messages to this user');
            err.code = 50007;
            throw err;
        }
    };
    const mockClosedUser = {
        createDM: async () => mockClosedDm
    };
    const mockFallbackChannel = {
        id: 'channel_guild_fallback_2',
        isTextBased: () => true,
        send: async (payload) => {
            channelDeliveries.push(payload);
            return { edit: async () => {} };
        }
    };
    const mockFallbackClient = {
        users: {
            fetch: async (id) => (id === 'user_dm_closed' ? mockClosedUser : null)
        },
        channels: {
            fetch: async (id) => (id === 'channel_guild_fallback_2' ? mockFallbackChannel : null)
        }
    };

    const fallbackRunner = await startRunner({
        jobKey: 'test:dm:routing:2',
        ownerId: 'user_dm_closed',
        userToken: 'invalid_dummy_token_for_test_2',
        channelId: 'channel_guild_fallback_2',
        client: mockFallbackClient,
        mode: 'oneshot',
        username: 'TestUserClosed'
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    fallbackRunner.controller.abort();
    await fallbackRunner.task.catch(() => {});

    assert.ok(channelDeliveries.length > 0, 'Status message should fall back to guild channel when DM fails');
    assert.match(channelDeliveries[0].content, /✅ LOGIN : TestUserClosed/);
});

test('questDm builds correct tones and embeds for success, partial, danger, and auth failure', () => {
    assert.equal(questSummaryTone({ totalQuests: 2, completedQuests: 2, issues: [] }), 'success');
    assert.equal(questSummaryTone({ totalQuests: 2, completedQuests: 1, issues: [{ name: 'Q2', reason: 'fail' }] }), 'warning');
    assert.equal(questSummaryTone({ totalQuests: 2, completedQuests: 0, issues: [{ name: 'Q1', reason: 'fail' }] }), 'danger');
    assert.equal(questSummaryTone({ totalQuests: 0, completedQuests: 0, issues: [] }), 'info');

    const successEmbed = buildQuestSummaryEmbed({
        mode: 'oneshot',
        username: 'TestHero',
        accountId: '123456789',
        totalQuests: 3,
        completedQuests: 3,
        issues: [],
        jobKey: 'job:123'
    });
    assert.ok(successEmbed);
    assert.match(successEmbed.data.title, /ทำ Quest อัตโนมัติเสร็จสิ้นแล้ว/);
    assert.equal(successEmbed.data.color, parseInt('57F287', 16));

    const authFailEmbed = buildQuestAuthFailureEmbed({
        username: 'TestHero',
        accountId: '123456789',
        jobKey: 'job:123'
    });
    assert.ok(authFailEmbed);
    assert.match(authFailEmbed.data.title, /Token บัญชี Quest ใช้งานไม่ได้/);
    assert.equal(authFailEmbed.data.color, parseInt('ED4245', 16));
});

test('questDm sendQuestSummaryDM and sendQuestAuthFailureDM integrate with central dmService outbox', async () => {
    const summaryResult = await sendQuestSummaryDM({
        ownerId: 'owner_999',
        accountId: 'acc_888',
        username: 'PlayerOne',
        mode: 'oneshot',
        totalQuests: 2,
        completedQuests: 2,
        issues: [],
        jobKey: 'test:job:key'
    });

    assert.ok(summaryResult);
    // Even without active MongoDB, outbox saves into volatileOutbox or sends
    assert.ok(['sent', 'retrying', 'skipped'].includes(summaryResult.status));

    const authResult = await sendQuestAuthFailureDM({
        ownerId: 'owner_999',
        accountId: 'acc_888',
        username: 'PlayerOne',
        jobKey: 'test:job:key'
    });

    assert.ok(authResult);
    assert.ok(['sent', 'retrying', 'skipped'].includes(authResult.status));
});


