'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../config.json');

const {
    QUEST_EMOJIS,
    QUEST_ERRORS,
    resolveDiscordAvatarUrl,
    buildQuestErrorEmbed,
    buildOneShotCheckingEmbed,
    buildOneShotProgressEmbed,
    buildOneShotCompletedEmbed,
    buildAutoDailyEmbed,
    formatQuestCurrentTask,
    buildRunnerLiveEmbed,
    formatRunnerStatusEmbed
} = require('../quest/core/runnerStatusHeader');

const {
    buildQuestSummaryEmbed,
    buildQuestAuthFailureEmbed,
    buildQuestStoppedEmbed
} = require('../quest/core/questDm');

const {
    createOneShotQuestSession,
    completeOneShotQuest,
    getOneShotSessionSummary,
    ONE_SHOT_QUEST_STATUS
} = require('../quest/core/oneShotSession');

test('One-shot Stage 1: Checking embed matches exact user blueprint', () => {
    const embed = buildOneShotCheckingEmbed({ username: 'PlayerOne' });

    assert.ok(embed);
    assert.equal(embed.data.title, `${QUEST_EMOJIS.bell} Log ระบบทำเควส`);
    assert.equal(embed.data.color, parseInt((config.system?.themeColors?.info || '#FFCCCC').replace('#', ''), 16));

    const desc = embed.data.description;
    assert.ok(desc.includes(`${QUEST_EMOJIS.discord} Username Token : PlayerOne`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.loadingBar} สถานะ : กำลังตรวจสอบ Quest...`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : กำลังตรวจสอบ..`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : -`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.yelj} กำลังทำ Quest : -`));
});

test('One-shot Stage 2: In-Progress embed shows single status progression', () => {
    // 1. Preparing
    const prepTask = formatQuestCurrentTask({ stage: 'preparing', gameName: 'Call of Duty: Modern Warfare 4' });
    assert.equal(prepTask, `${QUEST_EMOJIS.grep} กำลังเตรียมทำ Call of Duty: Modern Warfare 4`);

    const prepEmbed = buildOneShotProgressEmbed({
        username: 'PlayerOne',
        totalQuests: 5,
        completedQuests: 2,
        currentTaskText: prepTask
    });
    assert.equal(prepEmbed.data.title, `${QUEST_EMOJIS.bell} Log ระบบทำเควส`);
    assert.equal(prepEmbed.data.color, parseInt((config.system?.themeColors?.warning || '#D2691E').replace('#', ''), 16));
    assert.ok(prepEmbed.data.description.includes(`${QUEST_EMOJIS.loading} สถานะ : กำลังดำเนินการ ...`));
    assert.ok(prepEmbed.data.description.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : 5 รายการ`));
    assert.ok(prepEmbed.data.description.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : 2`));
    assert.ok(prepEmbed.data.description.includes(`${QUEST_EMOJIS.yelj} กำลังทำ Quest : ${QUEST_EMOJIS.grep} กำลังเตรียมทำ Call of Duty: Modern Warfare 4`));

    // 2. Doing
    const doingTask = formatQuestCurrentTask({ stage: 'doing', gameName: 'Call of Duty: Modern Warfare 4' });
    assert.equal(doingTask, `${QUEST_EMOJIS.grep} กำลังทำ Call of Duty: Modern Warfare 4`);

    // 3. Percent updates
    for (const pct of [0, 25, 50, 75, 100]) {
        const pctTask = formatQuestCurrentTask({ stage: 'progress', gameName: 'Call of Duty: Modern Warfare 4', percent: pct });
        assert.equal(pctTask, `${QUEST_EMOJIS.gearBlue} Call of Duty: Modern Warfare 4 ${pct}%`);
    }
});

test('One-shot Stage 3: Completed embed matches user blueprint with tags and itemized list', () => {
    const embed = buildOneShotCompletedEmbed({
        ownerId: '15225714593369',
        username: 'PlayerOne',
        totalQuests: 3,
        completedQuests: 3,
        completedQuestList: [
            'Call of Duty: Modern Warfare 4',
            'Valorant',
            'Genshin Impact'
        ]
    });

    assert.ok(embed);
    assert.equal(embed.data.title, `${QUEST_EMOJIS.bell} Log ระบบทำเควส`);
    assert.equal(embed.data.color, parseInt((config.system?.themeColors?.success || '#CC66FF').replace('#', ''), 16));

    const desc = embed.data.description;
    assert.ok(desc.includes(`${QUEST_EMOJIS.kroles} : <@15225714593369>`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.discord} Username Token : PlayerOne`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.sn} สถานะ : ทำ Quest อัตโนมัติเสร็จสิ้นแล้ว`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : 3 รายการ`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : 3 รายการ`));

    // Pattern 1.:Orbs_pmt: Name \n :verifyb_pmt: เสร็จสมบูรณ์
    assert.ok(desc.includes(`1.${QUEST_EMOJIS.orbs} Call of Duty: Modern Warfare 4\n${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`));
    assert.ok(desc.includes(`2.${QUEST_EMOJIS.orbs} Valorant\n${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`));
    assert.ok(desc.includes(`3.${QUEST_EMOJIS.orbs} Genshin Impact\n${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`));
});

