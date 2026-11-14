'use strict';

const { MessageEmbed } = require('../../core/discordCompat');
const config = require('../../config.json');
const { formatScheduleTime } = require('./runnerSchedule');

const QUEST_EMOJIS = Object.freeze({
    bell: config.emojis?.bell_pmt || config.emojis?.bell || '<a:bell_pmt:1559247893343248438>',
    discord: config.emojis?.Discord_pmt || config.emojis?.server_icon || '<:Discord_pmt:1553835220912840814>',
    loadingBar: config.emojis?.GR_14_pmt || config.emojis?.loading_bar || '<a:GR_14_pmt:1554178576427913216>',
    loading: config.emojis?.Loadingg_pmt || config.emojis?.loading || '<a:Loadingg_pmt:1553844457856827393>',
    grej: config.emojis?.Grej_pmt || config.emojis?.grej || '<:Grej_pmt:1560405771978547340>',
    yelj: config.emojis?.yelj_pmt || config.emojis?.yelj || '<:yelj_pmt:1560405792950329454>',
    orjj: config.emojis?.orjj_pmt || config.emojis?.orjj || '<:orjj_pmt:1560405782795649145>',
    grep: config.emojis?.Grep_pmt || config.emojis?.grep || '<a:Grep_pmt:1560411233214009454>',
    gearBlue: config.emojis?.UN9_pmt || config.emojis?.gear_blue || '<a:UN9_pmt:1561669460027244614>',
    kroles: config.emojis?.kroles_pmt || config.emojis?.members || '<:kroles_pmt:1553835237333672006>',
    sn: config.emojis?.sn_pmt || config.emojis?.check_white || '<a:sn_pmt:1559878089750749244>',
    orbs: config.emojis?.Orbs_pmt || config.emojis?.orbs || '<:Orbs_pmt:1560211653478453261>',
    verifyb: config.emojis?.verifyb_pmt || config.emojis?.check_black || '<a:verifyb_pmt:1561669634183397409>',
    cross: config.emojis?.CROSS_pmt || config.emojis?.error || '<a:CROSS_pmt:1553833049135906816>'
});

const QUEST_ERRORS = Object.freeze({
    RUNNER_ABORTED: {
        icon: QUEST_EMOJIS.cross,
        status: 'ผู้ใช้สั่งหยุดการทำงานของ Quest แล้ว',
        color: config.system?.themeColors?.error || '#FF9999'
    },
    COMPLETED_EXTERNAL: {
        icon: QUEST_EMOJIS.cross,
        status: 'ระหว่างบอทรัน มีการเปิดเล่นเองจากแอป Discord จนเควสต์จบก่อน',
        color: config.system?.themeColors?.error || '#FF9999'
    },
    EXECUTION_FAILED: {
        icon: QUEST_EMOJIS.cross,
        status: 'เกิดข้อผิดพลาดของระบบdiscord บอทไม่สามารถทำงานได้ในTokenนี้ โปรดลองอีกครั้ง',
        color: config.system?.themeColors?.error || '#FF9999'
    },
    ENROLLMENT_FAILED: {
        icon: QUEST_EMOJIS.cross,
        status: 'บัญชีไม่ผ่านเงื่อนไขรับเควสต์ หรือ เควสต์หมดเวลาไปก่อน',
        color: config.system?.themeColors?.error || '#FF9999'
    },
    NO_RUNNABLE_QUESTS: {
        icon: QUEST_EMOJIS.sn,
        status: 'บัญชีนี้ไม่มีเควสต์ที่รองรับ หรือ ทำไปหมดแล้ว',
        color: config.system?.themeColors?.success || '#CC66FF'
    },
    FATAL_AUTH_FAILURE: {
        icon: QUEST_EMOJIS.cross,
        status: 'Token บัญชี Quest ใช้งานไม่ได้ กรุณาลองตรวจสอบ Token นี้ เเละ ลองอีกครั้ง',
        color: config.system?.themeColors?.error || '#FF9999'
    },
    RATE_LIMIT_429: {
        icon: QUEST_EMOJIS.cross,
        status: 'ติด Rate Limit ชั่วคราว (HTTP 429) / เครือข่ายหน่วง กรุณา ลองอีกครั้ง',
        color: config.system?.themeColors?.error || '#FF9999'
    }
});

