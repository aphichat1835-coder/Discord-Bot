'use strict';

const { AttachmentBuilder, MessageEmbed } = require('../core/discordCompat');
const { buildUserHeaders } = require('../quest/core/clientProfile');

const THEME_COLORS = Object.freeze({
    BOOST: '#EB459E',
    NITRO: '#5865F2',
    NORMAL: '#57F287',
    INVALID: '#ED4245'
});

function maskToken(token) {
    if (!token || typeof token !== 'string') return '******';
    const trimmed = token.trim();
    if (trimmed.length <= 12) return trimmed.slice(0, 2) + '******' + trimmed.slice(-2);
    return trimmed.slice(0, 6) + '...' + trimmed.slice(-4);
}

function getAccountCreatedAt(userId) {
    try {
        const snowflake = BigInt(userId);
        const ms = Number((snowflake >> 22n) + 1420070400000n);
        const date = new Date(ms);
        return Number.isFinite(date.getTime()) ? date : null;
    } catch {
        return null;
    }
}

function formatDateBangkok(date) {
    if (!date || !(date instanceof Date) || !Number.isFinite(date.getTime())) return '-';
    return date.toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function getAccountAgeString(createdAt) {
    if (!createdAt || !(createdAt instanceof Date)) return '-';
    const now = Date.now();
    const diffDays = Math.floor((now - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 30) return `${diffDays} วันที่แล้ว`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths} เดือนที่แล้ว`;
    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears} ปีที่แล้ว`;
}

function resolveNitroPlan(premiumType) {
    if (premiumType === 1) return 'Nitro Classic';
    if (premiumType === 2) return 'Nitro (Server Boost)';
    if (premiumType === 3) return 'Nitro Basic';
    return 'ไม่มี Nitro';
}

function resolveAvatarUrl(user) {
    if (!user?.id) {
        return 'https://cdn.discordapp.com/embed/avatars/0.png';
    }
    if (user.avatar) {
        const isGif = typeof user.avatar === 'string' && user.avatar.startsWith('a_');
        const ext = isGif ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
    }
    try {
        const index = Number(BigInt(user.id) >> 22n) % 6;
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    } catch {
        return 'https://cdn.discordapp.com/embed/avatars/0.png';
    }
}

const DISCORD_USER_ME_URL = 'https://discord.com/api/v9/users/@me';
const DISCORD_BILLING_SUBS_URL = 'https://discord.com/api/v9/users/@me/billing/subscriptions';

async function fetchDiscordUser(token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        return await fetch(DISCORD_USER_ME_URL, {
            method: 'GET',
            headers: buildUserHeaders(token, '/users/@me'),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchDiscordSubscriptions(token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        return await fetch(DISCORD_BILLING_SUBS_URL, {
            method: 'GET',
            headers: buildUserHeaders(token, '/users/@me/billing/subscriptions'),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchNitroSubscription(token) {
    try {
        const res = await fetchDiscordSubscriptions(token);

        if (!res.ok) return { expireDays: 0, expireDate: null };

        const subs = await res.json().catch(() => []);
        if (!Array.isArray(subs) || subs.length === 0) {
            return { expireDays: 0, expireDate: null };
        }

        const nitroSub = subs.find(s => s?.type === 1 && s?.current_period_end);
        if (!nitroSub) return { expireDays: 0, expireDate: null };

        const expireDate = new Date(nitroSub.current_period_end);
        if (!Number.isFinite(expireDate.getTime())) {
            return { expireDays: 0, expireDate: null };
        }

        const diffMs = expireDate.getTime() - Date.now();
        const expireDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
        return { expireDays, expireDate };
    } catch {
        return { expireDays: 0, expireDate: null };
    }
}

async function checkSingleToken(token) {
    let cleanToken = (token || '').trim();
    const isQuoted = (cleanToken.startsWith('"') && cleanToken.endsWith('"')) ||
        (cleanToken.startsWith("'") && cleanToken.endsWith("'"));
    if (isQuoted) {
        cleanToken = cleanToken.slice(1, -1).trim();
    }

    if (!cleanToken) {
        return {
            valid: false,
            token: '',
            maskedToken: '******',
            errorType: 'EMPTY',
            errorMessage: 'ไม่พบข้อมูล Token',
            category: 'invalid'
        };
    }

    try {
        const userRes = await fetchDiscordUser(cleanToken);

        if (userRes.status === 401) {
            return {
                valid: false,
                token: cleanToken,
                maskedToken: maskToken(cleanToken),
                errorType: 'INVALID',
                errorMessage: 'Token ไม่ถูกต้อง หรือหมดอายุแล้ว',
                category: 'invalid'
            };
        }

        if (userRes.status === 403) {
            return {
                valid: false,
                token: cleanToken,
                maskedToken: maskToken(cleanToken),
                errorType: 'LOCKED',
                errorMessage: 'บัญชีถูกระงับ หรือติดด่านยืนยันความปลอดภัย',
                category: 'invalid'
            };
        }

        if (!userRes.ok) {
            return {
                valid: false,
                token: cleanToken,
                maskedToken: maskToken(cleanToken),
                errorType: `HTTP_${userRes.status}`,
                errorMessage: `Discord API ส่งกลับสถานะ ${userRes.status}`,
                category: 'invalid'
            };
        }

        const user = await userRes.json();
        const premiumType = Number(user.premium_type || 0);
        const hasNitro = premiumType > 0;
        const nitroPlan = resolveNitroPlan(premiumType);

        let expireDays = 0;
        let expireDate = null;
        if (hasNitro) {
            const subData = await fetchNitroSubscription(cleanToken);
            expireDays = subData.expireDays;
            expireDate = subData.expireDate;
        }

        let category = 'normal';
        if (premiumType === 2) {
            category = 'boost';
        } else if (hasNitro) {
            category = 'nitro';
        }

        return {
            valid: true,
            token: cleanToken,
            maskedToken: maskToken(cleanToken),
            id: String(user.id),
            username: String(user.username || 'Unknown'),
            globalName: user.global_name ? String(user.global_name) : null,
            avatarUrl: resolveAvatarUrl(user),
            email: user.email ? String(user.email) : null,
            emailVerified: Boolean(user.verified),
            phone: user.phone ? String(user.phone) : null,
            phoneVerified: Boolean(user.phone),
            mfaEnabled: Boolean(user.mfa_enabled),
            premiumType,
            hasNitro,
            nitroPlan,
            hasBoost: premiumType === 2,
            expireDays,
            expireDate,
            createdAt: getAccountCreatedAt(user.id),
            category
        };
    } catch {
        // Network errors, timeouts, or unexpected response formats from Discord API are safely surfaced as an invalid token outcome
        return {
            valid: false,
            token: cleanToken,
            maskedToken: maskToken(cleanToken),
            errorType: 'NETWORK_ERROR',
            errorMessage: 'การเชื่อมต่อไปยัง Discord API ล้มเหลวหรือหมดเวลา',
            category: 'invalid'
        };
    }
}

async function checkBatchTokens(tokens = [], delayMs = 1200) {
    const list = Array.isArray(tokens) ? tokens : [];
    const results = [];
    const groups = {
        boost: [],
        nitro: [],
        normal: [],
        invalid: []
    };

    for (let i = 0; i < list.length; i++) {
        const token = list[i];
        const res = await checkSingleToken(token);
        results.push(res);

        if (groups[res.category]) {
            groups[res.category].push(res);
        }

        // Delay between tokens to avoid Cloudflare/Discord rate limits
        if (i < list.length - 1 && delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return {
        results,
        groups,
        summary: {
            total: results.length,
            valid: results.filter(r => r.valid).length,
            boost: groups.boost.length,
            nitro: groups.nitro.length,
            normal: groups.normal.length,
            invalid: groups.invalid.length
        }
    };
}

function buildSingleTokenEmbed(result) {
    if (!result.valid) {
        return new MessageEmbed()
            .setColor(THEME_COLORS.INVALID)
            .setTitle('❌ ผลการตรวจสอบ Discord Token: ใช้งานไม่ได้')
            .setDescription([
                `**สถานะ:** 🔴 \`${result.errorMessage || 'Invalid Token'}\``,
                `**Token:** \`${result.maskedToken}\``
            ].join('\n'))
            .setFooter({ text: 'Token Checker · ตรวจสอบไม่ผ่าน' })
            .setTimestamp();
    }

    let color = THEME_COLORS.NORMAL;
    if (result.hasBoost) {
        color = THEME_COLORS.BOOST;
    } else if (result.hasNitro) {
        color = THEME_COLORS.NITRO;
    }

    const nameDisplay = result.globalName
        ? `${result.username} (${result.globalName})`
        : result.username;

    const createdDisplay = result.createdAt
        ? `${formatDateBangkok(result.createdAt)} (${getAccountAgeString(result.createdAt)})`
        : '-';

    let nitroDetail = 'ไม่มี Nitro ที่ใช้งานอยู่';
    if (result.hasNitro) {
        const expireInfo = result.expireDate
            ? `หมดอายุวันที่ ${formatDateBangkok(result.expireDate)} (เหลืออีก **${result.expireDays}** วัน)`
            : `เหลืออีก **${result.expireDays}** วัน`;
        nitroDetail = `**ประเภท:** \`${result.nitroPlan}\`\n**วันหมดอายุ:** ${expireInfo}`;
    }

    const boostDetail = result.hasBoost
        ? '🚀 มีสิทธิ์ Server Boost (พร้อมใช้งาน 2 บูสต์)'
        : '❌ ไม่มีสิทธิ์ Server Boost';

    const securityLines = [
        `• ยืนยันอีเมล: ${result.emailVerified ? '✅ สำเร็จ' : '❌ ยังไม่ยืนยัน'}`,
        `• ผูกเบอร์โทรศัพท์: ${result.phoneVerified ? '✅ สำเร็จ' : '❌ ยังไม่ผูก'}`,
        `• ระบบ 2FA: ${result.mfaEnabled ? '🔐 เปิดใช้งานแล้ว' : '❌ ปิดอยู่'}`
    ].join('\n');

    return new MessageEmbed()
        .setColor(color)
        .setTitle('🔍 ข้อมูลบัญชี Discord Token')
        .setThumbnail(result.avatarUrl)
        .addFields(
            {
                name: '👤 ข้อมูลบัญชี',
                value: `• **ชื่อผู้ใช้:** ${nameDisplay}\n• **ไอดีผู้ใช้:** \`${result.id}\`\n• **สร้างเมื่อ:** ${createdDisplay}`,
                inline: false
            },
            {
                name: '💎 สถานะ Nitro',
                value: nitroDetail,
                inline: false
            },
            {
                name: '🚀 สิทธิ์การบูสต์',
                value: boostDetail,
                inline: false
            },
            {
                name: '🛡️ ความปลอดภัยของบัญชี',
                value: securityLines,
                inline: false
            },
            {
                name: '🔑 Token (Masked)',
                value: `\`${result.maskedToken}\``,
                inline: false
            }
        )
        .setFooter({ text: 'Discord Token Checker · ปลอดภัยและแสดงเฉพาะคุณ' })
        .setTimestamp();
}

function resolveBatchItemPlanTag(item) {
    if (item.hasBoost) return '🚀 Boost';
    if (item.hasNitro) return '💎 Nitro';
    return '🟢 Normal';
}

function formatBatchItemLine(item, index) {
    if (!item.valid) {
        return `${index}. 🔴 \`${item.maskedToken}\` — ${item.errorMessage || 'Invalid'}`;
    }
    const planTag = resolveBatchItemPlanTag(item);
    const expireNote = item.hasNitro ? ` · เหลือ ${item.expireDays} วัน` : '';
    return `${index}. ${planTag} **${item.username}** (\`${item.id}\`)${expireNote}`;
}

function buildBatchSummaryEmbed(batchData) {
    const { summary, results } = batchData;

    let color = THEME_COLORS.NORMAL;
    if (summary.boost > 0) {
        color = THEME_COLORS.BOOST;
    } else if (summary.nitro > 0) {
        color = THEME_COLORS.NITRO;
    } else if (summary.valid === 0) {
        color = THEME_COLORS.INVALID;
    }

    const summaryText = [
        `📊 **สรุปผลการตรวจสอบทั้งหมด:** \`${summary.total}\` บัญชี`,
        `• 🚀 **มี Nitro Boost:** \`${summary.boost}\` บัญชี`,
        `• 💎 **มี Nitro (ไม่มี Boost):** \`${summary.nitro}\` บัญชี`,
        `• 🟢 **โทเค่นปกติ (No Nitro):** \`${summary.normal}\` บัญชี`,
        `• 🔴 **โทเค่นใช้งานไม่ได้ (Invalid):** \`${summary.invalid}\` บัญชี`
    ].join('\n');

    // Show up to 15 items in embed
    const previewList = results.slice(0, 15).map((item, idx) => formatBatchItemLine(item, idx + 1));
    if (results.length > 15) {
        previewList.push(`... และอีก ${results.length - 15} บัญชี (ดูรายละเอียดเต็มในไฟล์แนบด้านล่าง)`);
    }

    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle('📊 ผลการตรวจสอบ Discord Tokens แบบกลุ่ม')
        .setDescription(`${summaryText}\n\n**📋 รายการบัญชี:**\n${previewList.join('\n')}`)
        .setFooter({ text: 'Discord Token Checker · แยกไฟล์หมวดหมู่ส่งให้เรียบร้อยแล้ว' })
        .setTimestamp();

    return embed;
}

function createCategoryAttachments(groups) {
    const attachments = [];

    const fileMap = [
        { key: 'boost', fileName: 'tokens_boost.txt' },
        { key: 'nitro', fileName: 'tokens_nitro.txt' },
        { key: 'normal', fileName: 'tokens_normal.txt' },
        { key: 'invalid', fileName: 'tokens_invalid.txt' }
    ];

    for (const { key, fileName } of fileMap) {
        const items = groups[key] || [];
        if (items.length > 0) {
            const content = items.map(item => item.token).join('\n');
            attachments.push(new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: fileName }));
        }
    }

    return attachments;
}

module.exports = {
    THEME_COLORS,
    maskToken,
    getAccountCreatedAt,
    formatDateBangkok,
    getAccountAgeString,
    resolveNitroPlan,
    resolveAvatarUrl,
    checkSingleToken,
    checkBatchTokens,
    buildSingleTokenEmbed,
    buildBatchSummaryEmbed,
    createCategoryAttachments
};
