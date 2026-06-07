/*
================================================================================
  Cleanup legacy raw OAuth/member/guild snapshots

  Default mode is dry-run. Use --apply to unset legacy raw fields.
  This script never prints raw document contents.
================================================================================
*/

const mongoose = require('mongoose');

const OAuthUser = require('../models/OAuthUser');
const VerifyLog = require('../models/VerifyLog');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

function requireMongoUri() {
    if (!process.env.MONGO_URI) {
        throw new Error('Missing MONGO_URI');
    }

    return process.env.MONGO_URI;
}

async function countOAuthUsersWithLegacyRaw() {
    return OAuthUser.collection.countDocuments({
        $or: [
            { 'discord.rawProfile': { $exists: true } },
            { 'guilds.raw': { $exists: true } },
            { 'lastMember.raw': { $exists: true } }
        ]
    });
}

async function countVerifyLogsWithLegacyRaw() {
    return VerifyLog.collection.countDocuments({
        $or: [
            { 'discordSnapshot.rawProfile': { $exists: true } },
            { 'discordSnapshot.member.raw': { $exists: true } },
            { 'discordSnapshot.guild.raw': { $exists: true } },
            { 'discordSnapshot.guilds.raw': { $exists: true } },
            { 'memberSnapshot.raw': { $exists: true } }
        ]
    });
}

async function cleanupOAuthUsers() {
    const matched = await countOAuthUsersWithLegacyRaw();

    if (DRY_RUN || matched === 0) {
        return { matched, modified: 0 };
    }

    const direct = await OAuthUser.collection.updateMany(
        {
            $or: [
                { 'discord.rawProfile': { $exists: true } },
                { 'lastMember.raw': { $exists: true } }
            ]
        },
        {
            $unset: {
                'discord.rawProfile': '',
                'lastMember.raw': ''
            }
        }
    );

    const guildRaw = await OAuthUser.collection.updateMany(
        { 'guilds.raw': { $exists: true } },
        {
            $unset: {
                'guilds.$[].raw': ''
            }
        }
    );

    return {
        matched,
        modified: (direct.modifiedCount || 0) + (guildRaw.modifiedCount || 0)
    };
}

async function cleanupVerifyLogs() {
    const matched = await countVerifyLogsWithLegacyRaw();

    if (DRY_RUN || matched === 0) {
        return { matched, modified: 0 };
    }

    const direct = await VerifyLog.collection.updateMany(
        {
            $or: [
                { 'discordSnapshot.rawProfile': { $exists: true } },
                { 'discordSnapshot.member.raw': { $exists: true } },
                { 'discordSnapshot.guild.raw': { $exists: true } },
                { 'memberSnapshot.raw': { $exists: true } }
            ]
        },
        {
            $unset: {
                'discordSnapshot.rawProfile': '',
                'discordSnapshot.member.raw': '',
                'discordSnapshot.guild.raw': '',
                'memberSnapshot.raw': ''
            }
        }
    );

    const guildRaw = await VerifyLog.collection.updateMany(
        { 'discordSnapshot.guilds.raw': { $exists: true } },
        {
            $unset: {
                'discordSnapshot.guilds.$[].raw': ''
            }
        }
    );

    return {
        matched,
        modified: (direct.modifiedCount || 0) + (guildRaw.modifiedCount || 0)
    };
}

async function main() {
    await mongoose.connect(requireMongoUri(), { maxPoolSize: 2 });

    const [oauthUsers, verifyLogs] = await Promise.all([
        cleanupOAuthUsers(),
        cleanupVerifyLogs()
    ]);

    console.log(JSON.stringify({
        mode: DRY_RUN ? 'dry-run' : 'apply',
        oauthUsers,
        verifyLogs
    }, null, 2));
}

main()
    .catch(err => {
        console.error('[cleanupLegacyRawOAuthSnapshots] failed:', err?.message || err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
