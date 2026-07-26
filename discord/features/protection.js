/*
 * Protection Feature Module
 * ระบบป้องกันเซิร์ฟเวอร์ — foundation สำหรับอนาคต
 * ปัจจุบัน: Anti-Raid config, Spam detection config
 * อนาคต: Auto-mod, Nuke detection, Link filter, etc.
 */
const { PermissionFlagsBits } = require("discord.js");
const sessionManager    = require('../sessionManager');

// ── Default protection config ──
const DEFAULT_CONFIG = {
    actionMode: 'audit_only',
    antiRaid: {
        enabled:          true,
        spamThreshold:    5,       // ครั้งภายใน windowMs
        spamWindowMs:     60000,   // 1 นาที
        timeoutMinutes:   10,
        blockNewAccounts: false,
        newAccountDays:   7
    },
    antiSpam: {
        enabled:        false,
        maxMessages:    5,
        windowMs:       5000,
        action:         'timeout'  // 'timeout' | 'kick' | 'ban'
    },
    linkFilter: {
        enabled:        false,
        blockInvites:   true,
        allowedDomains: []
    }
};

// ── โหลด config จาก DB ──
async function getProtectionConfig(guildId) {
    const saved = await sessionManager.getSetting(`protection_${guildId}`, null);
    return saved ? deepMerge(DEFAULT_CONFIG, saved) : deepMerge(DEFAULT_CONFIG, {});
}

// ── บันทึก config ──
async function setProtectionConfig(guildId, patch) {
    const current = await getProtectionConfig(guildId);
    const updated = deepMerge(current, patch);
    await sessionManager.setSetting(`protection_${guildId}`, updated);
    return updated;
}

function buildProtectionResult({ action, minutes = null, reason, trigger, severity = 'danger', evidence = [], shouldCreateCase = true, metadata = {} }) {
    return {
        action,
        minutes,
        reason,
        trigger,
        severity,
        evidence,
        shouldCreateCase,
        metadata
    };
}

// ── เช็คว่าควร Action กับ member ไหม (Anti-Raid) ──
function checkAntiRaid(member, spamHistory, protConfig) {
    const v       = protConfig?.antiRaid;
    if (!v?.enabled) return null;

    const recent  = (spamHistory || []).filter(t => Date.now() - t < v.spamWindowMs);
    if (recent.length < v.spamThreshold) return null;

    const evidence = [
        `Mention spam: ${recent.length}/${v.spamThreshold} ครั้ง`,
        `Window: ${Math.round(v.spamWindowMs / 1000)}s`,
        `User: ${member?.user?.tag || member?.id} (${member?.id})`
    ];

    // ตรวจบัญชีใหม่
    if (v.blockNewAccounts) {
        const snowflake = BigInt(member.user.id);
        const ageDays   = Math.floor((Date.now() - Number((snowflake >> 22n) + 1420070400000n)) / 86400000);
        if (ageDays < v.newAccountDays) {
            return buildProtectionResult({
                action: 'ban',
                reason: `Anti-Raid: บัญชีใหม่ spam @everyone (${ageDays} วัน)`,
                trigger: 'Anti-Raid New Account Mention Spam',
                severity: 'critical',
                evidence: [...evidence, `Account age: ${ageDays} days`],
                metadata: { ageDays, windowMs: v.spamWindowMs, count: recent.length }
            });
        }
    }

    return buildProtectionResult({
        action:  'timeout',
        minutes: v.timeoutMinutes,
        reason:  `Anti-Raid: spam @everyone ${recent.length} ครั้ง/${Math.round(v.spamWindowMs/1000)}s`,
        trigger: 'Anti-Raid Mention Spam',
        severity: 'danger',
        evidence,
        metadata: { windowMs: v.spamWindowMs, count: recent.length }
    });
}

// ── เช็ค Anti-Spam (ข้อความธรรมดา ไม่ใช่ @everyone) ──
function checkAntiSpam(member, msgHistory, protConfig) {
    const v = protConfig?.antiSpam;
    if (!v?.enabled) return null;
    const recent = (msgHistory || []).filter(t => Date.now() - t < v.windowMs);
    if (recent.length < v.maxMessages) return null;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;
    return buildProtectionResult({
        action:  v.action || 'timeout',
        minutes: 5,
        reason:  `Anti-Spam: ส่งข้อความ ${recent.length} ครั้ง ใน ${v.windowMs / 1000}s`,
        trigger: 'Anti-Spam Message Flood',
        severity: 'warning',
        evidence: [
            `Messages: ${recent.length}/${v.maxMessages}`,
            `Window: ${Math.round(v.windowMs / 1000)}s`,
            `User: ${member?.user?.tag || member?.id} (${member?.id})`
        ],
        metadata: { windowMs: v.windowMs, count: recent.length }
    });
}

// ── เช็ค Link Filter ──
const INVITE_REGEX = /discord(?:app)?\.(?:com\/invite|gg)\/[a-zA-Z0-9\-]+/i;

function checkLinkFilter(message, protConfig) {
    const v = protConfig?.linkFilter;
    if (!v?.enabled) return null;
    const content = message.content || '';
    if (v.blockInvites && INVITE_REGEX.test(content)) {
        return {
            shouldDelete: true,
            reason: 'Link Filter: Discord invite ถูกบล็อก',
            trigger: 'Link Filter Discord Invite',
            severity: 'warning',
            evidence: [`Channel: ${message.channel?.id}`, `User: ${message.author?.tag || message.author?.id}`]
        };
    }
    const urlMatches = content.match(/https?:\/\/[^\s]+/gi) || [];
    const blocked = urlMatches.filter(url => {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            if (!v.allowedDomains?.length) return false;
            return !v.allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
        } catch { return false; }
    });
    if (blocked.length > 0) {
        return {
            shouldDelete: true,
            reason: 'Link Filter: domain ไม่ได้รับอนุญาต',
            trigger: 'Link Filter Blocked Domain',
            severity: 'warning',
            evidence: blocked.slice(0, 5).map(url => `Blocked URL: ${url}`),
            blocked
        };
    }
    return null;
}

// ── Deep merge helper ──
const BLOCKED_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target, source) {
    const out = { ...target };
    if (!source || typeof source !== 'object') return out;

    for (const key of Object.keys(source)) {
        if (BLOCKED_MERGE_KEYS.has(key)) continue;

        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            out[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            out[key] = source[key];
        }
    }
    return out;
}

module.exports = {
    getProtectionConfig,
    setProtectionConfig,
    checkAntiRaid,
    checkAntiSpam,
    checkLinkFilter,
    buildProtectionResult,
    DEFAULT_CONFIG
};
