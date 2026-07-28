/*
 * Protection Feature Module
 * ระบบป้องกันเซิร์ฟเวอร์ — foundation สำหรับอนาคต
 * ปัจจุบัน: Anti-Raid config, Spam detection config
 * อนาคต: Auto-mod, Nuke detection, Link filter, etc.
 */
const { PermissionFlagsBits } = require("discord.js");
const sessionManager = require("../sessionManager");
const { readFiniteInteger } = require("../core/numbers");

const ANTI_SPAM_ACTIONS = new Set(["timeout", "kick", "ban"]);
const ACTION_MODES = new Set(["audit_only", "enforce"]);
const MAX_ALLOWED_DOMAINS = 200;

const DEFAULT_CONFIG = {
    actionMode: "audit_only",
    antiRaid: {
        enabled: true,
        spamThreshold: 5,
        spamWindowMs: 60000,
        timeoutMinutes: 10,
        blockNewAccounts: false,
        newAccountDays: 7
    },
    antiSpam: {
        enabled: false,
        maxMessages: 5,
        windowMs: 5000,
        action: "timeout"
    },
    linkFilter: {
        enabled: false,
        blockInvites: true,
        allowedDomains: []
    }
};

function booleanValue(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}

function normalizeDomain(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!raw || raw.length > 253 || raw.includes("/") || raw.includes(":")) return null;
    try {
        const parsed = new URL(`https://${raw}`);
        if (parsed.hostname !== raw || !raw.includes(".")) return null;
        return raw;
    } catch {
        return null;
    }
}

function normalizeAllowedDomains(values) {
    if (!Array.isArray(values)) return [];
    const domains = [];
    const seen = new Set();
    for (const value of values.slice(0, MAX_ALLOWED_DOMAINS)) {
        const domain = normalizeDomain(value);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        domains.push(domain);
    }
    return domains;
}

function normalizeProtectionConfig(value = {}) {
    const merged = deepMerge(DEFAULT_CONFIG, value);
    const actionMode = String(merged.actionMode || "").trim().toLowerCase();
    const antiSpamAction = String(merged.antiSpam?.action || "").trim().toLowerCase();
    return {
        actionMode: ACTION_MODES.has(actionMode) ? actionMode : DEFAULT_CONFIG.actionMode,
        antiRaid: {
            enabled: booleanValue(merged.antiRaid?.enabled, DEFAULT_CONFIG.antiRaid.enabled),
            spamThreshold: readFiniteInteger(merged.antiRaid?.spamThreshold, { fallback: 5, min: 2, max: 100 }),
            spamWindowMs: readFiniteInteger(merged.antiRaid?.spamWindowMs, { fallback: 60000, min: 1000, max: 60 * 60 * 1000 }),
            timeoutMinutes: readFiniteInteger(merged.antiRaid?.timeoutMinutes, { fallback: 10, min: 1, max: 28 * 24 * 60 }),
            blockNewAccounts: booleanValue(merged.antiRaid?.blockNewAccounts, false),
            newAccountDays: readFiniteInteger(merged.antiRaid?.newAccountDays, { fallback: 7, min: 1, max: 3650 })
        },
        antiSpam: {
            enabled: booleanValue(merged.antiSpam?.enabled, DEFAULT_CONFIG.antiSpam.enabled),
            maxMessages: readFiniteInteger(merged.antiSpam?.maxMessages, { fallback: 5, min: 2, max: 100 }),
            windowMs: readFiniteInteger(merged.antiSpam?.windowMs, { fallback: 5000, min: 500, max: 60 * 60 * 1000 }),
            action: ANTI_SPAM_ACTIONS.has(antiSpamAction) ? antiSpamAction : DEFAULT_CONFIG.antiSpam.action
        },
        linkFilter: {
            enabled: booleanValue(merged.linkFilter?.enabled, DEFAULT_CONFIG.linkFilter.enabled),
            blockInvites: booleanValue(merged.linkFilter?.blockInvites, DEFAULT_CONFIG.linkFilter.blockInvites),
            allowedDomains: normalizeAllowedDomains(merged.linkFilter?.allowedDomains)
        }
    };
}

async function getProtectionConfig(guildId) {
    const saved = await sessionManager.getSetting(`protection_${guildId}`, null);
    return normalizeProtectionConfig(saved || {});
}

async function setProtectionConfig(guildId, patch) {
    const current = await getProtectionConfig(guildId);
    const updated = normalizeProtectionConfig(deepMerge(current, patch));
    const persisted = await sessionManager.setSetting(`protection_${guildId}`, updated);
    if (persisted !== true) {
        const error = new Error("Protection settings could not be persisted");
        error.code = "PROTECTION_PERSISTENCE_FAILED";
        throw error;
    }
    return updated;
}

