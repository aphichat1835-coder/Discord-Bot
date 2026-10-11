'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config.json');

const {
    maskToken,
    getAccountCreatedAt,
    formatDateBangkok,
    getAccountAgeString,
    resolveNitroPlan,
    resolveAvatarUrl,
    resolveInvalidTokenErrorMessage,
    buildSingleTokenEmbed,
    buildBatchSummaryEmbed,
    THEME_COLORS
} = require('../features/tokenChecker');

const {
    MAX_BATCH_TOKENS,
    buildTokenCheckPanelEmbed,
    buildTokenCheckPanelRow,
    handleTokenCheckCommand,
    handleTokenCheckButton,
    handleTokenCheckModal
} = require('../commands/tokenCheck');

const {
    IDS,
    isTokenCheckButton,
    isTokenCheckModal
} = require('../commands/customIds');

test('tokenChecker helper functions work accurately', () => {
    // 1. maskToken
    assert.equal(maskToken(''), '******');
    assert.equal(maskToken(null), '******');
    assert.equal(maskToken('12345'), '12******45');
    assert.equal(maskToken('OTIxNDM2NTUyMTQ2NzEwNTU4.G_XXXX.YYYYZZZZ12345678'), 'OTIxND...5678');

    // 2. getAccountCreatedAt from Snowflake
    // Known Discord ID: 661415152146710558 -> 2019-11-30T03:47:04.532Z
    const createdDate = getAccountCreatedAt('661415152146710558');
    assert.ok(createdDate instanceof Date);
    assert.equal(createdDate.getUTCFullYear(), 2019);
    assert.equal(getAccountCreatedAt('invalid_id'), null);

    // 3. formatDateBangkok
    assert.equal(formatDateBangkok(null), '-');
    assert.match(formatDateBangkok(createdDate), /2019|2562/);

    // 4. getAccountAgeString
    assert.equal(getAccountAgeString(null), '-');
    assert.match(getAccountAgeString(createdDate), /ปีที่แล้ว/);

    // 5. resolveNitroPlan
    assert.equal(resolveNitroPlan(0), 'ไม่มี Nitro');
    assert.equal(resolveNitroPlan(1), 'Nitro Classic');
    assert.equal(resolveNitroPlan(2), 'Nitro (Server Boost)');
    assert.equal(resolveNitroPlan(3), 'Nitro Basic');
    assert.equal(resolveNitroPlan(99), 'ไม่มี Nitro');

    // 6. resolveAvatarUrl
    assert.match(resolveAvatarUrl(null), /embed\/avatars\/0\.png/);
    assert.match(resolveAvatarUrl({ id: '123' }), /embed\/avatars/);
    assert.equal(
        resolveAvatarUrl({ id: '123', avatar: 'abcdef123456' }),
        'https://cdn.discordapp.com/avatars/123/abcdef123456.png?size=256'
    );
    assert.equal(
        resolveAvatarUrl({ id: '123', avatar: 'a_animatedgif' }),
        'https://cdn.discordapp.com/avatars/123/a_animatedgif.gif?size=256'
    );
});

