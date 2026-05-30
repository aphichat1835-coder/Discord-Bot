/*
 * Protection Feature Module
 * ระบบป้องกันเซิร์ฟเวอร์ — foundation สำหรับอนาคต
 * ปัจจุบัน: Anti-Raid config, Spam detection config
 * อนาคต: Auto-mod, Nuke detection, Link filter, etc.
 */
const { MessageEmbed }  = require('discord.js');
const config            = require('../config.json');
const sessionManager    = require('../sessionManager');

// ── Default protection config ──
const DEFAULT_CONFIG = {
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
    return saved ? { ...DEFAULT_CONFIG, ...saved } : { ...DEFAULT_CONFIG };
}

// ── บันทึก config ──
async function setProtectionConfig(guildId, patch) {
    const current = await getProtectionConfig(guildId);
    const updated = deepMerge(current, patch);
    await sessionManager.setSetting(`protection_${guildId}`, updated);
    return updated;
}

// ── เช็คว่าควร Action กับ member ไหม (Anti-Raid) ──
function checkAntiRaid(member, spamHistory, protConfig) {
    const v       = protConfig?.antiRaid;
    if (!v?.enabled) return null;

    const recent  = (spamHistory || []).filter(t => Date.now() - t < v.spamWindowMs);
    if (recent.length < v.spamThreshold) return null;

    // ตรวจบัญชีใหม่
    if (v.blockNewAccounts) {
        const snowflake = BigInt(member.user.id);
        const ageDays   = Math.floor((Date.now() - Number((snowflake >> 22n) + 1420070400000n)) / 86400000);
        if (ageDays < v.newAccountDays) {
            return { action: 'ban', reason: `Anti-Raid: บัญชีใหม่ spam @everyone (${ageDays} วัน)` };
        }
    }

    return {
        action:  'timeout',
        minutes: v.timeoutMinutes,
        reason:  `Anti-Raid: spam @everyone ${recent.length} ครั้ง/${Math.round(v.spamWindowMs/1000)}s`
    };
}

// ── สร้าง embed แจ้งเตือน protection ──
function buildProtectionAlert(type, data) {
    const colors  = { raid: config.system.themeColors.error, spam: config.system.themeColors.warning };
    const titles  = { raid: `${config.emojis.antiraid} Anti-Raid Triggered`, spam: '⚡ Anti-Spam Triggered' };

    return new MessageEmbed()
        .setColor(colors[type] || config.system.themeColors.error)
        .setTitle(titles[type] || '🚨 Protection Alert')
        .setDescription(Object.entries(data).map(([k,v]) => `**${k}:** ${v}`).join('\n'))
        .setTimestamp();
}

// ── Deep merge helper ──
function deepMerge(target, source) {
    const out = { ...target };
    for (const key of Object.keys(source)) {
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
    buildProtectionAlert,
    DEFAULT_CONFIG
};
