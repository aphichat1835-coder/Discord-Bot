"use strict";

const crypto = require("node:crypto");
const oauthTokenManager = require("../../../core/oauthTokenManager");
const discord = require("../../utils/discordAPI");

const DAY_MS = 24 * 60 * 60 * 1000;

const USER_BADGE_FLAGS = Object.freeze([
    [2 ** 0, "STAFF"],
    [2 ** 1, "PARTNER"],
    [2 ** 2, "HYPESQUAD"],
    [2 ** 3, "BUG_HUNTER_LEVEL_1"],
    [2 ** 6, "HYPESQUAD_BRAVERY"],
    [2 ** 7, "HYPESQUAD_BRILLIANCE"],
    [2 ** 8, "HYPESQUAD_BALANCE"],
    [2 ** 9, "PREMIUM_EARLY_SUPPORTER"],
    [2 ** 10, "TEAM_PSEUDO_USER"],
    [2 ** 14, "BUG_HUNTER_LEVEL_2"],
    [2 ** 16, "VERIFIED_BOT"],
    [2 ** 17, "VERIFIED_DEVELOPER"],
    [2 ** 18, "CERTIFIED_MODERATOR"],
    [2 ** 19, "BOT_HTTP_INTERACTIONS"]
]);

function getAccountCreatedAt(userId) {
    try {
        return Number((BigInt(userId) >> 22n) + 1420070400000n);
    } catch {
        return null;
    }
}

function getAccountAgeDays(userId) {
    const createdAt = getAccountCreatedAt(userId);
    if (!createdAt) return 0;
    return Math.floor((Date.now() - createdAt) / DAY_MS);
}

function decodeUserBadgeFlags(profile = {}) {
    const flags = Number(profile.public_flags ?? profile.flags ?? 0) || 0;
    return USER_BADGE_FLAGS
        .filter(([bit]) => (flags & bit) === bit)
        .map(([, label]) => label);
}

function getCdnExtension(hash) {
    return String(hash || "").startsWith("a_") ? "gif" : "png";
}

function getAvatarUrl(profile = {}) {
    if (!profile?.avatar) {
        let fallback = Number(profile?.discriminator || 0) % 5;
        if (!profile?.discriminator || profile.discriminator === "0") {
            try {
                fallback = Number((BigInt(profile.id) >> 22n) % 6n);
            } catch {
                fallback = 0;
            }
        }
        return `https://cdn.discordapp.com/embed/avatars/${fallback}.png`;
    }
    const ext = getCdnExtension(profile.avatar);
    return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${ext}?size=256`;
}

function getBannerUrl(profile = {}) {
    if (!profile?.banner) return null;
    const ext = getCdnExtension(profile.banner);
    return `https://cdn.discordapp.com/banners/${profile.id}/${profile.banner}.${ext}?size=512`;
}

function displayTag(profile = {}) {
    if (profile.discriminator && profile.discriminator !== "0") {
        return `${profile.username}#${profile.discriminator}`;
    }
    return `@${profile.username}`;
}

/**
 * Normalizes connections: stores ONLY type and verified status.
 * Strips account names, IDs, metadata, integrations, and raw data completely.
 */
function normalizeConnections(connections = []) {
    if (!Array.isArray(connections)) return [];
    return connections
        .map(item => {
            if (typeof item === "string") {
                const type = item.trim();
                return type ? { type, verified: false } : null;
            }
            if (item && typeof item === "object" && !Array.isArray(item)) {
                const type = typeof item.type === "string" ? item.type.trim() : "";
                if (!type) return null;
                return {
                    type,
                    verified: Boolean(item.verified)
                };
            }
            return null;
        })
        .filter(Boolean);
}

/**
 * Aggregates Guild summary in memory from the fetched array.
 * Total count and owned count only.
 * Discards raw guilds array immediately!
 */
function computeGuildSummary(guildsResult, fetchFailed, failureReason, previousSummary = null) {
    const now = Date.now();
    if (fetchFailed || !Array.isArray(guildsResult)) {
        const prevTotal = Number.isFinite(Number(previousSummary?.totalCount))
            ? Number(previousSummary.totalCount)
            : (Number.isFinite(Number(previousSummary?.totalGuilds)) ? Number(previousSummary.totalGuilds) : 0);
        const prevOwned = Number.isFinite(Number(previousSummary?.ownedCount))
            ? Number(previousSummary.ownedCount)
            : (Number.isFinite(Number(previousSummary?.ownerGuildsCount)) ? Number(previousSummary.ownerGuildsCount) : 0);
        const prevAdmin = Number.isFinite(Number(previousSummary?.adminCount))
            ? Number(previousSummary.adminCount)
            : (Number.isFinite(Number(previousSummary?.adminGuildsCount)) ? Number(previousSummary.adminGuildsCount) : 0);
        return {
            totalCount: prevTotal,
            ownedCount: prevOwned,
            adminCount: prevAdmin,
            totalGuilds: prevTotal,
            ownerGuildsCount: prevOwned,
            adminGuildsCount: prevAdmin,
            status: "failed",
            fetchedAt: previousSummary?.fetchedAt || null,
            attemptedAt: now,
            failureReason: failureReason || "guilds_fetch_failed"
        };
    }

    const totalCount = guildsResult.length;
    let ownedCount = 0;
    let adminCount = 0;
    for (const g of guildsResult) {
        if (g?.owner === true) {
            ownedCount++;
        }
        try {
            const perms = BigInt(g?.permissions || 0);
            if (g?.owner === true || (perms & 8n) === 8n) {
                adminCount++;
            }
        } catch {
            if (g?.owner === true) {
                adminCount++;
            }
        }
    }

    return {
        totalCount,
        ownedCount,
        adminCount,
        totalGuilds: totalCount,
        ownerGuildsCount: ownedCount,
        adminGuildsCount: adminCount,
        status: totalCount > 0 ? "success" : "empty",
        fetchedAt: now,
        attemptedAt: now,
        failureReason: null
    };
}

