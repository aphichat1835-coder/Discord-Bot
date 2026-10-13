"use strict";

const lifecycle = require("../discord/verification/lifecycle");
const {
    recoverPendingPrivacyDeletions,
    deletionOperationKey,
    subjectHash
} = require("../discord/verification/services/privacyDeletion");

function createMockJobModel(initialJobs = []) {
    const jobs = new Map(initialJobs.map(j => [j.jobId, structuredClone(j)]));
    return {
        _jobs: jobs,
        find(query = {}) {
            let list = Array.from(jobs.values());
            if (query.status && query.status.$in) {
                list = list.filter(j => query.status.$in.includes(j.status));
            }
            return {
                lean: async () => structuredClone(list)
            };
        },
        async updateOne(filter, update) {
            const job = jobs.get(filter.jobId);
            if (!job) return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
            if (filter.status !== undefined && job.status !== filter.status) {
                return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
            }
            if (filter.updatedAt !== undefined && job.updatedAt !== filter.updatedAt) {
                return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
            }
            if (filter.activeKey !== undefined && job.activeKey !== filter.activeKey) {
                return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
            }
            if (update.$set?.activeKey) {
                for (const other of jobs.values()) {
                    if (other.jobId !== filter.jobId && other.activeKey === update.$set.activeKey) {
                        const err = new Error("E11000 duplicate key error collection");
                        err.code = 11000;
                        throw err;
                    }
                }
            }
            if (update.$set) {
                Object.assign(job, structuredClone(update.$set));
            }
            if (update.$unset) {
                for (const k of Object.keys(update.$unset)) {
                    delete job[k];
                }
            }
            return { acknowledged: true, modifiedCount: 1, matchedCount: 1 };
        },
        async countDocuments(filter = {}) {
            let list = Array.from(jobs.values());
            if (filter.guildId) list = list.filter(j => j.guildId === filter.guildId);
            if (filter.userId) list = list.filter(j => j.userId === filter.userId);
            return list.length;
        }
    };
}

function createTestModels({ jobs = [], sqliteThrows = false, remainingReferences = 0 } = {}) {
    const jobModel = createMockJobModel(jobs);
    let sqliteDeletedCount = 0;
    const sqliteModel = {
        async deleteMany() {
            if (sqliteThrows) {
                const err = new Error("SQLite I/O failure");
                err.code = "SQLITE_DISK_ERROR";
                throw err;
            }
            sqliteDeletedCount++;
            return { acknowledged: true, deletedCount: 1 };
        },
        async countDocuments() { return 0; }
    };

    const emptyModel = {
        find: () => ({
            select: () => ({
                session: () => ({ lean: async () => [] }),
                lean: async () => []
            }),
            session: () => ({ lean: async () => [] }),
            lean: async () => []
        }),
        findOne: () => ({
            select: () => ({
                session: () => ({ lean: async () => null }),
                lean: async () => null
            }),
            session: () => ({ lean: async () => null }),
            lean: async () => null
        }),
        updateOne: async () => ({ acknowledged: true, modifiedCount: 1 }),
        updateMany: async () => ({ acknowledged: true, modifiedCount: 1 }),
        deleteMany: async () => ({ acknowledged: true, deletedCount: 1 }),
        countDocuments: async () => remainingReferences
    };

    return {
        models: {
            PrivacyDeletionJob: jobModel,
            VerificationRecovery: sqliteModel,
            VerifyLog: emptyModel,
            OAuthUser: emptyModel,
            IpIdentityLink: emptyModel,
            IpIdentityUserHistory: emptyModel,
            IpIdentityDeviceHistory: emptyModel,
            IpIdentityRoleHistory: emptyModel,
            OAuthMemberSnapshot: emptyModel,
            OAuthMemberRoleSnapshot: emptyModel,
            OAuthObjectChunkSnapshot: emptyModel,
            OAuthSnapshotRecovery: emptyModel,
            VerificationMigrationArchive: emptyModel
        },
        jobModel,
        getSqliteDeletedCount: () => sqliteDeletedCount
    };
}

function fakeMongoose() {
    return {
        connection: { readyState: 1 },
        async startSession() {
            return {
                async withTransaction(op) { return op(); },
                async endSession() {}
            };
        }
    };
}

