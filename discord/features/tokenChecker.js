'use strict';

const { MessageEmbed } = require('../core/discordCompat');
const { buildUserHeaders } = require('../quest/core/clientProfile');
const tokenCoordinator = require('../tokens/tokenCoordinator');
const config = require('../config.json');

const THEME_COLORS = Object.freeze({
    BOOST: '#EB459E',
    NITRO: config.system?.themeColors?.info || '#FFCCCC',
    NORMAL: config.system?.themeColors?.primary || '#CC66FF',
    BOT: config.system?.themeColors?.info || '#FFCCCC',
    INVALID: config.system?.themeColors?.error || '#FF9999'
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

function formatDateBangkokDateOnly(date) {
    if (!date || !(date instanceof Date) || !Number.isFinite(date.getTime())) return '-';
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    return formatter.format(date);
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
const DISCORD_BOT_APP_ME_URL = 'https://discord.com/api/v9/oauth2/applications/@me';
const DISCORD_BOT_GUILDS_URL = 'https://discord.com/api/v9/users/@me/guilds';

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

async function fetchDiscordBotApplication(token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(DISCORD_BOT_APP_ME_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bot ${token}`,
                'User-Agent': 'DiscordBot (https://github.com/discordjs/discord.js, 14.16.3)',
                Accept: 'application/json'
            },
            signal: controller.signal
        });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchDiscordBotGuilds(token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(DISCORD_BOT_GUILDS_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bot ${token}`,
                'User-Agent': 'DiscordBot (https://github.com/discordjs/discord.js, 14.16.3)',
                Accept: 'application/json'
            },
            signal: controller.signal
        });
        if (!res.ok) return null;
        const guilds = await res.json().catch(() => null);
        return Array.isArray(guilds) ? guilds : null;
    } catch {
        return null;
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

function buildValidBotProfile(user, cleanToken, extra = {}) {
    const appData = extra?.appData || null;
    const guilds = extra?.guilds !== undefined ? extra.guilds : null;

    let ownerUsername = 'ไม่ระบุ';
    let ownerId = '-';

    if (appData?.owner) {
        ownerUsername = String(appData.owner.username || 'ไม่ระบุ');
        ownerId = String(appData.owner.id || '-');
    } else if (appData?.team) {
        const teamOwner = Array.isArray(appData.team.members)
            ? appData.team.members.find(m => String(m?.user?.id) === String(appData.team.owner_user_id))
            : null;
        if (teamOwner?.user?.username) {
            ownerUsername = String(teamOwner.user.username);
            ownerId = String(teamOwner.user.id || appData.team.owner_user_id || '-');
        } else {
            ownerUsername = String(appData.team.name || 'Team');
            ownerId = String(appData.team.owner_user_id || appData.team.id || '-');
        }
    }

    const guildCount = Array.isArray(guilds) ? guilds.length : null;
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${user.id}&scope=bot+applications.commands&permissions=8`;

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
        ownerUsername,
        ownerId,
        guildCount,
        inviteUrl,
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
                tokenCoordinator.setTokenType(cleanToken, 'bot');
                let appData = null;
                let guilds = null;
                try {
                    const [appRes, guildsRes] = await Promise.all([
                        fetchDiscordBotApplication(cleanToken),
                        fetchDiscordBotGuilds(cleanToken)
                    ]);
                    appData = appRes;
                    guilds = guildsRes;
                } catch {
                    // Fallback to basic profile if extra probes fail
                }
                const botProfile = buildValidBotProfile(user, cleanToken, { appData, guilds });
                if (guilds !== null) {
                    tokenCoordinator.cacheTokenProfile(cleanToken, botProfile);
                }
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
    } else if (optionsOrDelay && typeof optionsOrDelay === 'object') {
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

    // Process tokens in batches of size 5 (or configured batchSize) using recursive async chaining
    const processBatch = async (startIndex) => {
        if (startIndex >= list.length) return;
        const chunk = list.slice(startIndex, startIndex + batchSize);
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

        if (startIndex + batchSize < list.length && delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        return processBatch(startIndex + batchSize);
    };

    await processBatch(0);

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

function _buildInvalidTokenEmbed(result) {
    const errorEmoji = config.emojis?.red_card || config.emojis?.error || '❌';
    const keyEmoji = config.emojis?.key || '🔑';

    return new MessageEmbed()
        .setColor(THEME_COLORS.INVALID)
        .setTitle(`${errorEmoji} ผลการตรวจสอบ Discord Token: ใช้งานไม่ได้`)
        .setDescription([
            `**สถานะ:** ${errorEmoji} \`${resolveInvalidTokenErrorMessage(result)}\``,
            `**${keyEmoji} Token:** \`${result.maskedToken}\``
        ].join('\n'));
}

