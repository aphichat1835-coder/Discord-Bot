'use strict';

/**
 * GuildConfigRepository
 * Domain-specific repository for Guild Configuration.
 * Wraps an underlying BaseRepository adapter (SQLite WAL or MongoDB).
 */
class GuildConfigRepository {
    constructor(adapter) {
        if (!adapter) {
            throw new Error('GuildConfigRepository requires an underlying storage adapter');
        }
        this.adapter = adapter;
    }

    async findByGuildId(guildId) {
        if (!guildId) return null;
        return this.adapter.findOne({ guildId: String(guildId) });
    }

    async ensureGuildConfig(guildId, defaultData = {}) {
        if (!guildId) throw new Error('guildId is required');
        const existing = await this.findByGuildId(guildId);
        if (existing) return existing;

        const doc = {
            guildId: String(guildId),
            verification: {
                enabled: false,
                roleId: null,
                channelId: null,
                mode: 'direct'
            },
            ...defaultData,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        return this.adapter.create(doc);
    }

    async updateVerificationConfig(guildId, verificationUpdates = {}) {
        if (!guildId) throw new Error('guildId is required');
        const filter = { guildId: String(guildId) };
        const update = {
            $set: {
                ...Object.fromEntries(
                    Object.entries(verificationUpdates).map(([k, v]) => [`verification.${k}`, v])
                ),
                updatedAt: new Date()
            }
        };
        return this.adapter.updateOne(filter, update, { upsert: true });
    }

    async deleteByGuildId(guildId) {
        if (!guildId) return { deletedCount: 0 };
        return this.adapter.deleteOne({ guildId: String(guildId) });
    }
}

module.exports = GuildConfigRepository;