describe("Privacy Deletion Startup Recovery Integration", () => {
    afterEach(async () => {
        await lifecycle.stopVerificationRuntime();
    });

    test("Integration 1: startVerificationRuntime recovers abandoned pending job on startup", async () => {
        const initialJob = {
            jobId: "pending-job-1",
            guildId: "guild-100",
            userId: "user-200",
            operationKey: deletionOperationKey("guild-100", "user-200"),
            activeKey: deletionOperationKey("guild-100", "user-200"),
            status: "pending",
            attempt: 1,
            requestedBy: "owner",
            manifest: {
                phases: { mongo: "pending", sqlite: "pending" },
                counts: {}
            },
            createdAt: Date.now() - 30 * 60 * 1000,
            updatedAt: Date.now() - 30 * 60 * 1000
        };

        const { models, jobModel, getSqliteDeletedCount } = createTestModels({ jobs: [initialJob] });

        const fakeTokenManager = {
            start: jest.fn().mockResolvedValue(true),
            stop: jest.fn().mockResolvedValue(true),
            getOAuthRefreshConfig: () => ({}),
            getDiagnostics: () => ({})
        };

        const diagnostics = await lifecycle.startVerificationRuntime({
            maintenanceRunner: async () => ({ ok: true }),
            oauthTokenManager: fakeTokenManager,
            privacyDeletionOptions: {
                models,
                mongooseInstance: fakeMongoose(),
                now: Date.now(),
                staleJobMs: 15 * 60 * 1000
            }
        });

        expect(diagnostics.privacyDeletionRecovery).toBeDefined();
        expect(diagnostics.privacyDeletionRecovery.lastSummary?.recoveredCount).toBe(1);
        expect(getSqliteDeletedCount()).toBe(1);

        const updatedJob = jobModel._jobs.get("pending-job-1");
        expect(updatedJob.status).toBe("completed");
        expect(updatedJob.manifest.phases.mongo).toBe("completed");
        expect(updatedJob.manifest.phases.sqlite).toBe("completed");
        expect(updatedJob.activeKey).toBeUndefined();
        expect(updatedJob.userId.startsWith("deleted:")).toBe(true);
        expect(updatedJob.completedAt).toBeGreaterThan(0);
    });

    test("Integration 2: staleJobMs preserves active worker jobs while recovering stale jobs", async () => {
        const now = Date.now();
        const activeJob = {
            jobId: "active-job",
            guildId: "guild-101",
            userId: "user-active",
            operationKey: deletionOperationKey("guild-101", "user-active"),
            activeKey: deletionOperationKey("guild-101", "user-active"),
            status: "running",
            manifest: { phases: { mongo: "pending", sqlite: "pending" } },
            updatedAt: now - 5000 // 5 seconds ago (< 60s staleJobMs)
        };
        const staleJob = {
            jobId: "stale-job",
            guildId: "guild-102",
            userId: "user-stale",
            operationKey: deletionOperationKey("guild-102", "user-stale"),
            activeKey: deletionOperationKey("guild-102", "user-stale"),
            status: "running",
            manifest: { phases: { mongo: "completed", sqlite: "pending" } },
            updatedAt: now - 120000 // 2 minutes ago (>= 60s staleJobMs)
        };

        const { models, jobModel } = createTestModels({ jobs: [activeJob, staleJob] });

        const recovered = await recoverPendingPrivacyDeletions({
            models,
            now,
            staleJobMs: 60000,
            mongooseInstance: fakeMongoose()
        });

        expect(recovered.length).toBe(1);
        expect(recovered[0].jobId).toBe("stale-job");
        expect(recovered[0].status).toBe("completed");

        const activeInStore = jobModel._jobs.get("active-job");
        expect(activeInStore.status).toBe("running");
        expect(activeInStore.activeKey).toBe(activeJob.activeKey);

        const staleInStore = jobModel._jobs.get("stale-job");
        expect(staleInStore.status).toBe("completed");
        expect(staleInStore.activeKey).toBeUndefined();
    });

    test("Integration 3: SQLite failure during recovery marks job failed and never completed", async () => {
        const job = {
            jobId: "sqlite-fail-job",
            guildId: "guild-103",
            userId: "user-103",
            operationKey: deletionOperationKey("guild-103", "user-103"),
            status: "running",
            manifest: { phases: { mongo: "completed", sqlite: "pending" } },
            updatedAt: Date.now() - 30 * 60 * 1000
        };

        const { models, jobModel } = createTestModels({ jobs: [job], sqliteThrows: true });

        const recovered = await recoverPendingPrivacyDeletions({
            models,
            now: Date.now(),
            mongooseInstance: fakeMongoose()
        });

        expect(recovered.length).toBe(1);
        expect(recovered[0].jobId).toBe("sqlite-fail-job");
        expect(recovered[0].status).toBe("failed");
        expect(recovered[0].errorCode).toBe("PRIVACY_DELETION_SQLITE_FAILED");

        const updated = jobModel._jobs.get("sqlite-fail-job");
        expect(updated.status).toBe("failed");
        expect(updated.errorCode).toBe("PRIVACY_DELETION_SQLITE_FAILED");
        expect(updated.manifest.phases.sqlite).toBe("failed");
        expect(updated.activeKey).toBeUndefined();
    });

    test("Integration 4: leftover references fail closed with PRIVACY_DELETION_INCOMPLETE and never complete", async () => {
        const job = {
            jobId: "incomplete-job",
            guildId: "guild-104",
            userId: "user-104",
            operationKey: deletionOperationKey("guild-104", "user-104"),
            status: "pending",
            manifest: { phases: { mongo: "pending", sqlite: "pending" } },
            updatedAt: Date.now() - 30 * 60 * 1000
        };

        const { models, jobModel } = createTestModels({ jobs: [job], remainingReferences: 3 });

        const recovered = await recoverPendingPrivacyDeletions({
            models,
            now: Date.now(),
            mongooseInstance: fakeMongoose()
        });

        expect(recovered.length).toBe(1);
        expect(recovered[0].jobId).toBe("incomplete-job");
        expect(recovered[0].status).toBe("failed");
        expect(recovered[0].errorCode).toBe("PRIVACY_DELETION_INCOMPLETE");
        expect(recovered[0].remainingReferences).toBeGreaterThan(0);

        const updated = jobModel._jobs.get("incomplete-job");
        expect(updated.status).toBe("failed");
        expect(updated.errorCode).toBe("PRIVACY_DELETION_INCOMPLETE");
        expect(updated.activeKey).toBeUndefined();
    });

    test("Integration 5: failed job with completed mongo recovers when SQLite becomes available", async () => {
        const job = {
            jobId: "recovered-failed-job",
            guildId: "guild-105",
            userId: "user-105",
            operationKey: deletionOperationKey("guild-105", "user-105"),
            status: "failed",
            errorCode: "PRIVACY_DELETION_SQLITE_FAILED",
            manifest: {
                phases: { mongo: "completed", sqlite: "failed" },
                counts: { verifyLogsRedacted: 2 }
            },
            updatedAt: Date.now() - 1000
        };

        const { models, jobModel, getSqliteDeletedCount } = createTestModels({ jobs: [job] });

        const recovered = await recoverPendingPrivacyDeletions({
            models,
            now: Date.now(),
            mongooseInstance: fakeMongoose()
        });

        expect(recovered.length).toBe(1);
        expect(recovered[0].jobId).toBe("recovered-failed-job");
        expect(recovered[0].status).toBe("completed");
        expect(getSqliteDeletedCount()).toBe(1);

        const updated = jobModel._jobs.get("recovered-failed-job");
        expect(updated.status).toBe("completed");
        expect(updated.manifest.phases.sqlite).toBe("completed");
        expect(updated.activeKey).toBeUndefined();
    });

    test("Integration 6: concurrent and repeated recovery runs are safe and idempotent", async () => {
        const job = {
            jobId: "concurrent-job",
            guildId: "guild-106",
            userId: "user-106",
            operationKey: deletionOperationKey("guild-106", "user-106"),
            status: "pending",
            manifest: { phases: { mongo: "pending", sqlite: "pending" } },
            updatedAt: Date.now() - 30 * 60 * 1000
        };

        const { models, jobModel, getSqliteDeletedCount } = createTestModels({ jobs: [job] });

        // Two concurrent recoveries
        const [run1, run2] = await Promise.all([
            recoverPendingPrivacyDeletions({ models, now: Date.now(), mongooseInstance: fakeMongoose() }),
            recoverPendingPrivacyDeletions({ models, now: Date.now(), mongooseInstance: fakeMongoose() })
        ]);

        const totalCompleted = [...run1, ...run2].filter(r => r.status === "completed");
        expect(totalCompleted.length).toBe(1);
        expect(getSqliteDeletedCount()).toBe(1);

        // Subsequent pass finds no eligible jobs
        const thirdRun = await recoverPendingPrivacyDeletions({ models, now: Date.now(), mongooseInstance: fakeMongoose() });
        expect(thirdRun.length).toBe(0);

        const finalJob = jobModel._jobs.get("concurrent-job");
        expect(finalJob.status).toBe("completed");
    });

    test("Integration 7: runPrivacyDeletionRecoverySafe handles in-flight deduplication and updates diagnostics", async () => {
        const job = {
            jobId: "diag-job",
            guildId: "guild-107",
            userId: "user-107",
            operationKey: deletionOperationKey("guild-107", "user-107"),
            status: "pending",
            manifest: { phases: { mongo: "pending", sqlite: "pending" } },
            updatedAt: Date.now() - 30 * 60 * 1000
        };

        const { models } = createTestModels({ jobs: [job] });

        const summary = await lifecycle.runPrivacyDeletionRecoverySafe({
            privacyDeletionOptions: {
                models,
                now: Date.now(),
                mongooseInstance: fakeMongoose()
            }
        });

        expect(summary.recoveredCount).toBe(1);
        expect(summary.jobs[0].jobId).toBe("diag-job");
        expect(summary.jobs[0].status).toBe("completed");

        const diagnostics = lifecycle.getVerificationDiagnostics();
        expect(diagnostics.privacyDeletionRecovery.lastSummary?.recoveredCount).toBe(1);
        expect(diagnostics.privacyDeletionRecovery.lastRunAt).toBeGreaterThan(0);
        expect(diagnostics.privacyDeletionRecovery.lastError).toBeNull();
    });
});
