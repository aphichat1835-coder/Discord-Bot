'use strict';

/**
 * PrivacyDeletionJobRepository
 * Domain repository for GDPR / Right-to-be-forgotten privacy deletion queue.
 * Wraps universal DAL adapter (MongoDB or SQLite WAL).
 */
class PrivacyDeletionJobRepository {
    constructor(adapter) {
        if (!adapter) {
            throw new Error('PrivacyDeletionJobRepository requires an underlying storage adapter');
        }
        this.adapter = adapter;
    }

    async createJob(jobData) {
        if (!jobData?.jobId || !jobData?.guildId || !jobData?.userId) {
            throw new Error('jobId, guildId, and userId are required');
        }
        const doc = {
            status: 'pending',
            attempt: 1,
            ...jobData,
            createdAt: jobData.createdAt || Date.now(),
            updatedAt: jobData.updatedAt || Date.now()
        };
        return this.adapter.create(doc);
    }

    async findByJobId(jobId) {
        if (!jobId) return null;
        return this.adapter.findOne({ jobId: String(jobId) });
    }

    async findPendingJobs(limit = 10) {
        return this.adapter.find({ status: 'pending' }, {
            sort: { createdAt: 1 },
            limit
        });
    }

    async updateStatus(jobId, status, extra = {}) {
        if (!jobId) throw new Error('jobId is required');
        const filter = { jobId: String(jobId) };
        const update = {
            $set: {
                status,
                ...extra,
                updatedAt: Date.now()
            }
        };
        return this.adapter.updateOne(filter, update);
    }
}

module.exports = PrivacyDeletionJobRepository;
