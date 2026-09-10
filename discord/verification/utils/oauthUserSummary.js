'use strict';

const OAuthUser = require('../models/OAuthUser');
const { readFiniteInteger } = require('../../core/numbers');

const OAUTH_USER_SUMMARY_MAX = readFiniteInteger(process.env.OAUTH_USER_SUMMARY_MAX, { fallback: 100, min: 20, max: 5000 });

function uniqueUserIds(userIds = []) {
    return [...new Set(
        userIds
            .map(userId => String(userId || '').trim())
            .filter(Boolean)
    )].slice(0, OAUTH_USER_SUMMARY_MAX);
}

async function loadOAuthUserSummaries(userIds = []) {
    const ids = uniqueUserIds(userIds);
    if (!ids.length) return [];

    return OAuthUser.aggregate([
        {
            $match: {
                'discord.userId': { $in: ids },
                deletedAt: { $exists: false }
            }
        },
        {
            $project: {
                'discord.userId': 1,
                'discord.username': 1,
                'discord.globalName': 1,
                'discord.displayTag': 1,
                'discord.avatarHash': 1,
                'discord.avatarUrl': 1,
                'discord.bannerHash': 1,
                'discord.bannerUrl': 1,
                'discord.accentColor': 1,
                'discord.email': 1,
                'discord.emailVerified': 1,
                'discord.badgeFlags': 1,
                'discord.accountAgeDays': 1,
                'discord.accountCreatedAt': 1,
                'discord.premiumType': 1,
                snapshotRefs: 1,
                snapshotMeta: 1,
                lastVerify: 1,
                lastMember: {
                    guildId: '$lastMember.guildId',
                    nick: '$lastMember.nick',
                    roleCount: '$lastMember.roleCount',
                    joinedAt: '$lastMember.joinedAt',
                    pending: '$lastMember.pending',
                    avatar: '$lastMember.avatar',
                    avatarUrl: '$lastMember.avatarUrl',
                    flags: '$lastMember.flags',
                    communicationDisabledUntil: '$lastMember.communicationDisabledUntil'
                },
                connectionsCount: {
                    $ifNull: ['$snapshotMeta.connections.storedCount', { $size: { $ifNull: ['$connections', []] } }]
                },
                guildsCount: {
                    $ifNull: ['$snapshotMeta.guilds.storedCount', { $size: { $ifNull: ['$guilds', []] } }]
                }
            }
        }
    ]);
}

async function makeOAuthUserSummaryMap(userIds = []) {
    const users = await loadOAuthUserSummaries(userIds);
    return Object.fromEntries(
        users.map(user => [user.discord?.userId, user])
    );
}

function getOAuthUserSummaryDiagnostics() {
    return {
        maxUserIds: OAUTH_USER_SUMMARY_MAX
    };
}

module.exports = {
    OAUTH_USER_SUMMARY_MAX,
    getOAuthUserSummaryDiagnostics,
    loadOAuthUserSummaries,
    makeOAuthUserSummaryMap
};