test('tokenChecker embed builders produce correct outputs', () => {
    // 1. Invalid token embed
    const invalidResult = {
        valid: false,
        maskedToken: 'OTIxND...5678',
        errorMessage: 'Token ไม่ถูกต้อง หรือหมดอายุแล้ว'
    };
    const invalidEmbed = buildSingleTokenEmbed(invalidResult);
    assert.equal(invalidEmbed.data.color, parseInt(THEME_COLORS.INVALID.replace('#', ''), 16));
    assert.match(invalidEmbed.data.title, /ใช้งานไม่ได้/);

    // 2. Valid token with Boost embed
    const boostResult = {
        valid: true,
        maskedToken: 'OTIxND...5678',
        id: '661415152146710558',
        username: 'Apichat',
        globalName: 'Apichat Dev',
        avatarUrl: 'https://cdn.discordapp.com/avatars/123/avatar.png',
        email: 'test@example.com',
        emailVerified: true,
        phone: '+66812345678',
        phoneVerified: true,
        mfaEnabled: true,
        hasNitro: true,
        hasBoost: true,
        nitroPlan: 'Nitro (Server Boost)',
        expireDays: 25,
        expireDate: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
        createdAt: new Date('2019-11-30T00:00:00Z'),
        category: 'boost'
    };
    const boostEmbed = buildSingleTokenEmbed(boostResult);
    assert.equal(boostEmbed.data.color, parseInt(THEME_COLORS.BOOST.replace('#', ''), 16));
    assert.match(boostEmbed.data.title, /ข้อมูลบัญชี Discord/);
    assert.equal(boostEmbed.data.thumbnail.url, boostResult.avatarUrl);

    // 3. Batch summary embed
    const batchData = {
        summary: {
            total: 3,
            valid: 2,
            boost: 1,
            nitro: 0,
            normal: 1,
            invalid: 1
        },
        results: [
            boostResult,
            {
                valid: true,
                hasBoost: false,
                hasNitro: false,
                username: 'NormalUser',
                id: '999888777'
            },
            invalidResult
        ]
    };
    const batchEmbed = buildBatchSummaryEmbed(batchData);
    assert.equal(batchEmbed.data.color, parseInt(THEME_COLORS.BOOST.replace('#', ''), 16));
    assert.match(batchEmbed.data.description, /สรุปผลการตรวจสอบทั้งหมด.*3.*Token/);
    assert.match(batchEmbed.data.description, /Apichat/);
    assert.match(batchEmbed.data.description, /NormalUser/);

    // 4. Bot token embed
    const botResult = {
        valid: true,
        isBot: true,
        maskedToken: 'MTUzMD...5678',
        id: '153012345678901234',
        username: 'BroadcastHelperBot',
        globalName: 'Broadcast Helper',
        avatarUrl: 'https://cdn.discordapp.com/avatars/153/bot.png',
        createdAt: new Date('2022-01-01T00:00:00Z'),
        category: 'bot'
    };
    const botEmbed = buildSingleTokenEmbed(botResult);
    assert.match(botEmbed.data.title, /ข้อมูลบัญชี Discord.*Bot/);
    assert.match(botEmbed.data.description, /Valid Bot Token/);
    assert.match(botEmbed.data.description, /Broadcast Helper/);
    assert.match(botEmbed.data.description, /\[BOT\]/);

    // 5. resolveInvalidTokenErrorMessage sanitizes technical errors
    assert.equal(resolveInvalidTokenErrorMessage({ errorType: 'INVALID' }), 'Token ไม่ถูกต้อง หรือหมดอายุแล้ว');
    assert.equal(resolveInvalidTokenErrorMessage({ errorType: 'LOCKED' }), 'บัญชีถูกระงับ หรือติดด่านยืนยันความปลอดภัย');
    assert.equal(resolveInvalidTokenErrorMessage({ errorType: 'QUARANTINED' }), 'Token ติดสถานะกักกัน ไม่สามารถใช้งานได้');
    assert.equal(resolveInvalidTokenErrorMessage({ errorType: 'NETWORK_ERROR' }), 'การเชื่อมต่อขัดข้องหรือหมดเวลา');
    assert.equal(resolveInvalidTokenErrorMessage({ errorType: 'HTTP_500' }), 'ตรวจสอบ Token ไม่สำเร็จ');
    assert.equal(resolveInvalidTokenErrorMessage({ errorType: 'HTTP_429' }), 'ตรวจสอบ Token ไม่สำเร็จ');

    // 6. Batch summary displays all 20 tokens without truncation
    const batch20Results = Array.from({ length: 20 }, (_, i) => ({
        valid: true,
        maskedToken: `to******_${i + 1}`,
        username: `User${i + 1}`,
        id: `10000000000000000${i + 1}`,
        hasNitro: false,
        hasBoost: false
    }));
    const batch20Embed = buildBatchSummaryEmbed({
        summary: { total: 20, boost: 0, nitro: 0, normal: 20, bot: 0, invalid: 0, valid: 20 },
        results: batch20Results
    });
    assert.match(batch20Embed.data.description, /1\. (?:<a:g03_pmt:\d+>|🟢) ปกติ \*\*User1\*\*/);
    assert.match(batch20Embed.data.description, /20\. (?:<a:g03_pmt:\d+>|🟢) ปกติ \*\*User20\*\*/);
    assert.equal(batch20Embed.data.description.includes('และอีก'), false);
    assert.equal(Boolean(batch20Embed.data.footer), false);
});