const QUEST_COUNT_LINE = /^🔎 .+: พบ (\d+) QUESTS$/;
const COMPLETED_COUNT_LINE = /^🎉 .+: ทำสำเร็จ (\d+) QUESTS$/;
const CLEAR_ACTIVITY_LINE = '🧹 QUEST ACTIVITY CLEARED';
const MAX_DISCORD_MESSAGE_LENGTH = 1950;

function readCodeBlockLines(content) {
    if (typeof content !== 'string') return null;
    if (!content.startsWith('```\n') || !content.endsWith('\n```')) return null;
    return content.slice(4, -4).split('\n');
}

function consumeRunnerStatusLine(line, state, activityLines) {
    if (line.startsWith('✅ LOGIN : ') || line.startsWith('✅ ACCOUNT : ')) {
        state.loginLine = line;
        return;
    }
    if (line.startsWith('🤖 AUTO DAILY ENABLED')) {
        state.modeLine = line;
        return;
    }

    const questCountMatch = QUEST_COUNT_LINE.exec(line);
    if (questCountMatch) {
        const count = Number.parseInt(questCountMatch[1], 10);
        state.latestQuestCount = count;
        state.totalQuestCount ??= count;
        return;
    }

    const completedCountMatch = COMPLETED_COUNT_LINE.exec(line);
    if (completedCountMatch) {
        state.completedQuestCount = Number.parseInt(completedCountMatch[1], 10);
        return;
    }

    if (line === CLEAR_ACTIVITY_LINE) {
        activityLines.length = 0;
        return;
    }
    if (line) activityLines.push(line);
}

function buildRunnerStatusContent(headerLines, activityLines) {
    return `\`\`\`\n${[...headerLines, ...activityLines].join('\n')}\n\`\`\``;
}

function clampCodeBlockContent(content) {
    if (content.length <= MAX_DISCORD_MESSAGE_LENGTH) return content;
    const prefix = '```\n';
    const suffix = '\n```';
    const body = content.slice(prefix.length, -suffix.length);
    const bodyBudget = MAX_DISCORD_MESSAGE_LENGTH - prefix.length - suffix.length;
    return `${prefix}${body.slice(0, bodyBudget - 1)}…${suffix}`;
}

function buildHeaderLines(state) {
    if (state.modeLine) {
        return [
            state.loginLine,
            state.modeLine,
            `🔍 ตรวจพบ Quest ที่พร้อมทำ : ${state.latestQuestCount ?? 'กำลังตรวจสอบ...'}`,
            '────────────────────────'
        ].filter(Boolean);
    }

    return [
        state.loginLine,
        `🔍 บอทตรวจพบ Quest ที่ทำได้ทั้งหมด : ${state.totalQuestCount ?? 'กำลังตรวจสอบ...'}`,
        `🎉 บอททำ Quest ให้อัตโนมัติไปแล้วทั้งหมด : ${state.completedQuestCount ?? 0}`,
        '────────────────────────'
    ].filter(Boolean);
}

function formatRunnerStatusContent(content, state = {}) {
    const lines = readCodeBlockLines(content);
    if (!lines) return content;

    const activityLines = [];
    for (const line of lines) consumeRunnerStatusLine(line, state, activityLines);
    if (!state.loginLine) return content;

    const headerLines = buildHeaderLines(state);
    const visibleActivity = [...activityLines];
    let formatted = buildRunnerStatusContent(headerLines, visibleActivity);
    while (formatted.length > MAX_DISCORD_MESSAGE_LENGTH && visibleActivity.length > 0) {
        visibleActivity.shift();
        formatted = buildRunnerStatusContent(headerLines, visibleActivity);
    }
    return clampCodeBlockContent(formatted);
}

function formatQuestCurrentTask({ stage = 'doing', gameName = '', percent = 0 } = {}) {
    if (stage === 'preparing') {
        return `${QUEST_EMOJIS.grep} กำลังเตรียมทำ ${gameName}`;
    }
    if (stage === 'progress' || (typeof percent === 'number' && percent > 0)) {
        return `${QUEST_EMOJIS.gearBlue} ${gameName} ${percent}%`;
    }
    return `${QUEST_EMOJIS.grep} กำลังทำ ${gameName}`;
}

