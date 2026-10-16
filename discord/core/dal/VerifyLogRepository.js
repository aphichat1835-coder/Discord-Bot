'use strict';

/**
 * VerifyLogRepository
 * Domain repository for Verification Audit Logs.
 * Wraps universal DAL adapter (MongoDB or SQLite WAL).
 */
class VerifyLogRepository {
    constructor(adapter) {
        if (!adapter) {
            throw new Error('VerifyLogRepository requires an underlying storage adapter');
        }
        this.adapter = adapter;
    }

    async createLog(logData) {
        if (!logData?.guildId || !logData?.userId) {
            throw new Error('guildId and userId are required to create a VerifyLog');
        }
        const doc = {
            ...logData,
            verifiedAt: logData.verifiedAt || new Date(),
            createdAt: logData.createdAt || new Date()
        };
        return this.adapter.create(doc);
    }

    async findByGuild(guildId, options = {}) {
        if (!guildId) return [];
        const limit = Number(options?.limit) || 50;
        const skip = Number(options?.skip) || 0;
        return this.adapter.find({ guildId: String(guildId) }, {
            sort: { verifiedAt: -1, createdAt: -1 },
            limit,
            skip
        });
    }

    async findByUser(guildId, userId) {
        if (!guildId || !userId) return [];
        return this.adapter.find({ guildId: String(guildId), userId: String(userId) }, {
            sort: { verifiedAt: -1, createdAt: -1 }
        });
    }

    async countByGuild(guildId) {
        if (!guildId) return 0;
        return this.adapter.count({ guildId: String(guildId) });
    }

    async countByResult(guildId, result) {
        if (!guildId || !result) return 0;
        return this.adapter.count({ guildId: String(guildId), result: String(result) });
    }
}

module.exports = VerifyLogRepository;