function _buildBotTokenEmbed(result) {
    const successEmoji = config.emojis?.success || '✅';
    const searchEmoji = config.emojis?.search || '🔍';
    const keyEmoji = config.emojis?.key || '🔑';

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
        ].join('\n'));

    if (result.avatarUrl) {
        embed.setThumbnail(result.avatarUrl);
    }
    return embed;
}

function _resolveTokenThemeColor(result) {
    if (result.hasBoost) return THEME_COLORS.BOOST;
    if (result.hasNitro) return THEME_COLORS.NITRO;
    return THEME_COLORS.NORMAL;
}

function _buildNitroDetail(result) {
    if (!result.hasNitro) return 'ไม่มี Nitro';
    const expireInfo = result.expireDate
        ? `หมดอายุวันที่ ${formatDateBangkok(result.expireDate)} (เหลืออีก **${result.expireDays}** วัน)`
        : `เหลืออีก **${result.expireDays}** วัน`;
    return `**ประเภท:** \`${result.nitroPlan}\`\n**วันหมดอายุ:** ${expireInfo}`;
}

function _buildSecurityLines(result, successEmoji, errorEmoji, lockEmoji) {
    const emailStatus = result.emailVerified ? `${successEmoji} ยืนยันแล้ว` : `${errorEmoji} ยังไม่ยืนยัน`;
    const phoneStatus = result.phoneVerified ? `${successEmoji} ผูกแล้ว` : `${errorEmoji} ยังไม่ผูก`;
    const mfaStatus = result.mfaEnabled ? `${lockEmoji} เปิดใช้งานแล้ว` : `${errorEmoji} ปิดอยู่`;

    return [
        `• ยืนยันอีเมล: ${emailStatus}`,
        `• ผูกเบอร์โทรศัพท์: ${phoneStatus}`,
        `• ระบบ 2FA: ${mfaStatus}`
    ].join('\n');
}

function _buildUserTokenEmbed(result) {
    const errorEmoji = config.emojis?.red_card || config.emojis?.error || '❌';
    const successEmoji = config.emojis?.success || '✅';
    const searchEmoji = config.emojis?.search || '🔍';
    const boostEmoji = config.emojis?.boost || '🚀';
    const lockEmoji = config.emojis?.lock || '🔒';
    const keyEmoji = config.emojis?.key || '🔑';
    const userEmoji = config.emojis?.user || '👤';

    const color = _resolveTokenThemeColor(result);
    const nameDisplay = result.globalName
        ? `${result.username} (${result.globalName})`
        : result.username;

    const createdDisplay = result.createdAt
        ? `${formatDateBangkok(result.createdAt)} (${getAccountAgeString(result.createdAt)})`
        : '-';

    const nitroDetail = _buildNitroDetail(result);
    const boostDetail = result.hasBoost
        ? `${boostEmoji} มีสิทธิ์ Server Boost (พร้อมใช้งาน 2 บูสต์)`
        : `${errorEmoji} ไม่มีสิทธิ์ Server Boost`;

    const securityLines = _buildSecurityLines(result, successEmoji, errorEmoji, lockEmoji);

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
        );
}