function resolveDiscordAvatarUrl(user) {
    if (!user) return null;
    if (typeof user.avatarUrl === 'string' && user.avatarUrl) {
        return user.avatarUrl;
    }
    const id = user.id ? String(user.id) : null;
    if (id && user.avatar) {
        const ext = typeof user.avatar === 'string' && user.avatar.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.${ext}?size=256`;
    }
    if (id) {
        try {
            if (user.discriminator && user.discriminator !== '0') {
                const legacyIndex = Number(user.discriminator) % 5;
                return `https://cdn.discordapp.com/embed/avatars/${legacyIndex}.png`;
            }
            const defaultIndex = (BigInt(id) >> 22n) % 6n;
            return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
        } catch {
            return 'https://cdn.discordapp.com/embed/avatars/0.png';
        }
    }
    return null;
}

function buildQuestErrorEmbed({
    errorType = 'EXECUTION_FAILED',
    errorMessage = null,
    ownerId = null,
    username = 'ไม่ทราบชื่อ',
    avatarUrl = null,
    timestamp = Date.now()
} = {}) {
    const errorDef = QUEST_ERRORS[errorType] || {
        icon: QUEST_EMOJIS.cross,
        status: errorMessage || 'เกิดข้อผิดพลาดของระบบdiscord บอทไม่สามารถทำงานได้ในTokenนี้ โปรดลองอีกครั้ง',
        color: config.system?.themeColors?.error || '#FF9999'
    };
    const statusText = errorMessage || errorDef.status;
    const ownerLine = ownerId ? `${QUEST_EMOJIS.kroles} : <@${ownerId}>\n` : '';
    const description = `${ownerLine}${QUEST_EMOJIS.discord} Username Token : ${username}\n${errorDef.icon} สถานะ : ${statusText}`;

    const embed = new MessageEmbed()
        .setColor(errorDef.color)
        .setTitle(`${QUEST_EMOJIS.bell} Log ระบบทำเควส`)
        .setDescription(description)
        .setTimestamp(Number(timestamp));

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }
    return embed;
}

function buildOneShotCheckingEmbed({
    username = 'ไม่ทราบชื่อ',
    avatarUrl = null,
    timestamp = Date.now()
} = {}) {
    const description = [
        `${QUEST_EMOJIS.discord} Username Token : ${username}`,
        `${QUEST_EMOJIS.loadingBar} สถานะ : กำลังตรวจสอบ Quest...`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : กำลังตรวจสอบ..`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : -`,
        `${QUEST_EMOJIS.yelj} กำลังทำ Quest : -`
    ].join('\n');

    const embed = new MessageEmbed()
        .setColor(config.system?.themeColors?.info || '#FFCCCC')
        .setTitle(`${QUEST_EMOJIS.bell} Log ระบบทำเควส`)
        .setDescription(description)
        .setTimestamp(Number(timestamp));

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }
    return embed;
}

function buildOneShotProgressEmbed({
    username = 'ไม่ทราบชื่อ',
    totalQuests = 0,
    completedQuests = 0,
    currentTaskText = '-',
    avatarUrl = null,
    timestamp = Date.now()
} = {}) {
    const totalDisplay = typeof totalQuests === 'number' ? `${totalQuests} รายการ` : (totalQuests || 'กำลังตรวจสอบ..');
    const completedDisplay = typeof completedQuests === 'number' ? `${completedQuests}` : (completedQuests ?? '0');
    const taskDisplay = currentTaskText || '-';

    const description = [
        `${QUEST_EMOJIS.discord} Username Token : ${username}`,
        `${QUEST_EMOJIS.loading} สถานะ : กำลังดำเนินการ ...`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : ${totalDisplay}`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : ${completedDisplay}`,
        `${QUEST_EMOJIS.yelj} กำลังทำ Quest : ${taskDisplay}`
    ].join('\n');

    const embed = new MessageEmbed()
        .setColor(config.system?.themeColors?.warning || '#D2691E')
        .setTitle(`${QUEST_EMOJIS.bell} Log ระบบทำเควส`)
        .setDescription(description)
        .setTimestamp(Number(timestamp));

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }
    return embed;
}

