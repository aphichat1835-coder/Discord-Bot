'use strict';

/**
 * OAuthUserRepository
 * Domain repository for OAuth authenticated users and snapshots.
 * Wraps universal DAL adapter (MongoDB or SQLite WAL).
 */
class OAuthUserRepository {
    constructor(adapter) {
        if (!adapter) {
            throw new Error('OAuthUserRepository requires an underlying storage adapter');
        }
        this.adapter = adapter;
    }

    async findByUserId(userId) {
        if (!userId) return null;
        return this.adapter.findOne({ 'discord.userId': String(userId) });
    }

    async upsertUser(userId, userData = {}) {
        if (!userId) throw new Error('userId is required');
        const filter = { 'discord.userId': String(userId) };
        const update = {
            $set: {
                ...userData,
                'discord.userId': String(userId),
                updatedAt: new Date()
            }
        };
        return this.adapter.updateOne(filter, update, { upsert: true });
    }

    async updateTokens(userId, tokenData = {}) {
        if (!userId) throw new Error('userId is required');
        const filter = { 'discord.userId': String(userId) };
        const update = {
            $set: {
                tokens: tokenData,
                updatedAt: new Date()
            }
        };
        return this.adapter.updateOne(filter, update);
    }

    async deleteByUserId(userId) {
        if (!userId) return false;
        return this.adapter.deleteOne({ 'discord.userId': String(userId) });
    }
}

module.exports = OAuthUserRepository;