test('tokenCheck command and interactions behave correctly', async () => {
    // 1. customIds predicates
    assert.equal(isTokenCheckButton(IDS.BTN_TOKEN_CHECK), true);
    assert.equal(isTokenCheckButton('other_id'), false);
    assert.equal(isTokenCheckModal(IDS.MODAL_TOKEN_CHECK), true);
    assert.equal(isTokenCheckModal('other_modal'), false);

    // 2. buildTokenCheckPanelEmbed and Row
    const panelEmbed = buildTokenCheckPanelEmbed();
    assert.match(panelEmbed.data.title, /ตรวจสอบ Discord Token/);
    assert.match(panelEmbed.data.description, /ตรวจสอบสถานะบัญชี Nitro/);

    const panelEmbedWithAttachment = buildTokenCheckPanelEmbed({ hasAttachment: true });
    assert.equal(panelEmbedWithAttachment.data.image.url, 'attachment://token-check-banner.gif');

    const panelRow = buildTokenCheckPanelRow();
    assert.equal(panelRow.components.length, 1);
    assert.equal(panelRow.components[0].data.custom_id, IDS.BTN_TOKEN_CHECK);
    assert.equal(panelRow.components[0].data.label, 'ตรวจสอบ Token');

    // 3. handleTokenCheckCommand replies publicly with deferral and checks owner permission
    let repliedPayload = null;
    const mockInteraction = {
        user: { id: config.system?.ownerId || '661415152146710558' },
        deferReply: async (options) => {
            mockInteraction.deferred = true;
            mockInteraction.deferOptions = options;
        },
        editReply: async (payload) => {
            repliedPayload = payload;
            return payload;
        },
        reply: async (payload) => {
            repliedPayload = payload;
            return payload;
        },
        deferred: false,
        replied: false
    };
    await handleTokenCheckCommand(mockInteraction);
    assert.ok(repliedPayload);
    assert.equal(repliedPayload.flags, undefined); // Public panel
    assert.equal(repliedPayload.embeds.length, 1);
    assert.equal(repliedPayload.components.length, 1);
    assert.ok(Array.isArray(repliedPayload.files));
    assert.equal(repliedPayload.files.length, 1);
    assert.equal(repliedPayload.files[0].name, 'token-check-banner.gif');
    assert.equal(mockInteraction.deferred, true);

    // 3.1 Non-owner permission rejection
    let deniedPayload = null;
    const mockNonOwnerInteraction = {
        user: { id: '999999999999999999' },
        reply: async (p) => { deniedPayload = p; return p; },
        followUp: async (p) => { deniedPayload = p; return p; },
        deferred: false,
        replied: false
    };
    await handleTokenCheckCommand(mockNonOwnerInteraction);
    assert.ok(deniedPayload);
    assert.match(deniedPayload.content, /เจ้าของบอท/);
    assert.equal(deniedPayload.flags, 64);

    // 4. handleTokenCheckButton shows modal
    let shownModal = null;
    const mockButtonInteraction = {
        showModal: async (modal) => {
            shownModal = modal;
            return modal;
        }
    };
    await handleTokenCheckButton(mockButtonInteraction);
    assert.ok(shownModal);
    assert.equal(shownModal.data.custom_id, IDS.MODAL_TOKEN_CHECK);
    assert.equal(shownModal.components.length, 1);

    // 5. handleTokenCheckModal validation: empty tokens
    let safeReplyContent = null;
    const mockEmptyModalInteraction = {
        fields: {
            getTextInputValue: () => '   \n  \n  '
        },
        reply: async (p) => { safeReplyContent = p; return p; },
        followUp: async (p) => { safeReplyContent = p; return p; },
        deferred: false,
        replied: false
    };
    await handleTokenCheckModal(mockEmptyModalInteraction);
    assert.match(safeReplyContent.content, /ไม่พบข้อมูล Token/);

    // 6. handleTokenCheckModal validation: over max batch tokens
    let overflowReplyContent = null;
    const overflowTokens = Array.from({ length: MAX_BATCH_TOKENS + 5 }, (_, i) => `token_${i}`).join('\n');
    const mockOverflowModalInteraction = {
        fields: {
            getTextInputValue: () => overflowTokens
        },
        reply: async (p) => { overflowReplyContent = p; return p; },
        followUp: async (p) => { overflowReplyContent = p; return p; },
        deferred: false,
        replied: false
    };
    await handleTokenCheckModal(mockOverflowModalInteraction);
    // 7. handleTokenCheckModal error handling sanitizes raw exceptions
    let errorReplyContent = null;
    const mockErrorModalInteraction = {
        fields: {
            getTextInputValue: () => 'valid_looking_token_123'
        },
        deferReply: async () => {},
        editReply: async (p) => { errorReplyContent = p; return p; },
        deferred: true,
        replied: false
    };
    const originalCheckSingle = require('../features/tokenChecker').checkSingleToken;
    const tcModule = require('../features/tokenChecker');
    tcModule.checkSingleToken = async () => { throw new Error('DB connection pool failed at 127.0.0.1:27017'); };
    try {
        await handleTokenCheckModal(mockErrorModalInteraction);
        assert.match(errorReplyContent.content, /ตรวจสอบ Token ไม่สำเร็จ/);
        assert.ok(!errorReplyContent.content.includes('127.0.0.1'));
        assert.ok(!errorReplyContent.content.includes('DB connection pool failed'));
    } finally {
        tcModule.checkSingleToken = originalCheckSingle;
    }
});

