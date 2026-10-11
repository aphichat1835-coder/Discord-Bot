"use strict";

const { getDatabase } = require("../../connection");

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

    updateJobProgress(jobId, {
        processedCount,
        successCount,
        failureCount,
        retryCount,
        lastCursorVerifiedAt = null,
        lastCursorId = null
    }) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET processed_count = COALESCE(?, processed_count),
                success_count = COALESCE(?, success_count),
                failure_count = COALESCE(?, failure_count),
                retry_count = COALESCE(?, retry_count),
                last_cursor_verified_at = COALESCE(?, last_cursor_verified_at),
                last_cursor_id = COALESCE(?, last_cursor_id),
                updated_at = ?
            WHERE job_id = ?
        `);
        return stmt.run(
            processedCount !== undefined ? Number(processedCount) : null,
            successCount !== undefined ? Number(successCount) : null,
            failureCount !== undefined ? Number(failureCount) : null,
            retryCount !== undefined ? Number(retryCount) : null,
            lastCursorVerifiedAt !== null ? Number(lastCursorVerifiedAt) : null,
            lastCursorId !== null ? String(lastCursorId) : null,
            now,
            String(jobId)
        );
    }

    acquireJobLease(jobId, leaseToken, ttlMs = 30000) {
        const now = Date.now();
        const expiresAt = now + ttlMs;
        const stmt = this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET lease_token = ?, lease_expires_at = ?, updated_at = ?
            WHERE job_id = ? AND (lease_token IS NULL OR lease_expires_at < ? OR lease_token = ?)
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
            WHERE job_id = ? AND lease_token = ?
        `);
        const result = stmt.run(expiresAt, now, String(jobId), String(leaseToken));
        return result.changes > 0;
    }

    completeJob(jobId) {
        const now = Date.now();
        return this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET status = 'COMPLETED', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE job_id = ?
        `).run(now, now, String(jobId));
    }

    failJob(jobId, errorMessage) {
        const now = Date.now();
        return this.db.prepare(`
            UPDATE verification_webhook_jobs
            SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL, error_message = ?, updated_at = ?
            WHERE job_id = ?
        `).run(String(errorMessage || "unknown_error"), now, String(jobId));
    }

    enqueueDelivery({
        deliveryId,
        jobId = null,
        guildId,
        destinationVersion = 1,
        eventId,
        userId
    }) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO verification_webhook_deliveries (
                delivery_id, job_id, guild_id, destination_version, event_id,
                user_id, status, attempt_count, next_retry_at, last_attempt_at,
                error_code, error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, NULL, ?, ?)
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

    claimNextDeliveries(guildId, limit = 10) {
        const now = Date.now();
        const selectStmt = this.db.prepare(`
            SELECT * FROM verification_webhook_deliveries
            WHERE guild_id = ? AND status IN ('PENDING', 'RETRY') AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY created_at ASC
            LIMIT ?
        `);

        return this.db.transaction(() => {
            const rows = selectStmt.all(String(guildId), now, Math.max(1, Number(limit) || 10));
            if (!rows.length) return [];
            const markStmt = this.db.prepare(`
                UPDATE verification_webhook_deliveries
                SET status = 'SENDING', last_attempt_at = ?, attempt_count = attempt_count + 1, updated_at = ?
                WHERE delivery_id = ?
            `);
            for (const row of rows) {
                markStmt.run(now, now, row.delivery_id);
            }
            return rows;
        })();
    }

    markDeliverySent(deliveryId) {
        const now = Date.now();
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'SENT', error_code = NULL, error_message = NULL, updated_at = ?
            WHERE delivery_id = ?
        `).run(now, String(deliveryId));
    }

    markDeliveryRetry(deliveryId, delayMs = 5000, errorCode = null, errorMessage = null) {
        const now = Date.now();
        const nextRetry = now + Math.max(1000, Number(delayMs) || 5000);
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'RETRY', next_retry_at = ?, error_code = ?, error_message = ?, updated_at = ?
            WHERE delivery_id = ?
        `).run(nextRetry, errorCode ? String(errorCode) : null, errorMessage ? String(errorMessage) : null, now, String(deliveryId));
    }

    markDeliveryFailed(deliveryId, errorCode = null, errorMessage = null) {
        const now = Date.now();
        return this.db.prepare(`
            UPDATE verification_webhook_deliveries
            SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?
            WHERE delivery_id = ?
        `).run(errorCode ? String(errorCode) : null, errorMessage ? String(errorMessage) : null, now, String(deliveryId));
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
}

module.exports = {
    VerificationWebhookRepository,
    verificationWebhookRepository: new VerificationWebhookRepository()
};
