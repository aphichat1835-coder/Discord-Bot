'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    maskToken,
    getAccountCreatedAt,
    formatDateBangkok,
    getAccountAgeString,
    resolveNitroPlan,
    resolveAvatarUrl,
    buildSingleTokenEmbed,
    buildBatchSummaryEmbed,
    createCategoryAttachments,
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
    assert.match(boostEmbed.data.title, /ข้อมูลบัญชี Discord Token/);
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
    assert.match(batchEmbed.data.description, /สรุปผลการตรวจสอบทั้งหมด.*3.*บัญชี/);
    assert.match(batchEmbed.data.description, /Apichat/);
    assert.match(batchEmbed.data.description, /NormalUser/);

    // 4. Category attachments
    const groups = {
        boost: [{ token: 'token_boost_1' }],
        nitro: [],
        normal: [{ token: 'token_normal_1' }, { token: 'token_normal_2' }],
        invalid: [{ token: 'token_invalid_1' }]
    };
    const files = createCategoryAttachments(groups);
    assert.equal(files.length, 3);
    const names = files.map(f => f.name);
    assert.ok(names.includes('tokens_boost.txt'));
    assert.ok(!names.includes('tokens_nitro.txt'));
    assert.ok(names.includes('tokens_normal.txt'));
    assert.ok(names.includes('tokens_invalid.txt'));
});

test('tokenCheck command and interactions behave correctly', async () => {
    // 1. customIds predicates
    assert.equal(isTokenCheckButton(IDS.BTN_TOKEN_CHECK), true);
    assert.equal(isTokenCheckButton('other_id'), false);
    assert.equal(isTokenCheckModal(IDS.MODAL_TOKEN_CHECK), true);
    assert.equal(isTokenCheckModal('other_modal'), false);

    // 2. buildTokenCheckPanelEmbed and Row
    const panelEmbed = buildTokenCheckPanelEmbed();
    assert.match(panelEmbed.data.title, /Phomueangtai Discord Token Checker/);
    assert.match(panelEmbed.data.description, /ระบบตรวจสอบสถานะ Discord Token แบบส่วนตัว/);

    const panelRow = buildTokenCheckPanelRow();
    assert.equal(panelRow.components.length, 1);
    assert.equal(panelRow.components[0].data.custom_id, IDS.BTN_TOKEN_CHECK);
    assert.equal(panelRow.components[0].data.label, 'เช็คโทเคน');

    // 3. handleTokenCheckCommand replies ephemeral
    let repliedPayload = null;
    const mockInteraction = {
        reply: async (payload) => {
            repliedPayload = payload;
            return payload;
        }
    };
    await handleTokenCheckCommand(mockInteraction);
    assert.ok(repliedPayload);
    assert.equal(repliedPayload.flags, 64);
    assert.equal(repliedPayload.embeds.length, 1);
    assert.equal(repliedPayload.components.length, 1);

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
    assert.match(overflowReplyContent.content, /สูงสุดครั้งละ \*\*20 บัญชี\*\*/);
});