function _normalizeTokenResultsList(results) {
    if (Array.isArray(results)) {
        return results;
    }
    if (results && Array.isArray(results.results)) {
        return results.results;
    }
    if (results) {
        return [results];
    }
    return [];
}

function _categorizeTokenList(list) {
    const userTokens = [];
    const invalidTokens = [];
    const botTokens = [];

    for (const item of list) {
        if (!item.valid) {
            invalidTokens.push(item);
        } else if (item.isBot || item.category === 'bot') {
            botTokens.push(item);
        } else {
            userTokens.push(item);
        }
    }

    return { userTokens, invalidTokens, botTokens };
}

function _formatUserNitroLine(item) {
    const hasNitro = Boolean(item.hasNitro || item.premiumType > 0);
    if (!hasNitro) {
        return 'ไม่มี';
    }
    const hasDays = Number.isFinite(item.expireDays) && item.expireDays > 0;
    if (hasDays) {
        return `มี (เหลือ${item.expireDays}วัน)`;
    }
    return 'มี';
}

function _formatUserTokensSection(userTokens, emojis) {
    if (userTokens.length === 0) {
        return null;
    }
    const { grejEmoji, verifybEmoji, krolesEmoji } = emojis;
    const userLines = [];

    for (const item of userTokens) {
        const rawToken = item.token || item.maskedToken || '';
        const username = item.username || 'Unknown';
        const nitroLine = _formatUserNitroLine(item);
        const boostCount = item.hasBoost || item.premiumType === 2 ? 2 : (item.boostCount || 0);

        userLines.push(
            `${grejEmoji}${verifybEmoji} \`${rawToken}\`\n` +
            `${krolesEmoji} user Token : \`${username}\`\n` +
            `• Nitro ปกติ : \`${nitroLine}\`\n` +
            `• Nitro Boost : \`${boostCount} Boost\``
        );
    }

    return userLines.join('\n');
}

function _formatInvalidTokensSection(invalidTokens, emojis) {
    if (invalidTokens.length === 0) {
        return null;
    }
    const { reddjEmoji, notEmoji } = emojis;
    const invalidLines = [];

    for (const item of invalidTokens) {
        const rawToken = item.token || item.maskedToken || '';
        invalidLines.push(
            `${reddjEmoji}${notEmoji} \`${rawToken}\`\n` +
            `• โทเคนนี้ไม่สามารถใช้งานได้ โปรดลองตรวจโทเคนสอบอีกครั้ง`
        );
    }

    return invalidLines.join('\n');
}

function _formatBotOwnerDisplay(ownerName, ownerId) {
    if (!ownerName || ownerName === 'ไม่ระบุ') {
        return 'ไม่ระบุ';
    }
    const formattedName = ownerName.startsWith('@') ? ownerName : `@${ownerName}`;
    return `${formattedName} (ID: ${ownerId})`;
}

function _formatSingleBotLine(item, emojis) {
    const { grejEmoji, r05Emoji } = emojis;
    const rawToken = item.token || item.maskedToken || '';
    const botName = item.globalName || item.username || 'Bot';
    const botId = item.id || '-';
    const ownerName = item.ownerUsername || 'ไม่ระบุ';
    const ownerId = item.ownerId || '-';
    const ownerDisplay = _formatBotOwnerDisplay(ownerName, ownerId);
    const guildCount = Number.isFinite(item.guildCount) ? item.guildCount : null;
    const serverDisplay = guildCount === null ? 'ไม่ทราบ' : `อยู่ใน ${guildCount} เซิร์ฟเวอร์`;
    const createdDate = item.createdAt ? formatDateBangkokDateOnly(item.createdAt) : '-';
    const ageString = item.createdAt ? getAccountAgeString(item.createdAt) : '-';
    const inviteUrl = item.inviteUrl || `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot+applications.commands&permissions=8`;

    return (
        `${grejEmoji}${r05Emoji} : \`${rawToken}\`\n` +
        `• ชื่อบอท: ${botName}\n` +
        `• ไอดีบอท: ${botId}\n` +
        `• เจ้าของ: ${ownerDisplay}\n` +
        `• เซิร์ฟเวอร์: ${serverDisplay}\n` +
        `• สร้างเมื่อ: ${createdDate} (${ageString})\n` +
        `• ลิงก์เชิญ: [คลิกเพื่อดึงบอทเข้าเซิร์ฟเวอร์](${inviteUrl})`
    );
}

