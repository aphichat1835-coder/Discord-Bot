'use strict';

const dmService = require('../../dm');
const { buildDmEmbed, profileFromUser, safeText, markdownText, code } = dmService.design;
const { withTimeoutValue } = require('../../core/timers');

const FETCH_RECIPIENT_TIMEOUT_MS = 3000;

/**
 * Safely resolves the DM channel for a user using client and timeout guard.
 */
async function resolveUserDMChannel(client, userId, timeoutMs = FETCH_RECIPIENT_TIMEOUT_MS) {
    if (!client?.users || !userId) return null;
    try {
        const user = client.users.cache?.get?.(userId)
            || await withTimeoutValue(client.users.fetch(userId).catch(() => null), timeoutMs, null);
        if (!user) return null;

        const dm = user.dmChannel
            || await withTimeoutValue(user.createDM().catch(() => null), timeoutMs, null);
        return dm?.isTextBased?.() ? dm : null;
    } catch {
        return null;
    }
}

/**
 * Determines if a Discord API error is a permanent DM delivery failure (e.g. 50007, 10013).
 */
function isPermanentDmError(error) {
    return dmService.isPermanent(error);
}

/**
 * Determines tone for quest outcome.
 */
function questSummaryTone({ totalQuests = 0, completedQuests = 0, issues = [] } = {}) {
    if (issues.length > 0 && completedQuests === 0) return 'danger';
    if (issues.length > 0 || (totalQuests > 0 && completedQuests < totalQuests)) return 'warning';
    if (completedQuests > 0 && completedQuests === totalQuests) return 'success';
    return 'info';
}

/**
 * Builds a Phomueangtai-styled DM Embed for quest results.
 */
function buildQuestSummaryEmbed({
    mode = 'oneshot',
    username = 'บัญชีไม่ทราบชื่อ',
    accountId = 'ไม่ทราบ',
    totalQuests = 0,
    completedQuests = 0,
    issues = [],
    jobKey = '',
    profile = null,
    timestamp = Date.now()
} = {}) {
    const isDaily = mode === 'scheduled';
    const tone = questSummaryTone({ totalQuests, completedQuests, issues });

    let title;
    let summary;
    if (tone === 'success') {
        title = '🎉 ทำ Quest อัตโนมัติเสร็จสิ้นแล้ว';
        summary = isDaily
            ? 'ระบบ Auto Daily ได้ดำเนินการตรวจสอบและทำ Quest ประจำรอบให้บัญชีของคุณเสร็จสิ้นทั้งหมดแล้ว'
            : 'ระบบ One-shot ได้เข้าไปทำ Quest ให้บัญชีของคุณสำเร็จเรียบร้อยครบถ้วนแล้ว';
    } else if (tone === 'warning') {
        title = '⚠️ ผลการทำ Quest (สำเร็จบางส่วน)';
        summary = 'ระบบได้ดำเนินการทำ Quest บางส่วนสำเร็จ แต่พบข้อผิดพลาดในบางรายการ กรุณาตรวจสอบรายละเอียด';
    } else if (tone === 'danger') {
        title = '❌ ไม่สามารถทำ Quest ได้สำเร็จ';
        summary = 'ระบบไม่สามารถดำเนินการทำ Quest ให้สำเร็จได้ กรุณาตรวจสอบ Token และสิทธิ์ของบัญชี';
    } else {
        title = 'ℹ️ ไม่พบ Quest ที่ต้องดำเนินการ';
        summary = isDaily
            ? 'ระบบ Auto Daily ได้ตรวจสอบบัญชีแล้ว แต่ไม่พบ Quest ใหม่ที่สามารถทำได้ในรอบนี้'
            : 'ไม่พบ Quest ที่สามารถทำได้ในบัญชีนี้ในขณะนี้';
    }

    const fields = [
        {
            name: '🎮 บัญชี Discord',
            value: `${markdownText(username)}\n${code(accountId)}`,
            inline: true
        },
        {
            name: '⚙️ โหมดการทำงาน',
            value: isDaily ? '🤖 Auto Daily (รายวัน)' : '🚀 One-shot (รอบเดียว)',
            inline: true
        },
        {
            name: '📊 สรุปจำนวน Quest',
            value: `ตรวจพบ: **${totalQuests}** เควสต์\nทำสำเร็จ: **${completedQuests}** เควสต์`,
            inline: true
        }
    ];

    if (issues.length > 0) {
        const issueLines = issues.slice(0, 5).map((iss) => `• ${markdownText(iss.name)}: ${markdownText(iss.reason)}`).join('\n');
        fields.push({
            name: '⚠️ รายการที่พบปัญหา',
            value: safeText(issueLines, 'มีข้อผิดพลาดบางรายการ', 1024)
        });
    }

    const nextAction = isDaily
        ? 'ระบบจะตรวจสอบและทำเควสต์ใหม่ให้อัตโนมัติตามรอบเวลา 00:00 / 08:00 / 16:00 น. หรือสั่งหยุดได้ด้วยปุ่ม STOP'
        : 'สามารถเปิดแผงควบคุม `/quest panel` เพื่อเริ่ม One-shot รอบใหม่หรือเปิดใช้งาน Auto Daily ได้ตลอดเวลา';

    return buildDmEmbed({
        tone,
        title,
        summary,
        profile: profile || profileFromUser(null, {
            id: accountId,
            username,
            displayName: username
        }),
        fields,
        nextAction,
        referenceId: jobKey ? safeText(jobKey.slice(-16), 'quest', 32) : 'quest',
        timestamp,
        footer: 'Phomueangtai • ระบบทำ Discord Quest อัตโนมัติ'
    });
}