test('One-shot Stage 3: Completed embed includes uncompleted issues with reason', () => {
    const embed = buildOneShotCompletedEmbed({
        ownerId: '15225714593369',
        username: 'deklnwfreefrie',
        totalQuests: 5,
        completedQuests: 3,
        completedQuestList: [
            'Call of Duty: Modern Warfare 4',
            'Cyberpunk: Edgerunners 2 Update',
            'Firefox Browser'
        ],
        issues: [
            { name: 'Fortnite: Chapter 6', reason: 'รับ Quest ไม่สำเร็จ' },
            { name: 'Honkai: Star Rail', reason: 'Discord ยังไม่ยืนยันการรับ Quest' }
        ]
    });

    assert.ok(embed);
    const desc = embed.data.description;
    assert.ok(desc.includes(`${QUEST_EMOJIS.kroles} : <@15225714593369>`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.discord} Username Token : deklnwfreefrie`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.sn} สถานะ : ทำ Quest อัตโนมัติเสร็จสิ้นแล้ว`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : 5 รายการ`));
    assert.ok(desc.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : 3 รายการ`));
    assert.ok(desc.includes(`1.${QUEST_EMOJIS.orbs} Call of Duty: Modern Warfare 4\n${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`));
    assert.ok(desc.includes(`2.${QUEST_EMOJIS.orbs} Cyberpunk: Edgerunners 2 Update\n${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`));
    assert.ok(desc.includes(`3.${QUEST_EMOJIS.orbs} Firefox Browser\n${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`));
    assert.ok(desc.includes(`4.${QUEST_EMOJIS.orbs} Fortnite: Chapter 6\n${QUEST_EMOJIS.cross} ไม่สำเร็จ (รับ Quest ไม่สำเร็จ)`));
    assert.ok(desc.includes(`5.${QUEST_EMOJIS.orbs} Honkai: Star Rail\n${QUEST_EMOJIS.cross} ไม่สำเร็จ (Discord ยังไม่ยืนยันการรับ Quest)`));
});