function _formatBotTokensSection(botTokens, emojis) {
    if (botTokens.length === 0) {
        return null;
    }
    const botLines = botTokens.map(item => _formatSingleBotLine(item, emojis));
    return `🔍 ข้อมูลบัญชี Discord (Bot)\n\n${botLines.join('\n')}`;
}

function buildTokenCheckEmbed(results) {
    const list = _normalizeTokenResultsList(results);

    const emojis = {
        snEmoji: config.emojis?.sn_pmt || '<a:sn_pmt:1559878089750749244>',
        grejEmoji: config.emojis?.Grej_pmt || config.emojis?.dot_green || '<:Grej_pmt:1560405771978547340>',
        verifybEmoji: config.emojis?.verifyb_pmt || config.emojis?.check_black || '<a:verifyb_pmt:1561669634183397409>',
        krolesEmoji: config.emojis?.kroles_pmt || config.emojis?.members || '<:kroles_pmt:1553835237333672006>',
        reddjEmoji: config.emojis?.reddj_pmt || config.emojis?.dot_red || '<:reddj_pmt:1560405803792465940>',
        notEmoji: config.emojis?.not_pmt || config.emojis?.stop || '<:not_pmt:1553835188558233780>',
        r05Emoji: config.emojis?.r05_pmt || '<a:r05_pmt:1505544028740128838>'
    };

    const color = config.system?.themeColors?.primary || '#CC66FF';
    const { userTokens, invalidTokens, botTokens } = _categorizeTokenList(list);

    const sections = [];
    sections.push(`สรุปผลการตรวจสอบทั้งหมด : ${list.length} Token`);

    const userSection = _formatUserTokensSection(userTokens, emojis);
    if (userSection) {
        sections.push(userSection);
    }

    const invalidSection = _formatInvalidTokensSection(invalidTokens, emojis);
    if (invalidSection) {
        sections.push(invalidSection);
    }

    const botSection = _formatBotTokensSection(botTokens, emojis);
    if (botSection) {
        sections.push(botSection);
    }

    let description = sections.join('\n\n');
    if (description.length > 4000) {
        description = description.slice(0, 3950) + '\n\n... (ข้อมูลยาวเกินขีดจำกัด Discord)';
    }

    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(`${emojis.snEmoji}   ตรวจสอบเสร็จเเล้ว`)
        .setDescription(description);

    if (list.length === 1 && list[0].avatarUrl) {
        embed.setThumbnail(list[0].avatarUrl);
    }

    return embed;
}

function buildSingleTokenEmbed(result) {
    return buildTokenCheckEmbed([result]);
}

function buildBatchSummaryEmbed(batchData) {
    const results = Array.isArray(batchData)
        ? batchData
        : (batchData?.results || []);
    return buildTokenCheckEmbed(results);
}

module.exports = {
    THEME_COLORS,
    maskToken,
    getAccountCreatedAt,
    formatDateBangkok,
    formatDateBangkokDateOnly,
    getAccountAgeString,
    resolveNitroPlan,
    resolveAvatarUrl,
    resolveInvalidTokenErrorMessage,
    checkSingleToken,
    checkBatchTokens,
    buildSingleTokenEmbed,
    buildBatchSummaryEmbed,
    buildTokenCheckEmbed,
    buildValidBotProfile,
    fetchDiscordBot,
    fetchDiscordBotApplication,
    fetchDiscordBotGuilds
};
