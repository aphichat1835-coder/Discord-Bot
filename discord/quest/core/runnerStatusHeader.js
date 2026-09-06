'use strict';

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

module.exports = {
    formatRunnerStatusContent,
    readCodeBlockLines,
    clampCodeBlockContent,
    MAX_DISCORD_MESSAGE_LENGTH
};