test('checkSingleToken utilizes tokenCoordinator profile cache and quarantine', async () => {
    const { checkSingleToken } = require('../features/tokenChecker');
    const tokenCoordinator = require('../core/tokenCoordinator');

    const mockToken = 'mock_cached_token_abc123';
    const mockProfile = {
        valid: true,
        token: mockToken,
        maskedToken: 'mock_c...c123',
        id: '123456789012345678',
        username: 'CachedHero',
        category: 'nitro'
    };

    // Pre-populate cache in tokenCoordinator
    tokenCoordinator.cacheTokenProfile(mockToken, mockProfile, 60000);

    // Call checkSingleToken; should resolve immediately from cache without calling Discord API
    const cachedResult = await checkSingleToken(mockToken);
    assert.deepEqual(cachedResult, mockProfile);

    // Quarantine the token
    const deadToken = 'mock_dead_token_xyz999';
    tokenCoordinator.quarantineToken(deadToken, '401 Unauthorized Account Terminated');

    const quarantinedResult = await checkSingleToken(deadToken);
    assert.equal(quarantinedResult.valid, false);
    assert.equal(quarantinedResult.errorType, 'QUARANTINED');
    assert.match(quarantinedResult.errorMessage, /Quarantine/);

    tokenCoordinator.reset();
});

test('checkBatchTokens processes tokens in parallel batches and categorizes results accurately', async () => {
    const { checkBatchTokens } = require('../features/tokenChecker');
    const tokenCoordinator = require('../core/tokenCoordinator');

    // Pre-populate 7 tokens in profile cache to test chunking across batches of 5
    const mockTokens = [];
    for (let i = 1; i <= 7; i++) {
        const t = `mock_batch_token_${i}`;
        mockTokens.push(t);
        tokenCoordinator.cacheTokenProfile(t, {
            valid: true,
            token: t,
            maskedToken: 'mock...123',
            id: `id-${i}`,
            username: `User${i}`,
            category: (i % 2 === 0) ? 'boost' : 'normal'
        }, 60000);
    }

    const res = await checkBatchTokens(mockTokens, { batchSize: 5, delayMs: 10 });
    assert.equal(res.results.length, 7);
    assert.equal(res.summary.total, 7);
    assert.equal(res.summary.valid, 7);
    assert.equal(res.summary.boost, 3);
    assert.equal(res.summary.normal, 4);

    tokenCoordinator.reset();
});

test('checkSingleToken auto-detects Bot Token on 401 fallback and auto-unquarantines', async () => {
    const { checkSingleToken } = require('../features/tokenChecker');
    const tokenCoordinator = require('../core/tokenCoordinator');

    const botToken = 'MTUzMDk5OTk5OTk5OTk5OTk5.G_XXXX.YYYYZZZZ12345678';
    const originalFetch = global.fetch;

    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, headers: options?.headers });
        const auth = options?.headers?.Authorization || options?.headers?.authorization;
        if (auth && auth.startsWith('Bot ')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id: '153099999999999999',
                    username: 'AutoDetectedBot',
                    global_name: 'Auto Bot',
                    bot: true,
                    mfa_enabled: false
                })
            };
        }
        // User probe fails with 401
        return {
            ok: false,
            status: 401,
            json: async () => ({ message: '401: Unauthorized', code: 0 })
        };
    };

    try {
        const result = await checkSingleToken(botToken, { forceRefresh: true });
        assert.equal(result.valid, true);
        assert.equal(result.isBot, true);
        assert.equal(result.tokenType, 'bot');
        assert.equal(result.username, 'AutoDetectedBot');
        assert.equal(result.category, 'bot');

        // Check that 2 probes occurred (first as user, second as bot)
        assert.equal(calls.length, 2);
        assert.equal(calls[0].headers.Authorization, botToken);
        assert.equal(calls[1].headers.Authorization, `Bot ${botToken}`);

        // Check tokenCoordinator state: NOT quarantined and tokenType is 'bot'
        assert.equal(tokenCoordinator.isQuarantined(botToken), false);
        assert.equal(tokenCoordinator.getTokenType(botToken), 'bot');
    } finally {
        global.fetch = originalFetch;
        tokenCoordinator.reset();
    }
});
