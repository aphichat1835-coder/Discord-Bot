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
    getActiveUserJobs,
    stopAllUserQuestSessions
} = require('../quest/core/runnerManager');
const {
    handleQuestCommand,
    handleQuestButton
} = require('../commands/quest');

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

test('runnerManager tracks jobs and stops jobs for a user', () => {
    const initialJobs = getActiveUserJobs('non_existent_user');
    assert.equal(initialJobs.length, 0);

    const stopped = stopAllUserQuestSessions('non_existent_user');
    assert.equal(stopped, 0);
});

test('handleQuestCommand enforces bot owner check', async () => {
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
});

test('handleQuestButton allows all users to click run or stop', async () => {
    let modalShown = null;
    const runInteraction = {
        customId: 'quest_panel:run',
        showModal: (modal) => { modalShown = modal; return Promise.resolve(); }
    };
    await handleQuestButton(runInteraction);
    assert.ok(modalShown);
    assert.equal(modalShown.data.custom_id, 'quest_run_modal');

    let stopReply = null;
    let deferred = false;
    const stopInteraction = {
        customId: 'quest_panel:stop',
        user: { id: 'some_random_user_123' },
        deferReply: () => { deferred = true; return Promise.resolve(); },
        editReply: (text) => { stopReply = text; return Promise.resolve(); }
    };
    await handleQuestButton(stopInteraction);
    assert.ok(deferred);
    assert.match(stopReply, /ไม่มีเควสต์ที่กำลังทำงาน/);
});
