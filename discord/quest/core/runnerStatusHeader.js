'use strict';
 
const { MessageEmbed } = require('../../core/discordCompat');
const dmService = require('../../dm');
const { COLORS, markdownText, code } = dmService.design;
const { formatScheduleTime } = require('./runnerSchedule');

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

function extractLogBlock(activityLines, maxChars = 950) {
    if (!Array.isArray(activityLines) || activityLines.length === 0) {
        return '```txt\n(กำลังเริ่มต้นกระบวนการ...)\n```';
    }
    const recent = [...activityLines];
    let logBody = recent.join('\n');
    while (logBody.length > maxChars && recent.length > 1) {
        recent.shift();
        logBody = recent.join('\n');
    }
    if (logBody.length > maxChars) {
        logBody = logBody.slice(logBody.length - maxChars);
    }
    return '```txt\n' + logBody.replaceAll('```', '`ˋ`') + '\n```';
}

function resolveRunnerEmbedTone({ isStopped, isStandby, isAllCompleted }) {
    if (isStopped) return 'danger';
    if (isStandby) return 'info';
    if (isAllCompleted) return 'success';
    return 'action';
}

function resolveRunnerEmbedTitle({ isDaily, isStopped, isStandby, isAllCompleted }) {
    if (isStopped) return '🛑 สั่งหยุดการทำงานของ Quest แล้ว';
    if (isStandby) return '💤 AUTO DAILY กำลังสแตนด์บาย';
    if (isAllCompleted) return '🎉 ทำ Quest อัตโนมัติเสร็จสิ้นแล้ว';
    return isDaily ? '🔄 AUTO DAILY กำลังดำเนินการ...' : '🔄 กำลังทำ Discord Quest...';
}

function resolveRunnerEmbedDescription({ isDaily, isStopped, isStandby, isAllCompleted }) {
    if (isStopped) {
        return 'ระบบได้รับการสั่งหยุดการทำงาน หรือยุติกระบวนการทำเควสต์สำหรับบัญชีนี้แล้ว';
    }
    if (isStandby) {
        return 'ระบบตรวจและทำเควสต์ประจำรอบเรียบร้อยแล้ว กำลังสแตนด์บายรอเวลาตรวจรอบถัดไป';
    }
    if (isAllCompleted) {
        return 'บอทได้เข้าไปทำ Quest ให้บัญชีของคุณสำเร็จเรียบร้อยครบถ้วนแล้ว';
    }
    return isDaily
        ? 'ระบบ Auto Daily กำลังตรวจสอบและดำเนินการทำ Quest ประจำรอบในเบื้องหลัง'
        : 'บอทกำลังดำเนินการตรวจสอบและทำ Quest อัตโนมัติในเบื้องหลัง';
}

function resolveRunnerProgressFieldValue({ isDaily, isStandby, state }) {
    if (isDaily) {
        if (isStandby) {
            const nextTimeStr = state.nextCheckAt ? formatScheduleTime(state.nextCheckAt) : 'ตามรอบเวลา';
            return `ตรวจพบ: **${state.latestQuestCount ?? 0}** เควสต์\n⏰ รอบต่อไป: **${nextTimeStr}**`;
        }
        return `พร้อมทำ: **${state.latestQuestCount ?? 'กำลังตรวจสอบ...'}** เควสต์\nสถานะ: **กำลังตรวจสอบ/ทำเควสต์**`;
    }
    const total = state.totalQuestCount ?? 'กำลังตรวจสอบ...';
    const done = state.completedQuestCount ?? 0;
    return `เควสต์ทั้งหมด: **${total}**\nทำสำเร็จแล้ว: **${done}** เควสต์`;
}

function buildRunnerLiveEmbed(state = {}, activityLines = []) {
    const isDaily = state.mode === 'scheduled' || Boolean(state.modeLine);
    const isStopped = state.status === 'stopped'
        || (state.status !== 'running' && activityLines.some((l) => typeof l === 'string' && l.includes('RUNNER STOPPED')));
    const isStandby = isDaily && !isStopped && (state.status === 'standby'
        || (state.status !== 'running' && activityLines.some((l) => typeof l === 'string' && (l.includes('AUTO DAILY ACTIVE') || l.includes('NEXT CHECK')))));
    const isAllCompleted = !isDaily && !isStopped && !isStandby
        && typeof state.totalQuestCount === 'number' && state.totalQuestCount > 0
        && (state.completedQuestCount ?? 0) >= state.totalQuestCount;

    const statusContext = { isDaily, isStopped, isStandby, isAllCompleted };
    const tone = resolveRunnerEmbedTone(statusContext);
    const title = resolveRunnerEmbedTitle(statusContext);
    const description = resolveRunnerEmbedDescription(statusContext);

    let rawUsername = state.username;
    if (!rawUsername && state.loginLine) {
        rawUsername = state.loginLine.replace(/^✅ (?:LOGIN|ACCOUNT) : /, '').trim();
    }
    const username = rawUsername || 'ไม่ทราบชื่อ';

    const accountPart = state.accountId ? `\n${code(state.accountId)}` : '';
    const userFieldVal = `**${markdownText(username)}**${accountPart}`;
    const modeFieldVal = isDaily ? '🤖 Auto Daily (รายวัน)' : '🚀 One-shot (รอบเดียว)';
    const progressFieldVal = resolveRunnerProgressFieldValue({ isDaily, isStandby, state });
    const logFieldVal = extractLogBlock(activityLines);

    const embed = new MessageEmbed()
        .setColor(COLORS[tone] || COLORS.info)
        .setTitle(title)
        .setDescription(description)
        .addFields(
            { name: '🎮 บัญชี Discord', value: userFieldVal, inline: true },
            { name: '⚙️ โหมดการทำงาน', value: modeFieldVal, inline: true },
            { name: '📊 ความคืบหน้า', value: progressFieldVal, inline: true },
            { name: '📋 บันทึกการทำงานล่าสุด (Terminal Log)', value: logFieldVal, inline: false }
        )
        .setTimestamp(Number(state.timestamp || Date.now()))
        .setFooter({ text: 'Phomueangtai • ระบบทำ Discord Quest อัตโนมัติ' });

    if (state.avatarUrl) {
        embed.setThumbnail(state.avatarUrl);
    }

    return embed;
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
    formatRunnerStatusContent,
    formatRunnerStatusEmbed,
    buildRunnerLiveEmbed,
    readCodeBlockLines,
    clampCodeBlockContent,
    MAX_DISCORD_MESSAGE_LENGTH
};
