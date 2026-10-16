"use strict";

const { getDatabase } = require("../../connection");

function _formatProgressValues(progress, now, jobId) {
    return [
        progress.totalEligible !== undefined ? Number(progress.totalEligible) : null,
        progress.processedCount !== undefined ? Number(progress.processedCount) : null,
        progress.successCount !== undefined ? Number(progress.successCount) : null,
        progress.failureCount !== undefined ? Number(progress.failureCount) : null,
        progress.retryCount !== undefined ? Number(progress.retryCount) : null,
        progress.lastCursorVerifiedAt != null ? Number(progress.lastCursorVerifiedAt) : null,
        progress.lastCursorId != null ? String(progress.lastCursorId) : null,
        now,
        String(jobId)
    ];
}

class VerificationWebhookRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    createJob({
        jobId,
        guildId,
        destinationVersion = 1,
        mode = "LIVE",
        totalEligible = 0
    }) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO verification_webhook_jobs (
                job_id, guild_id, destination_version, mode, status,
                total_eligible, processed_count, success_count, failure_count, retry_count,
                last_cursor_verified_at, last_cursor_id, lease_token, lease_expires_at,
                error_message, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, 'RUNNING', ?, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
        `);

        return this.db.transaction(() => {
            const active = this.getActiveJob(guildId);
            if (active) {
                const err = new Error("มีงาน Webhook กำลังทำงานอยู่แล้วสำหรับเซิร์ฟเวอร์นี้");
                err.code = "ACTIVE_WEBHOOK_JOB_EXISTS";
                throw err;
            }
            stmt.run(
                String(jobId),
                String(guildId),
                Number(destinationVersion) || 1,
                String(mode),
                Number(totalEligible) || 0,
                now,
                now
            );
            return this.getJobById(jobId);
        })();
    }

    getJobById(jobId) {
        if (!jobId) return null;
        return this.db.prepare(`SELECT * FROM verification_webhook_jobs WHERE job_id = ?`).get(String(jobId)) || null;
    }

    getActiveJob(guildId) {
        if (!guildId) return null;
        return this.db.prepare(`
            SELECT * FROM verification_webhook_jobs 
            WHERE guild_id = ? AND status IN ('RUNNING', 'PENDING')
            ORDER BY created_at DESC LIMIT 1
        `).get(String(guildId)) || null;
    }

    getLatestJob(guildId) {
        if (!guildId) return null;
        return this.db.prepare(`
            SELECT * FROM verification_webhook_jobs 
            WHERE guild_id = ?
            ORDER BY created_at DESC LIMIT 1
        `).get(String(guildId)) || null;
    }

    ensureDeliverySchema() {
        // Schema is managed via SQLite migration 012_verification_webhook_sent_parts.sql
        this._deliverySchemaEnsured = true;
    }

    updateJobProgress(jobId, progress = {}) {
        const now = Date.now();
        const baseValues = _formatProgressValues(progress, now, jobId);
        if (progress.leaseToken) {
            const stmt = this.db.prepare(`
                UPDATE verification_webhook_jobs
                SET total_eligible = COALESCE(?, total_eligible),
                    processed_count = COALESCE(?, processed_count),
                    success_count = COALESCE(?, success_count),
                    failure_count = COALESCE(?, failure_count),
                    retry_count = COALESCE(?, retry_count),
                    last_cursor_verified_at = COALESCE(?, last_cursor_verified_at),
                    last_cursor_id = COALESCE(?, last_cursor_id),
                    updated_at = ?
                WHERE job_id = ? AND status = 'RUNNING' AND lease_token = ? AND lease_expires_at >= ?
            `);
            return stmt.run(
                ...baseValues,
                String(progress.leaseToken),
                now
            );
        }
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET total_eligible = COALESCE(?, total_eligible),
                processed_count = COALESCE(?, processed_count),
                success_count = COALESCE(?, success_count),
                failure_count = COALESCE(?, failure_count),
                retry_count = COALESCE(?, retry_count),
                last_cursor_verified_at = COALESCE(?, last_cursor_verified_at),
                last_cursor_id = COALESCE(?, last_cursor_id),
                updated_at = ?
            WHERE job_id = ? AND status = 'RUNNING'
        `);
        return stmt.run(...baseValues);
    }

    resetJobLease(jobId) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE job_id = ? AND status = 'RUNNING'
        `);
        return stmt.run(now, String(jobId));
    }

    acquireJobLease(jobId, leaseToken, ttlMs = 30000) {
        const now = Date.now();
        const expiresAt = now + ttlMs;
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE job_id = ? AND status = 'RUNNING' AND (lease_token IS NULL OR lease_expires_at < ? OR lease_token = ?)
        `);
        const result = stmt.run(String(leaseToken), expiresAt, now, String(jobId), now, String(leaseToken));
        return result.changes > 0;
    }

    renewJobLease(jobId, leaseToken, ttlMs = 30000) {
        const now = Date.now();
        const expiresAt = now + ttlMs;
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET lease_expires_at = ?, updated_at = ?
            WHERE job_id = ? AND status = 'RUNNING' AND lease_token = ?
        `);
        const result = stmt.run(expiresAt, now, String(jobId), String(leaseToken));
        return result.changes > 0;
    }

    completeJob(jobId, status = 'COMPLETED', leaseToken = null) {
        const now = Date.now();
        const finalStatus = ['COMPLETED', 'COMPLETED_WITH_FAILURES'].includes(status) ? status : 'COMPLETED';
        if (leaseToken) {
            return this.db.prepare(`
                UPDATE verification_webhook_jobs
                SET status = ?, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
                WHERE job_id = ? AND status = 'RUNNING' AND lease_token = ?
            `).run(finalStatus, now, now, String(jobId), String(leaseToken));
        }
        return this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET status = ?, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE job_id = ? AND status = 'RUNNING'
        `).run(finalStatus, now, now, String(jobId));
    }

    updateJobStatus(jobId, status, {
        processedCount,
        successCount,
        failureCount,
        retryCount,
        errorMessage = null
    } = {}) {
        const now = Date.now();
        const completedAt = ['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED'].includes(status) ? now : null;
        return this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET status = ?,
                processed_count = COALESCE(?, processed_count),
                success_count = COALESCE(?, success_count),
                failure_count = COALESCE(?, failure_count),
                retry_count = COALESCE(?, retry_count),
                error_message = COALESCE(?, error_message),
                lease_token = CASE WHEN ? IN ('COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED') THEN NULL ELSE lease_token END,
                lease_expires_at = CASE WHEN ? IN ('COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED') THEN NULL ELSE lease_expires_at END,
                completed_at = COALESCE(?, completed_at),
                updated_at = ?
            WHERE job_id = ?
        `).run(
            String(status),
            processedCount !== undefined ? Number(processedCount) : null,
            successCount !== undefined ? Number(successCount) : null,
            failureCount !== undefined ? Number(failureCount) : null,
            retryCount !== undefined ? Number(retryCount) : null,
            errorMessage ? String(errorMessage) : null,
            String(status),
            String(status),
            completedAt,
            now,
            String(jobId)
        );
    }

    failJob(jobId, errorMessage) {
        const now = Date.now();
        return this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL, error_message = ?, updated_at = ?
            WHERE job_id = ?
        `).run(String(errorMessage || "unknown_error"), now, String(jobId));
    }

    cancelJob(jobId, reason = "cancelled") {
        const now = Date.now();
        return this.db.transaction(() => {
            const jobResult = this.db.prepare(`
                UPDATE verification_webhook_jobs
                SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL, error_message = ?, updated_at = ?
                WHERE job_id = ? AND status IN ('RUNNING', 'PENDING')
            `).run(String(reason), now, String(jobId));

            this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'FAILED', error_code = 'job_cancelled', error_message = ?, updated_at = ?
                WHERE job_id = ? AND status IN ('PENDING', 'RETRY')
            `).run(String(reason), now, String(jobId));

            return jobResult;
        })();
    }

    cancelActiveJobsAndDeliveriesForGuild(guildId, reason = "switched_to_live_only") {
        const now = Date.now();
        return this.db.transaction(() => {
            const jobResult = this.db.prepare(`
                UPDATE verification_webhook_jobs
                SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL, error_message = ?, updated_at = ?
                WHERE guild_id = ? AND status IN ('RUNNING', 'PENDING')
            `).run(String(reason), now, String(guildId));

            this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'FAILED', error_code = 'cancelled_by_live_mode', error_message = ?, updated_at = ?
                WHERE guild_id = ? AND job_id IS NOT NULL AND status IN ('PENDING', 'RETRY')
            `).run(String(reason), now, String(guildId));

            return jobResult;
        })();
    }

    cancelOrFailOldJobs(guildId, errorMessage = "destination_version_changed", newDestinationVersion = null) {
        const now = Date.now();
        return this.db.transaction(() => {
            const jobResult = this.db.prepare(`
                UPDATE verification_webhook_jobs
                SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL, error_message = ?, updated_at = ?
                WHERE guild_id = ? AND status IN ('RUNNING', 'PENDING')
            `).run(String(errorMessage), now, String(guildId));

            if (newDestinationVersion !== null && Number(newDestinationVersion) > 0) {
                this.db.prepare(`
                    UPDATE verification_webhook_deliveries
                    SET status = 'FAILED', error_code = 'destination_version_changed', error_message = ?, updated_at = ?
                    WHERE guild_id = ? AND status IN ('PENDING', 'RETRY', 'SENDING') AND destination_version < ?
                `).run(String(errorMessage), now, String(guildId), Number(newDestinationVersion));
            } else {
                this.db.prepare(`
                    UPDATE verification_webhook_deliveries
                    SET status = 'FAILED', error_code = 'destination_version_changed', error_message = ?, updated_at = ?
                    WHERE guild_id = ? AND status IN ('PENDING', 'RETRY', 'SENDING')
                `).run(String(errorMessage), now, String(guildId));
            }

            return jobResult;
        })();
    }

    enqueueDelivery({
        deliveryId,
        jobId = null,
        guildId,
        destinationVersion = 1,
        eventId,
        userId
    }) {
        this.ensureDeliverySchema();
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO verification_webhook_deliveries (
                delivery_id, job_id, guild_id, destination_version, event_id,
                user_id, status, attempt_count, next_retry_at, last_attempt_at,
                error_code, error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, NULL, ?, ?)
            ON CONFLICT(delivery_id) DO UPDATE SET
                status = 'PENDING',
                job_id = COALESCE(excluded.job_id, verification_webhook_deliveries.job_id),
                attempt_count = 0,
                next_retry_at = excluded.next_retry_at,
                error_code = NULL,
                error_message = NULL,
                updated_at = excluded.updated_at
            WHERE verification_webhook_deliveries.status = 'FAILED'
        `);
        return stmt.run(
            String(deliveryId),
            jobId ? String(jobId) : null,
            String(guildId),
            Number(destinationVersion) || 1,
            String(eventId),
            String(userId),
            now,
            now,
            now
        );
    }

    requeueFailedDelivery(deliveryId, jobId = null) {
        this.ensureDeliverySchema();
        const now = Date.now();
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'PENDING',
                job_id = COALESCE(?, job_id),
                attempt_count = 0,
                next_retry_at = NULL,
                error_code = NULL,
                error_message = NULL,
                updated_at = ?
            WHERE delivery_id = ? AND status = 'FAILED'
        `);
        return stmt.run(jobId ? String(jobId) : null, now, String(deliveryId));
    }

    claimNextDeliveries(guildId, limit = 10, destinationVersion = null) {
        this.ensureDeliverySchema();
        const now = Date.now();
        const hasVersion = destinationVersion !== null && Number(destinationVersion) > 0;
        const query = hasVersion
            ? `SELECT * FROM verification_webhook_deliveries
               WHERE guild_id = ? AND destination_version = ? AND status IN ('PENDING', 'RETRY') AND (next_retry_at IS NULL OR next_retry_at <= ?)
               ORDER BY created_at ASC
               LIMIT ?`
            : `SELECT * FROM verification_webhook_deliveries
               WHERE guild_id = ? AND status IN ('PENDING', 'RETRY') AND (next_retry_at IS NULL OR next_retry_at <= ?)
               ORDER BY created_at ASC
               LIMIT ?`;
        const selectStmt = this.db.prepare(query);

        return this.db.transaction(() => {
            const params = hasVersion
                ? [String(guildId), Number(destinationVersion), now, Math.max(1, Number(limit) || 10)]
                : [String(guildId), now, Math.max(1, Number(limit) || 10)];
            const rows = selectStmt.all(...params);
            if (!rows.length) return [];
            const markStmt = this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'SENDING', last_attempt_at = ?, attempt_count = attempt_count + 1, updated_at = ?
                WHERE delivery_id = ?
            `);
            for (const row of rows) {
                markStmt.run(now, now, row.delivery_id);
                row.attempt_count = (Number(row.attempt_count) || 0) + 1;
                row.last_attempt_at = now;
            }
            return rows;
        })();
    }

    markDeliverySent(deliveryId, expectedDestinationVersion = null) {
        const now = Date.now();
        if (expectedDestinationVersion !== null && Number(expectedDestinationVersion) > 0) {
            return this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'SENT', error_code = NULL, error_message = NULL, updated_at = ?
                WHERE delivery_id = ? AND status IN ('SENDING', 'PENDING', 'RETRY') AND destination_version = ?
            `).run(now, String(deliveryId), Number(expectedDestinationVersion));
        }
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'SENT', error_code = NULL, error_message = NULL, updated_at = ?
            WHERE delivery_id = ? AND status IN ('SENDING', 'PENDING', 'RETRY')
        `).run(now, String(deliveryId));
    }

    markDeliveryRetry(deliveryId, delayMs = 5000, errorCode = null, errorMessage = null, expectedDestinationVersion = null) {
        const now = Date.now();
        const nextRetry = now + Math.max(1000, Number(delayMs) || 5000);
        if (expectedDestinationVersion !== null && Number(expectedDestinationVersion) > 0) {
            return this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'RETRY', next_retry_at = ?, error_code = ?, error_message = ?, updated_at = ?
                WHERE delivery_id = ? AND status IN ('SENDING', 'PENDING', 'RETRY') AND destination_version = ?
            `).run(nextRetry, errorCode ? String(errorCode) : null, errorMessage ? String(errorMessage) : null, now, String(deliveryId), Number(expectedDestinationVersion));
        }
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'RETRY', next_retry_at = ?, error_code = ?, error_message = ?, updated_at = ?
            WHERE delivery_id = ? AND status IN ('SENDING', 'PENDING', 'RETRY')
        `).run(nextRetry, errorCode ? String(errorCode) : null, errorMessage ? String(errorMessage) : null, now, String(deliveryId));
    }

    markDeliveryFailed(deliveryId, errorCode = null, errorMessage = null, expectedDestinationVersion = null) {
        const now = Date.now();
        if (expectedDestinationVersion !== null && Number(expectedDestinationVersion) > 0) {
            return this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?
                WHERE delivery_id = ? AND status IN ('SENDING', 'PENDING', 'RETRY') AND destination_version = ?
            `).run(errorCode ? String(errorCode) : null, errorMessage ? String(errorMessage) : null, now, String(deliveryId), Number(expectedDestinationVersion));
        }
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?
            WHERE delivery_id = ? AND status IN ('SENDING', 'PENDING', 'RETRY')
        `).run(errorCode ? String(errorCode) : null, errorMessage ? String(errorMessage) : null, now, String(deliveryId));
    }

    countPendingDeliveriesForJob(jobId) {
        const row = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM verification_webhook_deliveries
            WHERE job_id = ? AND status IN ('PENDING', 'SENDING', 'RETRY')
        `).get(String(jobId));
        return row?.count || 0;
    }

    getJobDeliveryStats(jobId) {
        const rows = this.db.prepare(`
            SELECT status, COUNT(*) as count
            FROM verification_webhook_deliveries
            WHERE job_id = ?
            GROUP BY status
        `).all(String(jobId));

        const stats = {
            pending: 0,
            sending: 0,
            sent: 0,
            retry: 0,
            failed: 0,
            total: 0,
            get pendingCount() { return this.pending; },
            get sendingCount() { return this.sending; },
            get sentCount() { return this.sent; },
            get retryCount() { return this.retry; },
            get failedCount() { return this.failed; },
            get totalCount() { return this.total; }
        };
        for (const row of rows) {
            const key = String(row.status || "").toLowerCase();
            const cnt = Number(row.count) || 0;
            if (stats[key] !== undefined) {
                stats[key] = cnt;
            }
            stats.total += cnt;
        }
        return stats;
    }

    updateDeliverySentParts(deliveryId, sentParts, expectedDestinationVersion = null) {
        const now = Date.now();
        this.ensureDeliverySchema();
        if (expectedDestinationVersion !== null && Number(expectedDestinationVersion) > 0) {
            return this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET sent_parts = ?, updated_at = ?
                WHERE delivery_id = ? AND status != 'FAILED' AND destination_version = ?
            `).run(Math.max(0, Number(sentParts) || 0), now, String(deliveryId), Number(expectedDestinationVersion));
        }
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET sent_parts = ?, updated_at = ?
            WHERE delivery_id = ? AND status != 'FAILED'
        `).run(Math.max(0, Number(sentParts) || 0), now, String(deliveryId));
    }

    getDeliveryStats(guildId, destinationVersion = null) {
        const query = destinationVersion !== null
            ? `SELECT status, COUNT(*) as count FROM verification_webhook_deliveries WHERE guild_id = ? AND destination_version = ? GROUP BY status`
            : `SELECT status, COUNT(*) as count FROM verification_webhook_deliveries WHERE guild_id = ? GROUP BY status`;
        const params = destinationVersion !== null ? [String(guildId), Number(destinationVersion)] : [String(guildId)];
        const rows = this.db.prepare(query).all(...params);

        const stats = { pending: 0, sending: 0, sent: 0, retry: 0, failed: 0, total: 0 };
        for (const row of rows) {
            const key = String(row.status || "").toLowerCase();
            if (stats[key] !== undefined) {
                stats[key] = row.count;
            }
            stats.total += row.count;
        }
        return stats;
    }

    recoverStuckSendingDeliveries(maxAgeMs = 300000) {
        const now = Date.now();
        const cutoff = Number(maxAgeMs) <= 0 ? now : (now - Math.max(30000, Number(maxAgeMs) || 300000));
        return this.db.transaction(() => {
            const affectedRows = this.db.prepare(`
                SELECT DISTINCT guild_id
                FROM verification_webhook_deliveries
                WHERE status = 'SENDING' AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
            `).all(cutoff);
            const guildIds = affectedRows.map(r => String(r.guild_id));

            const stmt = this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'RETRY', next_retry_at = ?, error_code = 'sending_stuck_recovered', error_message = 'Recovered stuck SENDING delivery after timeout', updated_at = ?
                WHERE status = 'SENDING' AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
            `);
            const result = stmt.run(now, now, cutoff);
            const recoveredCount = result.changes;

            const resObj = {
                recoveredCount,
                guildIds,
                valueOf() { return this.recoveredCount; },
                [Symbol.toPrimitive](hint) { return this.recoveredCount; }
            };
            return resObj;
        })();
    }

    getNextRetryTimestamp(guildId) {
        const row = this.db.prepare(`
            SELECT MIN(next_retry_at) as next_retry
            FROM verification_webhook_deliveries
            WHERE guild_id = ? AND status = 'RETRY' AND next_retry_at IS NOT NULL
        `).get(String(guildId));
        return row?.next_retry || null;
    }

    getDeliveryById(deliveryId) {
        if (!deliveryId) return null;
        return this.db.prepare(`
            SELECT * FROM verification_webhook_deliveries
            WHERE delivery_id = ?
        `).get(String(deliveryId)) || null;
    }

    getDeliveryByEventId(guildId, destinationVersion, eventId) {
        return this.db.prepare(`
            SELECT * FROM verification_webhook_deliveries
            WHERE guild_id = ? AND destination_version = ? AND event_id = ?
            LIMIT 1
        `).get(String(guildId), Number(destinationVersion) || 1, String(eventId)) || null;
    }

    getPendingOrRetryGuildIds() {
        const now = Date.now();
        const rows = this.db.prepare(`
            SELECT DISTINCT guild_id
            FROM verification_webhook_deliveries
            WHERE (status = 'PENDING')
               OR (status = 'RETRY' AND (next_retry_at IS NULL OR next_retry_at <= ?))
        `).all(now);
        return rows.map(r => String(r.guild_id));
    }

    getAllRetryGuildIds() {
        const rows = this.db.prepare(`
            SELECT DISTINCT guild_id
            FROM verification_webhook_deliveries
            WHERE status = 'RETRY'
        `).all();
        return rows.map(r => String(r.guild_id));
    }

    getAllActiveJobs() {
        return this.db.prepare(`
            SELECT * FROM verification_webhook_jobs
            WHERE status IN ('RUNNING', 'PENDING')
        `).all();
    }
}

module.exports = {
    VerificationWebhookRepository,
    verificationWebhookRepository: new VerificationWebhookRepository()
};