async function collectDiscordData({ code, redirectUri, previousSummary = null, previousConnections = null }) {
    const tokenData = await oauthTokenManager.exchangeAuthorizationCode(code, redirectUri);
    const accessToken = tokenData.access_token;

    const resolved = await Promise.all([
        discord.getUserProfile(accessToken),
        Promise.resolve(discord.getUserConnections(accessToken)).catch(err => ({
            fetchFailed: true,
            fetchStatus: err?.status || 500,
            fetchFailureReason: err?.message || "connections_fetch_error"
        })),
        Promise.resolve(discord.getUserGuilds(accessToken)).catch(err => ({
            fetchFailed: true,
            fetchStatus: err?.status || 500,
            fetchFailureReason: err?.message || "guilds_fetch_error"
        }))
    ]);

    const rawProfile = resolved[0] || {};
    const rawConnections = resolved[1];
    const rawGuilds = resolved[2];

    const connectionsFetchFailed = rawConnections?.fetchFailed === true || !Array.isArray(rawConnections);
    const guildsFetchFailed = rawGuilds?.fetchFailed === true || !Array.isArray(rawGuilds);

    const fetchMetadata = {
        connectionsFetchFailed,
        connectionsFetchStatus: rawConnections?.fetchStatus || (connectionsFetchFailed ? 500 : 200),
        connectionsFailureReason: rawConnections?.fetchFailureReason || null,
        guildsFetchFailed,
        guildsFetchStatus: rawGuilds?.fetchStatus || (guildsFetchFailed ? 500 : 200),
        guildsFailureReason: rawGuilds?.fetchFailureReason || null,
        memberFetchAttempted: false,
        memberFetchFailed: false,
        memberFetchStatus: null,
        memberFailureReason: null,
        memberFetchSource: null
    };

    const connections = connectionsFetchFailed
        ? (Array.isArray(previousConnections) && previousConnections.length > 0 ? previousConnections : [])
        : normalizeConnections(rawConnections);
    const guildSummary = computeGuildSummary(rawGuilds, guildsFetchFailed, fetchMetadata.guildsFailureReason, previousSummary);

    const profile = {
        id: String(rawProfile.id),
        username: rawProfile.username || "",
        discriminator: rawProfile.discriminator || "0",
        globalName: rawProfile.global_name ?? rawProfile.globalName ?? null,
        displayTag: displayTag(rawProfile),
        avatar: rawProfile.avatar || null,
        avatarHash: rawProfile.avatar || null,
        avatarUrl: getAvatarUrl(rawProfile),
        banner: rawProfile.banner || null,
        bannerHash: rawProfile.banner || null,
        bannerUrl: getBannerUrl(rawProfile),
        accentColor: Number.isFinite(Number(rawProfile.accent_color)) ? Number(rawProfile.accent_color) : null,
        email: rawProfile.email || null,
        emailVerified: rawProfile.verified === true,
        locale: rawProfile.locale || null,
        mfaEnabled: rawProfile.mfa_enabled === true,
        premiumType: Number.isFinite(Number(rawProfile.premium_type)) ? Number(rawProfile.premium_type) : 0,
        flags: Number(rawProfile.flags) || 0,
        publicFlags: Number(rawProfile.public_flags) || 0,
        badgeFlags: decodeUserBadgeFlags(rawProfile),
        accountCreatedAt: getAccountCreatedAt(rawProfile.id),
        accountAgeDays: getAccountAgeDays(rawProfile.id),
        rawProfile
    };

    return {
        tokenData,
        accessToken,
        profile,
        connections,
        guildSummary,
        fetchMetadata
    };
}

module.exports = {
    getAccountCreatedAt,
    getAccountAgeDays,
    decodeUserBadgeFlags,
    getAvatarUrl,
    getBannerUrl,
    displayTag,
    normalizeConnections,
    computeGuildSummary,
    collectDiscordData
};