test('Auto Daily Mode: Renders the 3 cyclic statuses with all-time and daily counters', () => {
    // 1. Checking
    const checking = buildAutoDailyEmbed({
        username: 'DailyMaster',
        status: 'checking',
        allTimeSupported: 47,
        allTimeCompleted: 42
    });
    assert.equal(checking.data.title, `${QUEST_EMOJIS.bell} Log ระบบทำเควส (ต่อเนื่องทุกวัน)`);
    assert.equal(checking.data.color, parseInt((config.system?.themeColors?.info || '#FFCCCC').replace('#', ''), 16));
    assert.ok(checking.data.description.includes(`${QUEST_EMOJIS.loadingBar} สถานะ : กำลังตรวจสอบ Quest...`));
    assert.ok(checking.data.description.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ ทั้งหมด : 47 รายการ`));
    assert.ok(checking.data.description.includes(`${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว ทั้งหมด : 42 รายการ`));
    assert.ok(checking.data.description.includes(`${QUEST_EMOJIS.orjj} จำนวน Quest ที่รองรับ วันนี้ : กำลังตรวจสอบ..`));
    assert.ok(checking.data.description.includes(`${QUEST_EMOJIS.orjj} จำนวน Quest ที่ทำเสร็จเเล้ว วันนี้ : -`));
    assert.ok(checking.data.description.includes(`${QUEST_EMOJIS.yelj} กำลังทำ Quest : -`));

    // 2. In-Progress
    const running = buildAutoDailyEmbed({
        username: 'DailyMaster',
        status: 'running',
        allTimeSupported: 52,
        allTimeCompleted: 42,
        todaySupported: 5,
        todayCompleted: 1,
        currentTaskText: `${QUEST_EMOJIS.gearBlue} Minecraft 50%`
    });
    assert.equal(running.data.color, parseInt((config.system?.themeColors?.warning || '#D2691E').replace('#', ''), 16));
    assert.ok(running.data.description.includes(`${QUEST_EMOJIS.loading} สถานะ : กำลังดำเนินการ ...`));
    assert.ok(running.data.description.includes(`${QUEST_EMOJIS.orjj} จำนวน Quest ที่รองรับ วันนี้ : 5 รายการ`));
    assert.ok(running.data.description.includes(`${QUEST_EMOJIS.orjj} จำนวน Quest ที่ทำเสร็จเเล้ว วันนี้ : 1 รายการ`));
    assert.ok(running.data.description.includes(`${QUEST_EMOJIS.yelj} กำลังทำ Quest : ${QUEST_EMOJIS.gearBlue} Minecraft 50%`));

    // 3. Standby / Completed today
    const standby = buildAutoDailyEmbed({
        username: 'DailyMaster',
        status: 'standby',
        allTimeSupported: 52,
        allTimeCompleted: 47,
        todaySupported: 5,
        todayCompleted: 5
    });
    assert.equal(standby.data.color, parseInt((config.system?.themeColors?.success || '#CC66FF').replace('#', ''), 16));
    assert.ok(standby.data.description.includes(`${QUEST_EMOJIS.sn} สถานะ : ทำ Quest เสร็จเเล้ว กำลังรอวันต่อไป`));
    assert.ok(standby.data.description.includes(`${QUEST_EMOJIS.yelj} กำลังทำ Quest : เสร็จสิ้นเเล้ววันนี้`));
});

test('Standardized Errors: All 7 templates format correctly with tag and status', () => {
    const errColor = parseInt((config.system?.themeColors?.error || '#FF9999').replace('#', ''), 16);
    const successColor = parseInt((config.system?.themeColors?.success || '#CC66FF').replace('#', ''), 16);
    const errorCases = [
        {
            type: 'RUNNER_ABORTED',
            icon: QUEST_EMOJIS.cross,
            text: 'ผู้ใช้สั่งหยุดการทำงานของ Quest แล้ว',
            color: errColor
        },
        {
            type: 'COMPLETED_EXTERNAL',
            icon: QUEST_EMOJIS.cross,
            text: 'ระหว่างบอทรัน มีการเปิดเล่นเองจากแอป Discord จนเควสต์จบก่อน',
            color: errColor
        },
        {
            type: 'EXECUTION_FAILED',
            icon: QUEST_EMOJIS.cross,
            text: 'เกิดข้อผิดพลาดของระบบdiscord บอทไม่สามารถทำงานได้ในTokenนี้ โปรดลองอีกครั้ง',
            color: errColor
        },
        {
            type: 'ENROLLMENT_FAILED',
            icon: QUEST_EMOJIS.cross,
            text: 'บัญชีไม่ผ่านเงื่อนไขรับเควสต์ หรือ เควสต์หมดเวลาไปก่อน',
            color: errColor
        },
        {
            type: 'NO_RUNNABLE_QUESTS',
            icon: QUEST_EMOJIS.sn,
            text: 'บัญชีนี้ไม่มีเควสต์ที่รองรับ หรือ ทำไปหมดแล้ว',
            color: successColor
        },
        {
            type: 'FATAL_AUTH_FAILURE',
            icon: QUEST_EMOJIS.cross,
            text: 'Token บัญชี Quest ใช้งานไม่ได้ กรุณาลองตรวจสอบ Token นี้ เเละ ลองอีกครั้ง',
            color: errColor
        },
        {
            type: 'RATE_LIMIT_429',
            icon: QUEST_EMOJIS.cross,
            text: 'ติด Rate Limit ชั่วคราว (HTTP 429) / เครือข่ายหน่วง กรุณา ลองอีกครั้ง',
            color: errColor
        }
    ];

    for (const tc of errorCases) {
        const embed = buildQuestErrorEmbed({
            errorType: tc.type,
            ownerId: '987654321',
            username: 'TargetUser'
        });

        assert.equal(embed.data.title, `${QUEST_EMOJIS.bell} Log ระบบทำเควส`);
        assert.equal(embed.data.color, tc.color);
        assert.ok(embed.data.description.includes(`${QUEST_EMOJIS.kroles} : <@987654321>`));
        assert.ok(embed.data.description.includes(`${QUEST_EMOJIS.discord} Username Token : TargetUser`));
        assert.ok(embed.data.description.includes(`${tc.icon} สถานะ : ${tc.text}`));
    }
});

test('COMPLETED_EXTERNAL rule: Treated as completed without adding issue', () => {
    const session = createOneShotQuestSession([
        { id: 'q1', name: 'External Quest', eventName: 'PLAY_ON_DESKTOP', progressSecs: 0 }
    ]);

    const status = completeOneShotQuest(session, 'q1');
    assert.equal(status, ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL);

    const summary = getOneShotSessionSummary(session);
    assert.equal(summary.completedExternalCount, 1);
    assert.equal(summary.totalCompletedCount, 1);
    assert.equal(summary.issues.length, 0, 'Completed external should not be treated as a failure issue');
});

test('resolveDiscordAvatarUrl: Correctly constructs avatar URLs for animated, static, and default avatars', () => {
    // 1. Explicit avatarUrl preserved
    assert.equal(
        resolveDiscordAvatarUrl({ avatarUrl: 'https://example.com/pic.png' }),
        'https://example.com/pic.png'
    );

    // 2. Animated GIF avatar (a_ prefix)
    assert.equal(
        resolveDiscordAvatarUrl({ id: '123456789012345678', avatar: 'a_abcdef123456' }),
        'https://cdn.discordapp.com/avatars/123456789012345678/a_abcdef123456.gif?size=256'
    );

    // 3. Static PNG avatar
    assert.equal(
        resolveDiscordAvatarUrl({ id: '123456789012345678', avatar: 'abcdef123456' }),
        'https://cdn.discordapp.com/avatars/123456789012345678/abcdef123456.png?size=256'
    );

    // 4. Default avatar fallback via user id
    const defaultUrl = resolveDiscordAvatarUrl({ id: '123456789012345678', avatar: null });
    assert.match(defaultUrl, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/);

    // 5. Null user returns null
    assert.equal(resolveDiscordAvatarUrl(null), null);
});

test('Quest Live Progress and Summary embeds render avatar thumbnail when avatarUrl is provided', () => {
    const testAvatarUrl = 'https://cdn.discordapp.com/avatars/111222333444555666/avatarhash.png?size=256';

    // 1. One-shot Checking Embed
    const checking = buildOneShotCheckingEmbed({ username: 'PlayerOne', avatarUrl: testAvatarUrl });
    assert.equal(checking.data.thumbnail?.url, testAvatarUrl);

    // 2. One-shot Progress Embed
    const progress = buildOneShotProgressEmbed({ username: 'PlayerOne', totalQuests: 3, completedQuests: 1, avatarUrl: testAvatarUrl });
    assert.equal(progress.data.thumbnail?.url, testAvatarUrl);

    // 3. One-shot Completed Embed (Summary)
    const completed = buildOneShotCompletedEmbed({ username: 'PlayerOne', totalQuests: 3, completedQuests: 3, avatarUrl: testAvatarUrl });
    assert.equal(completed.data.thumbnail?.url, testAvatarUrl);

    // 4. Auto Daily Embed
    const daily = buildAutoDailyEmbed({ username: 'DailyPlayer', status: 'running', avatarUrl: testAvatarUrl });
    assert.equal(daily.data.thumbnail?.url, testAvatarUrl);

    // 5. Error Embed
    const errorEmbed = buildQuestErrorEmbed({ errorType: 'EXECUTION_FAILED', username: 'ErrorPlayer', avatarUrl: testAvatarUrl });
    assert.equal(errorEmbed.data.thumbnail?.url, testAvatarUrl);

    // 6. Live Runner Status Embed from rawContent with state.avatarUrl
    const rawContent = '```\n✅ LOGIN : RunnerToken\n🔎 RunnerToken: พบ 2 QUESTS\n```';
    const liveEmbed = formatRunnerStatusEmbed(rawContent, {
        username: 'RunnerToken',
        avatarUrl: testAvatarUrl,
        totalQuests: 2,
        completedQuests: 0
    });
    assert.equal(liveEmbed.data.thumbnail?.url, testAvatarUrl);

    // 7. Summary Embed with avatarUrl
    const summaryEmbed = buildQuestSummaryEmbed({
        username: 'RunnerToken',
        totalQuests: 2,
        completedQuests: 2,
        completedQuestList: ['Quest 1', 'Quest 2'],
        avatarUrl: testAvatarUrl
    });
    assert.equal(summaryEmbed.data.thumbnail?.url, testAvatarUrl);

    // 8. Omitted avatarUrl does not add thumbnail (backward compatible)
    const plainChecking = buildOneShotCheckingEmbed({ username: 'PlayerNoAvatar' });
    assert.equal(plainChecking.data.thumbnail, undefined);
});