function buildOneShotCompletedEmbed({
    ownerId = null,
    username = 'ไม่ทราบชื่อ',
    totalQuests = 0,
    completedQuests = 0,
    completedQuestList = [],
    issues = [],
    avatarUrl = null,
    timestamp = Date.now()
} = {}) {
    const ownerLine = ownerId ? `${QUEST_EMOJIS.kroles} : <@${ownerId}>\n` : '';
    const totalCount = typeof totalQuests === 'number' ? totalQuests : (completedQuestList?.length || 0);
    const doneCount = typeof completedQuests === 'number' ? completedQuests : (completedQuestList?.length || 0);

    const lines = [
        `${ownerLine}${QUEST_EMOJIS.discord} Username Token : ${username}`,
        `${QUEST_EMOJIS.sn} สถานะ : ทำ Quest อัตโนมัติเสร็จสิ้นแล้ว`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ : ${totalCount} รายการ`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว : ${doneCount} รายการ`
    ];

    let currentIdx = 0;
    if (Array.isArray(completedQuestList) && completedQuestList.length > 0) {
        lines.push('');
        completedQuestList.forEach((questName) => {
            currentIdx += 1;
            lines.push(
                `${currentIdx}.${QUEST_EMOJIS.orbs} ${questName}`,
                `${QUEST_EMOJIS.verifyb} เสร็จสมบูรณ์`
            );
        });
    }

    if (Array.isArray(issues) && issues.length > 0) {
        if (currentIdx === 0) lines.push('');
        issues.forEach((issue) => {
            const questName = typeof issue === 'string' ? issue : (issue?.name || 'Quest ไม่ทราบชื่อ');
            if (completedQuestList?.includes(questName)) return;
            currentIdx += 1;
            const reason = typeof issue === 'object' && issue?.reason ? issue.reason : 'รับ Quest ไม่สำเร็จ';
            lines.push(
                `${currentIdx}.${QUEST_EMOJIS.orbs} ${questName}`,
                `${QUEST_EMOJIS.cross} ไม่สำเร็จ (${reason})`
            );
        });
    }

    const embed = new MessageEmbed()
        .setColor(config.system?.themeColors?.success || '#CC66FF')
        .setTitle(`${QUEST_EMOJIS.bell} Log ระบบทำเควส`)
        .setDescription(lines.join('\n'))
        .setTimestamp(Number(timestamp));

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }
    return embed;
}