function buildProtectionResult({ action, minutes = null, reason, trigger, severity = "danger", evidence = [], shouldCreateCase = true, metadata = {} }) {
    return { action, minutes, reason, trigger, severity, evidence, shouldCreateCase, metadata };
}

function checkAntiRaid(member, spamHistory, protConfig) {
    const v = protConfig?.antiRaid;
    if (!v?.enabled) return null;
    const recent = (spamHistory || []).filter(t => Date.now() - t < v.spamWindowMs);
    if (recent.length < v.spamThreshold) return null;

    const evidence = [
        `Mention spam: ${recent.length}/${v.spamThreshold} ครั้ง`,
        `Window: ${Math.round(v.spamWindowMs / 1000)}s`,
        `User: ${member?.user?.tag || member?.id} (${member?.id})`
    ];

    if (v.blockNewAccounts) {
        const snowflake = BigInt(member.user.id);
        const ageDays = Math.floor((Date.now() - Number((snowflake >> 22n) + 1420070400000n)) / 86400000);
        if (ageDays < v.newAccountDays) {
            return buildProtectionResult({
                action: "ban",
                reason: `Anti-Raid: บัญชีใหม่ spam @everyone (${ageDays} วัน)`,
                trigger: "Anti-Raid New Account Mention Spam",
                severity: "critical",
                evidence: [...evidence, `Account age: ${ageDays} days`],
                metadata: { ageDays, windowMs: v.spamWindowMs, count: recent.length }
            });
        }
    }

    return buildProtectionResult({
        action: "timeout",
        minutes: v.timeoutMinutes,
        reason: `Anti-Raid: spam @everyone ${recent.length} ครั้ง/${Math.round(v.spamWindowMs / 1000)}s`,
        trigger: "Anti-Raid Mention Spam",
        severity: "danger",
        evidence,
        metadata: { windowMs: v.spamWindowMs, count: recent.length }
    });
}

function checkAntiSpam(member, msgHistory, protConfig) {
    const v = protConfig?.antiSpam;
    if (!v?.enabled) return null;
    const recent = (msgHistory || []).filter(t => Date.now() - t < v.windowMs);
    if (recent.length < v.maxMessages) return null;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;
    return buildProtectionResult({
        action: v.action || "timeout",
        minutes: 5,
        reason: `Anti-Spam: ส่งข้อความ ${recent.length} ครั้ง ใน ${v.windowMs / 1000}s`,
        trigger: "Anti-Spam Message Flood",
        severity: "warning",
        evidence: [
            `Messages: ${recent.length}/${v.maxMessages}`,
            `Window: ${Math.round(v.windowMs / 1000)}s`,
            `User: ${member?.user?.tag || member?.id} (${member?.id})`
        ],
        metadata: { windowMs: v.windowMs, count: recent.length }
    });
}

const INVITE_REGEX = /discord(?:app)?\.(?:com\/invite|gg)\/[a-zA-Z0-9-]+/i;

function checkLinkFilter(message, protConfig) {
    const v = protConfig?.linkFilter;
    if (!v?.enabled) return null;
    const content = message.content || "";
    if (v.blockInvites && INVITE_REGEX.test(content)) {
        return {
            shouldDelete: true,
            reason: "Link Filter: Discord invite ถูกบล็อก",
            trigger: "Link Filter Discord Invite",
            severity: "warning",
            evidence: [`Channel: ${message.channel?.id}`, `User: ${message.author?.tag || message.author?.id}`]
        };
    }
    const urlMatches = content.match(/https?:\/\/[^\s]+/gi) || [];
    const blocked = urlMatches.filter(url => {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            if (!v.allowedDomains?.length) return false;
            return !v.allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
        } catch {
            return false;
        }
    });
    if (blocked.length > 0) {
        return {
            shouldDelete: true,
            reason: "Link Filter: domain ไม่ได้รับอนุญาต",
            trigger: "Link Filter Blocked Domain",
            severity: "warning",
            evidence: blocked.slice(0, 5).map(url => `Blocked URL: ${url}`),
            blocked
        };
    }
    return null;
}

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target, source) {
    const out = { ...target };
    if (!source || typeof source !== "object") return out;
    for (const key of Object.keys(source)) {
        if (BLOCKED_MERGE_KEYS.has(key)) continue;
        if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
            out[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            out[key] = source[key];
        }
    }
    return out;
}

module.exports = {
    ACTION_MODES,
    ANTI_SPAM_ACTIONS,
    DEFAULT_CONFIG,
    buildProtectionResult,
    checkAntiRaid,
    checkAntiSpam,
    checkLinkFilter,
    deepMerge,
    getProtectionConfig,
    normalizeAllowedDomains,
    normalizeDomain,
    normalizeProtectionConfig,
    setProtectionConfig
};