/**
 * Builds an embed for fatal authentication failure.
 */
function buildQuestAuthFailureEmbed({
    username = 'บัญชีไม่ทราบชื่อ',
    accountId = 'ไม่ทราบ',
    jobKey = '',
    profile = null,
    timestamp = Date.now()
} = {}) {
    return buildDmEmbed({
        tone: 'danger',
        title: '🚫 Token บัญชี Quest ใช้งานไม่ได้',
        summary: 'Discord ปฏิเสธการเข้าสู่ระบบ Token ของบัญชีนี้อาจหมดอายุ ถูกรีเซ็ตรหัสผ่าน หรือไม่ถูกต้อง',
        profile: profile || profileFromUser(null, {
            id: accountId,
            username,
            displayName: username
        }),
        fields: [
            {
                name: '🎮 บัญชีที่พบปัญหา',
                value: `${markdownText(username)}\n${code(accountId)}`,
                inline: true
            },
            {
                name: '🔒 สาเหตุ',
                value: 'Authentication Token Invalid หรือ Expired',
                inline: true
            }
        ],
        nextAction: 'กรุณารับ Token ใหม่ของบัญชีนี้ แล้วใช้คำสั่ง `/quest panel` เพื่อเปิดใช้งานใหม่อีกครั้ง',
        referenceId: jobKey ? safeText(jobKey.slice(-16), 'quest', 32) : 'quest',
        timestamp,
        footer: 'Phomueangtai • ระบบทำ Discord Quest อัตโนมัติ'
    });
}

/**
 * Sends a quest summary DM via the central dmService outbox.
 */
async function sendQuestSummaryDM({
    ownerId,
    accountId,
    username,
    mode = 'oneshot',
    totalQuests = 0,
    completedQuests = 0,
    issues = [],
    jobKey = ''
}) {
    if (!ownerId) return { status: 'skipped', reason: 'owner_missing' };

    try {
        const profile = await dmService.resolveProfile(ownerId, {
            id: ownerId,
            username,
            displayName: username
        });

        const embed = buildQuestSummaryEmbed({
            mode,
            username,
            accountId,
            totalQuests,
            completedQuests,
            issues,
            jobKey,
            profile,
            timestamp: Date.now()
        });

        const tone = questSummaryTone({ totalQuests, completedQuests, issues });
        const priority = tone === 'danger' ? 'high' : 'normal';
        const eventKey = `quest:summary:${ownerId}:${accountId || 'acc'}:${Date.now()}`;

        return await dmService.send({
            eventKey,
            recipientId: ownerId,
            category: 'quest',
            priority,
            payload: { embeds: [embed] }
        });
    } catch (err) {
        console.warn(`[Quest DM] Failed to send summary DM: ${err.message}`);
        return { status: 'failed', reason: err.message };
    }
}

/**
 * Sends an auth failure DM via the central dmService outbox.
 */
async function sendQuestAuthFailureDM({
    ownerId,
    accountId,
    username,
    jobKey = ''
}) {
    if (!ownerId) return { status: 'skipped', reason: 'owner_missing' };

    try {
        const profile = await dmService.resolveProfile(ownerId, {
            id: ownerId,
            username,
            displayName: username
        });

        const embed = buildQuestAuthFailureEmbed({
            username,
            accountId,
            jobKey,
            profile,
            timestamp: Date.now()
        });

        const eventKey = `quest:auth_failed:${ownerId}:${accountId || 'unknown'}:${Date.now()}`;

        return await dmService.send({
            eventKey,
            recipientId: ownerId,
            category: 'quest',
            priority: 'high',
            payload: { embeds: [embed] }
        });
    } catch (err) {
        console.warn(`[Quest DM] Failed to send auth failure DM: ${err.message}`);
        return { status: 'failed', reason: err.message };
    }
}

module.exports = {
    resolveUserDMChannel,
    isPermanentDmError,
    questSummaryTone,
    buildQuestSummaryEmbed,
    buildQuestAuthFailureEmbed,
    sendQuestSummaryDM,
    sendQuestAuthFailureDM
};
