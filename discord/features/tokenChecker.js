'use strict';

const { MessageEmbed } = require('../core/discordCompat');
const { buildUserHeaders } = require('../quest/core/clientProfile');
const tokenCoordinator = require('../core/tokenCoordinator');
const config = require('../config.json');

const THEME_COLORS = Object.freeze({
    BOOST: '#EB459E',
    NITRO: '#5865F2',
    NORMAL: '#57F287',
    BOT: '#57F287',
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
    const defaultIndex = (BigInt(user.id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
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

async function fetchDiscordBot(token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        return await fetch(DISCORD_USER_ME_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bot ${token}`,
                'User-Agent': 'DiscordBot (https://github.com/discordjs/discord.js, 14.16.3)',
                Accept: 'application/json'
            },
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

function sanitizeTokenInput(token) {
    let cleanToken = (token || '').trim();
    const isQuoted = (cleanToken.startsWith('"') && cleanToken.endsWith('"')) ||
        (cleanToken.startsWith("'") && cleanToken.endsWith("'"));
    if (isQuoted) {
        cleanToken = cleanToken.slice(1, -1).trim();
    }
    return cleanToken;
}

function classifyUserResponseError(status, cleanToken) {
    if (status === 401) {
        return {
            valid: false,
            token: cleanToken,
            maskedToken: maskToken(cleanToken),
            errorType: 'INVALID',
            errorMessage: 'Token ไม่ถูกต้อง หรือหมดอายุแล้ว',
            category: 'invalid'
        };
    }
    if (status === 403) {
        return {
            valid: false,
            token: cleanToken,
            maskedToken: maskToken(cleanToken),
            errorType: 'LOCKED',
            errorMessage: 'บัญชีถูกระงับ หรือติดด่านยืนยันความปลอดภัย',
            category: 'invalid'
        };
    }
    return {
        valid: false,
        token: cleanToken,
        maskedToken: maskToken(cleanToken),
        errorType: `HTTP_${status}`,
        errorMessage: `Discord API ส่งกลับสถานะ ${status}`,
        category: 'invalid'
    };
}

function resolveTokenCategory(premiumType, hasNitro) {
    if (premiumType === 2) return 'boost';
    if (hasNitro) return 'nitro';
    return 'normal';
}

function buildValidTokenProfile(user, cleanToken, nitroData) {
    const premiumType = Number(user.premium_type || 0);
    const hasNitro = premiumType > 0;
    const nitroPlan = resolveNitroPlan(premiumType);
    const category = resolveTokenCategory(premiumType, hasNitro);

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
        expireDays: nitroData.expireDays,
        expireDate: nitroData.expireDate,
        createdAt: getAccountCreatedAt(user.id),
        category
    };
}

function buildValidBotProfile(user, cleanToken) {
    return {
        valid: true,
        isBot: true,
        tokenType: 'bot',
        token: cleanToken,
        maskedToken: maskToken(cleanToken),
        id: String(user.id),
        username: String(user.username || 'Bot'),
        globalName: user.global_name ? String(user.global_name) : null,
        avatarUrl: resolveAvatarUrl(user),
        email: null,
        emailVerified: false,
        phone: null,
        phoneVerified: false,
        mfaEnabled: Boolean(user.mfa_enabled),
        premiumType: 0,
        hasNitro: false,
        nitroPlan: 'ไม่มี Nitro (Bot Account)',
        hasBoost: false,
        expireDays: 0,
        expireDate: null,
        createdAt: getAccountCreatedAt(user.id),
        category: 'bot'
    };
}

async function checkSingleToken(token, options = {}) {
    const cleanToken = sanitizeTokenInput(token);

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

    // Check in-memory profile cache unless forceRefresh is requested
    if (!options?.forceRefresh) {
        const cached = tokenCoordinator.getCachedTokenProfile(cleanToken);
        if (cached) {
            return cached;
        }
    }

    try {
        const profile = await tokenCoordinator.executeWithToken(cleanToken, 'tokenChecker', async () => {
            let isBot = false;
            let userRes = await fetchDiscordUser(cleanToken);

            if (!userRes.ok && userRes.status === 401) {
                // Dual check: test if this is a Bot Token
                try {
                    const botRes = await fetchDiscordBot(cleanToken);
                    if (botRes.ok) {
                        userRes = botRes;
                        isBot = true;
                    }
                } catch {
                    // Fall back to original 401 response
                }
            }

            if (!userRes.ok) {
                if (userRes.status === 401) {
                    tokenCoordinator.quarantineToken(cleanToken, 'Token Invalid / Expired (HTTP 401)');
                }
                return classifyUserResponseError(userRes.status, cleanToken);
            }

            const user = await userRes.json();
            if (user.bot || isBot) {
                tokenCoordinator.releaseQuarantine(cleanToken);
                const botProfile = buildValidBotProfile(user, cleanToken);
                tokenCoordinator.cacheTokenProfile(cleanToken, botProfile);
                return botProfile;
            }

            const hasNitro = Number(user.premium_type || 0) > 0;
            const nitroData = hasNitro
                ? await fetchNitroSubscription(cleanToken)
                : { expireDays: 0, expireDate: null };

            const validProfile = buildValidTokenProfile(user, cleanToken, nitroData);
            tokenCoordinator.cacheTokenProfile(cleanToken, validProfile);
            return validProfile;
        }, {
            priority: options?.priority || 'NORMAL',
            bypassQuarantine: Boolean(options?.forceRefresh)
        });

        return profile;
    } catch (err) {
        if (err?.code === 'TOKEN_QUARANTINED') {
            return {
                valid: false,
                token: cleanToken,
                maskedToken: maskToken(cleanToken),
                errorType: 'QUARANTINED',
                errorMessage: `Token ติดสถานะ Quarantine (${err?.quarantine?.reason || 'Token Invalid'})`,
                category: 'invalid'
            };
        }
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

async function checkBatchTokens(tokens = [], optionsOrDelay = {}) {
    const list = Array.isArray(tokens) ? tokens : [];
    const results = [];
    const groups = {
        boost: [],
        nitro: [],
        normal: [],
        bot: [],
        invalid: []
    };

    let batchSize = 5;
    let delayMs = 150;
    let onProgress = null;

    if (typeof optionsOrDelay === 'number') {
        delayMs = Math.min(optionsOrDelay, 200);
    } else if (typeof optionsOrDelay === 'object' && optionsOrDelay !== null) {
        if (Number.isFinite(optionsOrDelay.batchSize) && optionsOrDelay.batchSize > 0) {
            batchSize = Math.min(10, Math.max(1, Math.floor(optionsOrDelay.batchSize)));
        }
        if (Number.isFinite(optionsOrDelay.delayMs) && optionsOrDelay.delayMs >= 0) {
            delayMs = optionsOrDelay.delayMs;
        }
        if (typeof optionsOrDelay.onProgress === 'function') {
            onProgress = optionsOrDelay.onProgress;
        }
    }

    // Process tokens in parallel batches of size 5 (or configured batchSize)
    for (let i = 0; i < list.length; i += batchSize) {
        const chunk = list.slice(i, i + batchSize);
        const chunkPromises = chunk.map(token => checkSingleToken(token, { priority: 'BACKGROUND' }));
        const chunkResults = await Promise.all(chunkPromises);

        for (const res of chunkResults) {
            results.push(res);
            if (groups[res.category]) {
                groups[res.category].push(res);
            }
        }

        if (onProgress) {
            try {
                await onProgress(results.length, list.length);
            } catch {
                // Ignore progress callback errors
            }
        }

        // Inter-batch smooth delay
        if (i + batchSize < list.length && delayMs > 0) {
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
            bot: groups.bot.length,
            invalid: groups.invalid.length
        }
    };
}

function resolveInvalidTokenErrorMessage(result) {
    if (!result) return 'Token ใช้งานไม่ได้';
    if (result.errorType === 'EMPTY') return 'ไม่พบข้อมูล Token';
    if (result.errorType === 'INVALID') return 'Token ไม่ถูกต้อง หรือหมดอายุแล้ว';
    if (result.errorType === 'LOCKED') return 'บัญชีถูกระงับ หรือติดด่านยืนยันความปลอดภัย';
    if (result.errorType === 'QUARANTINED') return 'Token ติดสถานะกักกัน ไม่สามารถใช้งานได้';
    if (result.errorType === 'NETWORK_ERROR') return 'การเชื่อมต่อขัดข้องหรือหมดเวลา';
    if (typeof result.errorType === 'string' && result.errorType.startsWith('HTTP_')) {
        return 'ตรวจสอบ Token ไม่สำเร็จ';
    }
    return result.errorMessage || 'Token ใช้งานไม่ได้';
}

function buildSingleTokenEmbed(result) {
    const errorEmoji = config.emojis?.red_card || config.emojis?.error || '❌';
    const successEmoji = config.emojis?.success || '✅';
    const searchEmoji = config.emojis?.search || '🔍';
    const boostEmoji = config.emojis?.boost || '🚀';
    const lockEmoji = config.emojis?.lock || '🔒';
    const keyEmoji = config.emojis?.key || '🔑';
    const userEmoji = config.emojis?.user || '👤';

    if (!result.valid) {
        return new MessageEmbed()
            .setColor(THEME_COLORS.INVALID)
            .setTitle(`${errorEmoji} ผลการตรวจสอบ Discord Token: ใช้งานไม่ได้`)
            .setDescription([
                `**สถานะ:** ${errorEmoji} \`${resolveInvalidTokenErrorMessage(result)}\``,
                `**${keyEmoji} Token:** \`${result.maskedToken}\``
            ].join('\n'))
            .setTimestamp();
    }

    if (result.isBot || result.category === 'bot') {
        const nameDisplay = result.globalName
            ? `${result.username} (${result.globalName})`
            : result.username;
        const createdDisplay = result.createdAt
            ? `${formatDateBangkok(result.createdAt)} (${getAccountAgeString(result.createdAt)})`
            : '-';

        const embed = new MessageEmbed()
            .setColor(THEME_COLORS.BOT || '#57F287')
            .setTitle(`${searchEmoji} ข้อมูลบัญชี Discord (Bot)`)
            .setDescription([
                `**สถานะ:** ${successEmoji} \`Token บอทถูกต้อง (Valid Bot Token)\``,
                `**ชื่อบอท:** \`${nameDisplay}\` \`[BOT]\``,
                `**ID บอท:** \`${result.id}\``,
                `**สร้างเมื่อ:** ${createdDisplay}`,
                `**${keyEmoji} Token:** \`${result.maskedToken}\``
            ].join('\n'))
            .setTimestamp();

        if (result.avatarUrl) {
            embed.setThumbnail(result.avatarUrl);
        }
        return embed;
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

    let nitroDetail = 'ไม่มี Nitro';
    if (result.hasNitro) {
        const expireInfo = result.expireDate
            ? `หมดอายุวันที่ ${formatDateBangkok(result.expireDate)} (เหลืออีก **${result.expireDays}** วัน)`
            : `เหลืออีก **${result.expireDays}** วัน`;
        nitroDetail = `**ประเภท:** \`${result.nitroPlan}\`\n**วันหมดอายุ:** ${expireInfo}`;
    }

    const boostDetail = result.hasBoost
        ? `${boostEmoji} มีสิทธิ์ Server Boost (พร้อมใช้งาน 2 บูสต์)`
        : `${errorEmoji} ไม่มีสิทธิ์ Server Boost`;

    const securityLines = [
        `• ยืนยันอีเมล: ${result.emailVerified ? `${successEmoji} ยืนยันแล้ว` : `${errorEmoji} ยังไม่ยืนยัน`}`,
        `• ผูกเบอร์โทรศัพท์: ${result.phoneVerified ? `${successEmoji} ผูกแล้ว` : `${errorEmoji} ยังไม่ผูก`}`,
        `• ระบบ 2FA: ${result.mfaEnabled ? `${lockEmoji} เปิดใช้งานแล้ว` : `${errorEmoji} ปิดอยู่`}`
    ].join('\n');

    return new MessageEmbed()
        .setColor(color)
        .setTitle(`${searchEmoji} ข้อมูลบัญชี Discord`)
        .setThumbnail(result.avatarUrl)
        .addFields(
            {
                name: `${userEmoji} ข้อมูลบัญชี`,
                value: `• **ชื่อผู้ใช้:** ${nameDisplay}\n• **ไอดีผู้ใช้:** \`${result.id}\`\n• **สร้างเมื่อ:** ${createdDisplay}`,
                inline: false
            },
            {
                name: 'Nitro',
                value: nitroDetail,
                inline: false
            },
            {
                name: `${boostEmoji} Server Boost`,
                value: boostDetail,
                inline: false
            },
            {
                name: `${lockEmoji} ความปลอดภัย`,
                value: securityLines,
                inline: false
            },
            {
                name: `${keyEmoji} Token`,
                value: `\`${result.maskedToken}\``,
                inline: false
            }
        )
        .setTimestamp();
}

function resolveBatchItemPlanTag(item) {
    if (item.isBot || item.category === 'bot') return '🤖 Bot';
    if (item.hasBoost) return `${config.emojis?.boost || '🚀'} Boost`;
    if (item.hasNitro) return '💎 Nitro';
    return `${config.emojis?.status_online || '🟢'} ปกติ`;
}

function formatBatchItemLine(item, index) {
    const errorEmoji = config.emojis?.red_card || config.emojis?.error || '❌';
    if (!item.valid) {
        return `${index}. ${errorEmoji} \`${item.maskedToken}\` — ${resolveInvalidTokenErrorMessage(item)}`;
    }
    const planTag = resolveBatchItemPlanTag(item);
    const expireNote = item.hasNitro ? ` · เหลือ ${item.expireDays} วัน` : '';
    return `${index}. ${planTag} **${item.username}** (\`${item.id}\`)${expireNote}`;
}

function buildBatchSummaryEmbed(batchData) {
    const { summary, results } = batchData;
    const successEmoji = config.emojis?.check_alt || config.emojis?.success || '✅';
    const boostEmoji = config.emojis?.boost || '🚀';
    const errorEmoji = config.emojis?.red_card || config.emojis?.error || '❌';

    let color = THEME_COLORS.NORMAL;
    if (summary.boost > 0) {
        color = THEME_COLORS.BOOST;
    } else if (summary.nitro > 0) {
        color = THEME_COLORS.NITRO;
    } else if (summary.valid === 0) {
        color = THEME_COLORS.INVALID;
    }

    const summaryText = [
        `**สรุปผลการตรวจสอบทั้งหมด:** \`${summary.total}\` Token`,
        `• ${boostEmoji} **Nitro Boost:** \`${summary.boost}\``,
        `• 💎 **Nitro (ไม่มี Boost):** \`${summary.nitro}\``,
        `• ${config.emojis?.status_online || '🟢'} **Token ปกติ:** \`${summary.normal}\``,
        summary.bot > 0 ? `• 🤖 **Token บอท:** \`${summary.bot}\`` : null,
        `• ${errorEmoji} **Token ใช้งานไม่ได้:** \`${summary.invalid}\``
    ].filter(Boolean).join('\n');

    // Show up to 20 items in embed (maximum batch limit)
    const previewList = results.slice(0, 20).map((item, idx) => formatBatchItemLine(item, idx + 1));
    if (results.length > 20) {
        previewList.push(`... และอีก ${results.length - 20} Token`);
    }

    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(`${successEmoji} ตรวจสอบเสร็จแล้ว`)
        .setDescription(`${summaryText}\n\n**รายการ Token:**\n${previewList.join('\n')}`)
        .setTimestamp();

    return embed;
}

module.exports = {
    THEME_COLORS,
    maskToken,
    getAccountCreatedAt,
    formatDateBangkok,
    getAccountAgeString,
    resolveNitroPlan,
    resolveAvatarUrl,
    resolveInvalidTokenErrorMessage,
    checkSingleToken,
    checkBatchTokens,
    buildSingleTokenEmbed,
    buildBatchSummaryEmbed,
    buildValidBotProfile,
    fetchDiscordBot
};