function buildAutoDailyEmbed({
    username = 'ไม่ทราบชื่อ',
    status = 'checking', // 'checking' | 'running' | 'standby'
    allTimeSupported = 0,
    allTimeCompleted = 0,
    todaySupported = null,
    todayCompleted = null,
    currentTaskText = null,
    avatarUrl = null,
    timestamp = Date.now()
} = {}) {
    let statusIcon = QUEST_EMOJIS.loadingBar;
    let statusText = 'กำลังตรวจสอบ Quest...';
    let todaySupportedText = 'กำลังตรวจสอบ..';
    let todayCompletedText = '-';
    let todayTaskText = '-';
    let color = config.system?.themeColors?.info || '#FFCCCC';

    if (status === 'running') {
        statusIcon = QUEST_EMOJIS.loading;
        statusText = 'กำลังดำเนินการ ...';
        todaySupportedText = todaySupported != null ? `${todaySupported} รายการ` : 'กำลังตรวจสอบ..';
        todayCompletedText = todayCompleted != null ? `${todayCompleted} รายการ` : '0 รายการ';
        todayTaskText = currentTaskText || '-';
        color = config.system?.themeColors?.warning || '#D2691E';
    } else if (status === 'standby') {
        statusIcon = QUEST_EMOJIS.sn;
        statusText = 'ทำ Quest เสร็จเเล้ว กำลังรอวันต่อไป';
        todaySupportedText = todaySupported != null && todaySupported > 0 ? `${todaySupported} รายการ` : '-';
        todayCompletedText = todayCompleted != null && todayCompleted > 0 ? `${todayCompleted} รายการ` : '-';
        todayTaskText = 'เสร็จสิ้นเเล้ววันนี้';
        color = config.system?.themeColors?.success || '#CC66FF';
    }

    const description = [
        `${QUEST_EMOJIS.discord} Username Token : ${username}`,
        `${statusIcon} สถานะ : ${statusText}`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่รองรับ ทั้งหมด : ${allTimeSupported} รายการ`,
        `${QUEST_EMOJIS.grej} จำนวน Quest ที่ทำเสร็จเเล้ว ทั้งหมด : ${allTimeCompleted} รายการ`,
        '',
        `${QUEST_EMOJIS.orjj} จำนวน Quest ที่รองรับ วันนี้ : ${todaySupportedText}`,
        `${QUEST_EMOJIS.orjj} จำนวน Quest ที่ทำเสร็จเเล้ว วันนี้ : ${todayCompletedText}`,
        `${QUEST_EMOJIS.yelj} กำลังทำ Quest : ${todayTaskText}`
    ].join('\n');

    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(`${QUEST_EMOJIS.bell} Log ระบบทำเควส (ต่อเนื่องทุกวัน)`)
        .setDescription(description)
        .setTimestamp(Number(timestamp));

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }
    return embed;
}

function resolveRunnerUsername(state) {
    if (state.username) return state.username;
    if (state.loginLine) {
        return state.loginLine.replace(/^✅ (?:LOGIN|ACCOUNT) : /, '').trim() || 'ไม่ทราบชื่อ';
    }
    return 'ไม่ทราบชื่อ';
}

function parsePercentTask(line) {
    const pctIndex = line.lastIndexOf('%');
    if (pctIndex === -1) return null;
    const beforePct = line.slice(0, pctIndex).trimEnd();
    const lastSpace = beforePct.lastIndexOf(' ');
    if (lastSpace === -1) return null;
    const pctStr = beforePct.slice(lastSpace + 1);
    if (!/^\d+$/.test(pctStr)) return null;
    const rawGameName = beforePct.slice(0, lastSpace);
    const gameName = rawGameName.replace(/^[^\w\sก-๙]+/, '').trim();
    if (!gameName) return null;
    return `${QUEST_EMOJIS.gearBlue} ${gameName} ${pctStr}%`;
}

const TASK_PREPARE_REGEX = /กำลังเตรียมทำ\s+([^\r\n]+)/;
const TASK_WORKING_REGEX = /กำลังทำ\s+([^\r\n]+)/;

function parseActivityTaskLine(line) {
    if (typeof line !== 'string') return null;
    if (line.includes('กำลังเตรียมทำ')) {
        const match = TASK_PREPARE_REGEX.exec(line);
        return match ? `${QUEST_EMOJIS.grep} กำลังเตรียมทำ ${match[1].trim()}` : line;
    }
    if (line.includes('กำลังทำ')) {
        const match = TASK_WORKING_REGEX.exec(line);
        return match ? `${QUEST_EMOJIS.grep} กำลังทำ ${match[1].trim()}` : line;
    }
    if (line.includes('%')) {
        return parsePercentTask(line);
    }
    return null;
}

function extractCurrentTaskFromLines(activityLines) {
    if (!Array.isArray(activityLines) || activityLines.length === 0) return '-';
    for (let i = activityLines.length - 1; i >= 0; i--) {
        const line = activityLines[i];
        const task = parseActivityTaskLine(line);
        if (task) return task;
    }
    return '-';
}

function resolveRunnerErrorEmbed(state, activityLines, context) {
    const { ownerId, username, avatarUrl } = context;
    if (state.errorType) {
        return buildQuestErrorEmbed({
            errorType: state.errorType,
            errorMessage: state.errorMessage,
            ownerId,
            username,
            avatarUrl,
            timestamp: state.timestamp
        });
    }

    const hasStoppedLog = activityLines.some((l) => typeof l === 'string' && (l.includes('RUNNER STOPPED') || l.includes('สั่งหยุด')));
    if (state.status === 'stopped' || hasStoppedLog) {
        return buildQuestErrorEmbed({
            errorType: 'RUNNER_ABORTED',
            ownerId,
            username,
            avatarUrl,
            timestamp: state.timestamp
        });
    }

    const hasAuthFailLog = activityLines.some((l) => typeof l === 'string' && (l.includes('AUTH FAILED') || l.includes('Token quarantined') || l.includes('Token invalid')));
    if (state.status === 'auth_failed' || hasAuthFailLog) {
        return buildQuestErrorEmbed({
            errorType: 'FATAL_AUTH_FAILURE',
            ownerId,
            username,
            avatarUrl,
            timestamp: state.timestamp
        });
    }

    return null;
}

function buildOneShotEmbed(state, activityLines, context) {
    const { ownerId, username, avatarUrl } = context;
    const total = state.totalQuests ?? state.totalQuestCount;
    const completed = state.completedQuests ?? state.completedQuestCount ?? 0;
    const completedList = state.completedQuestList || [];
    const issues = state.issues || [];

    const isAllDone = state.status === 'completed' || (typeof total === 'number' && total > 0 && completed >= total);
    if (isAllDone) {
        return buildOneShotCompletedEmbed({
            ownerId,
            username,
            totalQuests: total,
            completedQuests: completed,
            completedQuestList: completedList,
            issues,
            avatarUrl,
            timestamp: state.timestamp
        });
    }

    if (state.status === 'checking' || total === undefined || total === null) {
        return buildOneShotCheckingEmbed({
            username,
            avatarUrl,
            timestamp: state.timestamp
        });
    }

    const taskText = state.currentTaskText || extractCurrentTaskFromLines(activityLines);
    return buildOneShotProgressEmbed({
        username,
        totalQuests: total,
        completedQuests: completed,
        currentTaskText: taskText,
        avatarUrl,
        timestamp: state.timestamp
    });
}

function resolveAutoDailyLiveEmbed(state, activityLines, context) {
    const hasStandbyLog = activityLines.some((l) => typeof l === 'string' && (l.includes('AUTO DAILY ACTIVE') || l.includes('NEXT CHECK')));
    let dailyStatus = state.status || 'checking';
    if (dailyStatus !== 'running' && (dailyStatus === 'standby' || hasStandbyLog)) {
        dailyStatus = 'standby';
    }

    const taskText = state.currentTaskText || extractCurrentTaskFromLines(activityLines);

    return buildAutoDailyEmbed({
        username: context.username,
        status: dailyStatus,
        allTimeSupported: state.allTimeSupported ?? (state.totalQuestCount ?? 0),
        allTimeCompleted: state.allTimeCompleted ?? (state.completedQuestCount ?? 0),
        todaySupported: state.todaySupported ?? state.latestQuestCount ?? null,
        todayCompleted: state.todayCompleted ?? null,
        currentTaskText: taskText,
        avatarUrl: context.avatarUrl,
        timestamp: state.timestamp
    });
}

function buildRunnerLiveEmbed(state = {}, activityLines = []) {
    const username = resolveRunnerUsername(state);
    const ownerId = state.ownerId || null;
    const avatarUrl = state.avatarUrl || null;
    const context = { username, ownerId, avatarUrl };

    const errorEmbed = resolveRunnerErrorEmbed(state, activityLines, context);
    if (errorEmbed) return errorEmbed;

    const isDaily = state.mode === 'scheduled' || Boolean(state.modeLine);
    if (isDaily) {
        return resolveAutoDailyLiveEmbed(state, activityLines, context);
    }

    return buildOneShotEmbed(state, activityLines, context);
}

function formatRunnerStatusEmbed(content, state = {}) {
    const lines = readCodeBlockLines(content);
    const parsedState = { ...state };
    const activityLines = [];

    if (lines) {
        for (const line of lines) {
            consumeRunnerStatusLine(line, parsedState, activityLines);
        }
    }

    return buildRunnerLiveEmbed(parsedState, activityLines);
}

module.exports = {
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
    formatRunnerStatusEmbed,
    formatRunnerStatusContent,
    readCodeBlockLines,
    clampCodeBlockContent,
    MAX_DISCORD_MESSAGE_LENGTH
};
