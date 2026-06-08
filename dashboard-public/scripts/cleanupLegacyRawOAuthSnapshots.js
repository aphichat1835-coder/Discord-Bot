/*
================================================================================
  Cleanup legacy raw OAuth/member/guild snapshots

  Default mode is dry-run. Use --apply to unset legacy raw fields.
  This script never prints raw document contents.

  Schema renames handled:
    OAuthUser:
      discord.rawProfile  → discord.profileSnapshot
      guilds[].raw        → guilds[].snapshot
      lastMember.raw      → lastMember.snapshot

    VerifyLog:
      discordSnapshot.rawProfile     → (unset only, no rename target)
      discordSnapshot.member.raw     → (unset only)
      discordSnapshot.guild.raw      → (unset only)
      discordSnapshot.guilds[].raw   → (unset only)
      memberSnapshot.raw             → (unset only)
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

async function migrateOAuthUsers() {
    // Step 1: Copy discord.rawProfile → discord.profileSnapshot (where profileSnapshot is missing)
    const profileRename = await OAuthUser.collection.updateMany(
        {
            'discord.rawProfile': { $exists: true },
            'discord.profileSnapshot': { $exists: false }
        },
        [
            {
                $set: {
                    'discord.profileSnapshot': '$discord.rawProfile'
                }
            }
        ]
    );

    // Step 2: Copy lastMember.raw → lastMember.snapshot (where snapshot is missing)
    const memberRename = await OAuthUser.collection.updateMany(
        {
            'lastMember.raw': { $exists: true },
            'lastMember.snapshot': { $exists: false }
        },
        [
            {
                $set: {
                    'lastMember.snapshot': '$lastMember.raw'
                }
            }
        ]
    );

    // Step 3: Copy guilds[].raw → guilds[].snapshot for each guild element missing snapshot
    // Uses aggregation pipeline update to map over the array
    const guildRename = await OAuthUser.collection.updateMany(
        { 'guilds.raw': { $exists: true } },
        [
            {
                $set: {
                    guilds: {
                        $map: {
                            input: '$guilds',
                            as: 'g',
                            in: {
                                $mergeObjects: [
                                    '$$g',
                                    {
                                        snapshot: {
                                            $ifNull: ['$$g.snapshot', '$$g.raw']
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        ]
    );

    return {
        profileRenameModified: profileRename.modifiedCount || 0,
        memberRenameModified: memberRename.modifiedCount || 0,
        guildRenameModified: guildRename.modifiedCount || 0
    };
}

async function cleanupOAuthUsers() {
    const matched = await countOAuthUsersWithLegacyRaw();

    if (DRY_RUN || matched === 0) {
        return { matched, modified: 0, migrated: 0 };
    }

    // First: migrate old field values to new field names
    const migrated = await migrateOAuthUsers();

    // Then: unset the old legacy fields
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
        [
            {
                $set: {
                    guilds: {
                        $map: {
                            input: '$guilds',
                            as: 'g',
                            in: {
                                $arrayToObject: {
                                    $filter: {
                                        input: { $objectToArray: '$$g' },
                                        as: 'field',
                                        cond: { $ne: ['$$field.k', 'raw'] }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ]
    );

    return {
        matched,
        migrated: {
            profileRenameModified: migrated.profileRenameModified,
            memberRenameModified: migrated.memberRenameModified,
            guildRenameModified: migrated.guildRenameModified
        },
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
