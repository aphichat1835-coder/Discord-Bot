"use strict";

const { getDatabase } = require("../../connection");

class JoinCampaignRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    // --- Job operations ---
    createJob(data) {
        const now = Date.now();
        const targetStatus = String(data.status || "STAGE");
        const isActiveStatus = ["RUNNING", "STAGE", "INTERRUPTED"].includes(targetStatus);

        const stmt = this.db.prepare(`
            INSERT INTO join_campaign_jobs (
                id, mode, source_guild_id, source_guild_name, target_guild_id, target_guild_name,
                status, requested_amount, selected_amount, joined_count, already_count, failed_count,
                processed_count, retry_count, current_concurrency, current_throughput, recovery_count, candidate_cursor, last_error,
                started_by_user_id, started_by_channel_id, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const runCreate = this.db.transaction(() => {
            if (isActiveStatus) {
                const active = this.findActiveRunningJob();
                if (active) {
                    const err = new Error("มีงานดึงสมาชิกกำลังทำงานอยู่แล้วในระบบ");
                    err.code = "ACTIVE_CAMPAIGN_EXISTS";
                    throw err;
                }
            }

            stmt.run(
                String(data.id),
                String(data.mode || "ALL_TO_TARGET"),
                data.sourceGuildId ? String(data.sourceGuildId) : null,
                data.sourceGuildName ? String(data.sourceGuildName) : null,
                String(data.targetGuildId),
                data.targetGuildName ? String(data.targetGuildName) : null,
                targetStatus,
                Number(data.requestedAmount) || 0,
                Number(data.selectedAmount) || 0,
                Number(data.joinedCount) || 0,
                Number(data.alreadyCount) || 0,
                Number(data.failedCount) || 0,
                Number(data.processedCount) || 0,
                Number(data.retryCount) || 0,
                Number(data.currentConcurrency) || 8,
                Number(data.currentThroughput) || 0.0,
                Number(data.recoveryCount) || 0,
                data.candidateCursor ? String(data.candidateCursor) : null,
                data.lastError ? String(data.lastError) : null,
                data.startedByUserId ? String(data.startedByUserId) : null,
                data.startedByChannelId ? String(data.startedByChannelId) : null,
                Number(data.createdAt) || now,
                Number(data.updatedAt) || now,
                data.completedAt ? Number(data.completedAt) : null
            );
        });

        runCreate();
        return this.findJobById(data.id);
    }

    findJobById(id) {
        const row = this.db.prepare("SELECT * FROM join_campaign_jobs WHERE id = ?").get(String(id));
        return row ? this._hydrateJob(row) : null;
    }

    findActiveRunningJob() {
        const row = this.db.prepare(`
            SELECT * FROM join_campaign_jobs 
            WHERE status IN ('RUNNING', 'STAGE', 'INTERRUPTED') 
            ORDER BY created_at DESC 
            LIMIT 1
        `).get();
        return row ? this._hydrateJob(row) : null;
    }

    getActiveJob() {
        return this.findActiveRunningJob();
    }

    hasActiveJob() {
        return Boolean(this.findActiveRunningJob());
    }

    savePanelState(data) {
        return this.savePanel(data);
    }

    markJobCompleted(id) {
        return this.updateJob(id, { status: "COMPLETED", completedAt: Date.now() });
    }

    markJobFailed(id, lastError = null) {
        return this.updateJob(id, { status: "FAILED", lastError, completedAt: Date.now() });
    }

    updateJobProgress(id, progress = {}) {
        return this.updateJob(id, progress);
    }

    updateJob(id, updates = {}) {
        const now = Date.now();
        const setClauses = ["updated_at = ?"];
        const params = [now];

        if (updates.status !== undefined) {
            setClauses.push("status = ?");
            params.push(String(updates.status));
        }
        if (updates.joinedCount !== undefined) {
            setClauses.push("joined_count = ?");
            params.push(Number(updates.joinedCount));
        }
        if (updates.alreadyCount !== undefined) {
            setClauses.push("already_count = ?");
            params.push(Number(updates.alreadyCount));
        }
        if (updates.failedCount !== undefined) {
            setClauses.push("failed_count = ?");
            params.push(Number(updates.failedCount));
        }
        if (updates.processedCount !== undefined) {
            setClauses.push("processed_count = ?");
            params.push(Number(updates.processedCount));
        }
        if (updates.retryCount !== undefined) {
            setClauses.push("retry_count = ?");
            params.push(Number(updates.retryCount));
        }
        if (updates.currentConcurrency !== undefined) {
            setClauses.push("current_concurrency = ?");
            params.push(Number(updates.currentConcurrency));
        }
        const throughput = updates.currentThroughput !== undefined ? updates.currentThroughput : updates.current_throughput;
        if (throughput !== undefined) {
            setClauses.push("current_throughput = ?");
            params.push(Number(throughput) || 0.0);
        }
        const recCount = updates.recoveryCount !== undefined ? updates.recoveryCount : updates.recovery_count;
        if (recCount !== undefined) {
            setClauses.push("recovery_count = ?");
            params.push(Number(recCount));
        }
        if (updates.candidateCursor !== undefined) {
            setClauses.push("candidate_cursor = ?");
            params.push(updates.candidateCursor ? String(updates.candidateCursor) : null);
        }
        const lastErr = updates.lastError !== undefined ? updates.lastError : updates.last_error;
        if (lastErr !== undefined) {
            setClauses.push("last_error = ?");
            params.push(lastErr ? String(lastErr) : null);
        }
        if (updates.startedByChannelId !== undefined) {
            setClauses.push("started_by_channel_id = ?");
            params.push(updates.startedByChannelId ? String(updates.startedByChannelId) : null);
        }
        if (updates.completedAt !== undefined) {
            setClauses.push("completed_at = ?");
            params.push(updates.completedAt ? Number(updates.completedAt) : null);
        }

        params.push(String(id));
        this.db.prepare(`UPDATE join_campaign_jobs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
        return this.findJobById(id);
    }

    claimInterruptedJob(jobId) {
        const now = Date.now();
        const info = this.db.prepare(`
            UPDATE join_campaign_jobs
            SET status = 'RUNNING', updated_at = ?
            WHERE id = ? AND status = 'INTERRUPTED'
        `).run(now, String(jobId));
        return info.changes > 0;
    }

    claimOrphanedRunningJob(jobId) {
        const now = Date.now();
        const info = this.db.prepare(`
            UPDATE join_campaign_jobs
            SET status = 'INTERRUPTED', updated_at = ?
            WHERE id = ? AND status = 'RUNNING'
        `).run(now, String(jobId));
        return info.changes > 0;
    }

    reconcileJobCounters(jobId) {
        const stats = this.db.prepare(`
            SELECT 
                COUNT(CASE WHEN status = 'joined' THEN 1 END) as joined_count,
                COUNT(CASE WHEN status = 'already_member' THEN 1 END) as already_count,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
                COUNT(CASE WHEN processing_started_at IS NOT NULL OR status IN ('joined', 'already_member', 'failed') OR attempts > 0 THEN 1 END) as processed_count,
                COALESCE(SUM(CASE WHEN attempts > 1 THEN attempts - 1 ELSE 0 END), 0) as retry_count
            FROM join_campaign_items
            WHERE campaign_id = ?
        `).get(String(jobId));

        const joined = Number(stats?.joined_count) || 0;
        const already = Number(stats?.already_count) || 0;
        const failed = Number(stats?.failed_count) || 0;
        const processed = Number(stats?.processed_count) || 0;
        const retries = Number(stats?.retry_count) || 0;

        this.db.prepare(`
            UPDATE join_campaign_jobs
            SET joined_count = ?,
                already_count = ?,
                failed_count = ?,
                processed_count = ?,
                retry_count = MAX(retry_count, ?),
                updated_at = ?
            WHERE id = ?
        `).run(joined, already, failed, processed, retries, Date.now(), String(jobId));

        return this.findJobById(jobId);
    }

    listRecentJobs({ limit = 20, offset = 0 } = {}) {
        const rows = this.db.prepare(`
            SELECT * FROM join_campaign_jobs 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `).all(limit, offset);
        return rows.map(r => this._hydrateJob(r));
    }

    getMetrics() {
        const totals = this.db.prepare(`
            SELECT 
                COUNT(*) as total_campaigns,
                COALESCE(SUM(joined_count), 0) as total_joined,
                COALESCE(SUM(already_count), 0) as total_already,
                COALESCE(SUM(processed_count), 0) as total_processed,
                COALESCE(SUM(failed_count), 0) as total_failed
            FROM join_campaign_jobs
        `).get();

        const totalCampaigns = Number(totals?.total_campaigns) || 0;
        const totalJoined = Number(totals?.total_joined) || 0;
        const totalAlready = Number(totals?.total_already) || 0;
        const totalProcessed = Number(totals?.total_processed) || 0;
        const totalFailed = Number(totals?.total_failed) || 0;
        const successRatePercent = totalProcessed > 0
            ? Math.round((totalJoined / totalProcessed) * 100)
            : (totalCampaigns > 0 ? 100 : 0);

        return {
            totalJobs: totalCampaigns,
            totalCampaigns,
            totalJoined,
            totalAlready,
            totalProcessed,
            totalFailed,
            successRatePercent
        };
    }

    // --- Candidate Items operations ---
    createItems(campaignId, items = []) {
        if (!items || items.length === 0) return 0;
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO join_campaign_items (
                campaign_id, user_id, token_field, status, attempts, last_error, leased_until, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', 0, NULL, 0, ?, ?)
        `);

        const insertMany = this.db.transaction((records) => {
            let count = 0;
            for (const item of records) {
                const tokenField = String(item.tokenField || "").trim();
                if (tokenField !== "oauth" && tokenField !== "adminOAuth") {
                    continue; // Skip invalid token field - fail-closed
                }
                const info = stmt.run(String(campaignId), String(item.userId), tokenField, now, now);
                if (info && info.changes > 0) {
                    count++;
                }
            }
            return count;
        });

        return insertMany(items);
    }

    claimNextPendingItem(campaignId, leaseDurationMs = 30000) {
        const now = Date.now();
        const leaseUntil = now + leaseDurationMs;

        const updateStmt = this.db.prepare(`
            UPDATE join_campaign_items
            SET status = 'processing',
                leased_until = ?,
                processing_started_at = COALESCE(processing_started_at, ?),
                attempts = CASE WHEN attempts = 0 THEN 1 ELSE attempts END,
                updated_at = ?
            WHERE id = (
                SELECT id FROM join_campaign_items
                WHERE campaign_id = ? AND (
                    (status = 'pending' AND (leased_until IS NULL OR leased_until <= ?))
                    OR
                    (status = 'processing' AND leased_until < ?)
                )
                ORDER BY id ASC
                LIMIT 1
            )
            RETURNING *
        `);

        try {
            const row = updateStmt.get(leaseUntil, now, now, String(campaignId), now, now);
            return row ? this._hydrateItem(row) : null;
        } catch (_) {
            const findStmt = this.db.prepare(`
                SELECT id FROM join_campaign_items
                WHERE campaign_id = ? AND (
                    (status = 'pending' AND (leased_until IS NULL OR leased_until <= ?))
                    OR
                    (status = 'processing' AND leased_until < ?)
                )
                ORDER BY id ASC
                LIMIT 1
            `);
            const item = findStmt.get(String(campaignId), now, now);
            if (!item) return null;

            this.db.prepare(`
                UPDATE join_campaign_items
                SET status = 'processing',
                    leased_until = ?,
                    processing_started_at = COALESCE(processing_started_at, ?),
                    attempts = CASE WHEN attempts = 0 THEN 1 ELSE attempts END,
                    updated_at = ?
                WHERE id = ?
            `).run(leaseUntil, now, now, item.id);

            const row = this.db.prepare("SELECT * FROM join_campaign_items WHERE id = ?").get(item.id);
            return row ? this._hydrateItem(row) : null;
        }
    }

    updateItemStatus(campaignId, userId, status, error = null) {
        const now = Date.now();
        if (status === "pending") {
            this.db.prepare(`
                UPDATE join_campaign_items
                SET status = 'pending',
                    last_error = ?,
                    leased_until = 0,
                    processing_started_at = NULL,
                    attempts = 0,
                    completed_at = NULL,
                    updated_at = ?
                WHERE campaign_id = ? AND user_id = ?
            `).run(error ? String(error) : null, now, String(campaignId), String(userId));
            return;
        }
        this.db.prepare(`
            UPDATE join_campaign_items
            SET status = ?, last_error = ?, leased_until = 0, completed_at = ?, updated_at = ?
            WHERE campaign_id = ? AND user_id = ?
        `).run(String(status), error ? String(error) : null, now, now, String(campaignId), String(userId));
    }

    incrementItemAttempt(campaignId, userId, error = null, retryDelayMs = 0) {
        const now = Date.now();
        const leaseUntil = now + retryDelayMs;
        this.db.prepare(`
            UPDATE join_campaign_items
            SET attempts = attempts + 1, last_error = ?, status = 'pending', leased_until = ?, updated_at = ?
            WHERE campaign_id = ? AND user_id = ?
        `).run(error ? String(error) : null, leaseUntil, now, String(campaignId), String(userId));
    }

    renewItemLease(campaignId, userId, extensionMs = 60000) {
        const now = Date.now();
        const ext = Math.max(1000, Number(extensionMs) || 60000);
        const info = this.db.prepare(`
            UPDATE join_campaign_items
            SET leased_until = MAX(COALESCE(leased_until, 0), ?) + ?, updated_at = ?
            WHERE campaign_id = ? AND user_id = ? AND status = 'processing'
        `).run(now, ext, now, String(campaignId), String(userId));
        return info.changes > 0;
    }

    releaseExpiredLeases(campaignId, force = false) {
        const now = Date.now();
        const info = this.db.prepare(`
            UPDATE join_campaign_items
            SET status = 'pending', leased_until = 0, updated_at = ?
            WHERE campaign_id = ? AND status = 'processing' ${force ? "" : "AND leased_until < ?"}
        `).run(...(force ? [now, String(campaignId)] : [now, String(campaignId), now]));
        return info.changes;
    }

    countPendingItems(campaignId, status = "pending") {
        let sql = "SELECT COUNT(*) as count FROM join_campaign_items WHERE campaign_id = ?";
        const params = [String(campaignId)];
        if (status === "all" || status === "active") {
            sql += " AND (status = 'pending' OR status = 'processing')";
        } else if (status) {
            sql += " AND status = ?";
            params.push(String(status));
        }
        const row = this.db.prepare(sql).get(...params);
        return Number(row?.count) || 0;
    }

    getTrackedUserIds(campaignId) {
        const rows = this.db.prepare(`
            SELECT user_id FROM join_campaign_items
            WHERE campaign_id = ?
        `).all(String(campaignId));
        return new Set(rows.map(r => r.user_id));
    }

    getCompletedUserIds(campaignId) {
        return this.getTrackedUserIds(campaignId);
    }

    getProcessedUserIds(campaignId) {
        const rows = this.db.prepare(`
            SELECT user_id FROM join_campaign_items
            WHERE campaign_id = ? AND (processing_started_at IS NOT NULL OR status IN ('joined', 'already_member', 'failed') OR attempts > 0)
        `).all(String(campaignId));
        return new Set(rows.map(r => r.user_id));
    }

    // --- Panel State Operations ---
    savePanel(data) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO join_campaign_panels (
                message_id, channel_id, guild_id, mode, source_guild_id, target_guild_id,
                active_job_id, requested_amount, last_ready_count, last_status_summary, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                channel_id = excluded.channel_id,
                guild_id = excluded.guild_id,
                mode = excluded.mode,
                source_guild_id = excluded.source_guild_id,
                target_guild_id = excluded.target_guild_id,
                active_job_id = excluded.active_job_id,
                requested_amount = excluded.requested_amount,
                last_ready_count = excluded.last_ready_count,
                last_status_summary = excluded.last_status_summary,
                updated_at = excluded.updated_at
        `);

        stmt.run(
            String(data.messageId),
            String(data.channelId),
            String(data.guildId),
            String(data.mode || "ALL_TO_TARGET"),
            data.sourceGuildId ? String(data.sourceGuildId) : null,
            data.targetGuildId ? String(data.targetGuildId) : null,
            data.activeJobId ? String(data.activeJobId) : null,
            data.requestedAmount !== undefined && data.requestedAmount !== null ? Number(data.requestedAmount) : null,
            data.lastReadyCount !== undefined && data.lastReadyCount !== null
                ? Number(data.lastReadyCount)
                : (data.readyCount !== undefined && data.readyCount !== null ? Number(data.readyCount) : null),
            data.lastStatusSummary ? String(data.lastStatusSummary) : null,
            now
        );

        return this.findPanelByMessageId(data.messageId);
    }

    findPanelByMessageId(messageId) {
        const row = this.db.prepare("SELECT * FROM join_campaign_panels WHERE message_id = ?").get(String(messageId));
        return row ? this._hydratePanel(row) : null;
    }

    findPanelByChannelId(channelId) {
        const row = this.db.prepare("SELECT * FROM join_campaign_panels WHERE channel_id = ? ORDER BY updated_at DESC LIMIT 1").get(String(channelId));
        return row ? this._hydratePanel(row) : null;
    }

    findPanelByActiveJobId(jobId) {
        if (!jobId) return null;
        const row = this.db.prepare("SELECT * FROM join_campaign_panels WHERE active_job_id = ? ORDER BY updated_at DESC LIMIT 1").get(String(jobId));
        return row ? this._hydratePanel(row) : null;
    }

    deletePanelByChannelId(channelId) {
        const info = this.db.prepare("DELETE FROM join_campaign_panels WHERE channel_id = ?").run(String(channelId));
        return info.changes;
    }

    deletePanelByMessageId(messageId) {
        const info = this.db.prepare("DELETE FROM join_campaign_panels WHERE message_id = ?").run(String(messageId));
        return info.changes;
    }

    // --- Hydration Helpers ---
    _hydrateJob(row) {
        return {
            id: row.id,
            mode: row.mode,
            sourceGuildId: row.source_guild_id,
            sourceGuildName: row.source_guild_name,
            targetGuildId: row.target_guild_id,
            targetGuildName: row.target_guild_name,
            status: row.status,
            requestedAmount: row.requested_amount,
            selectedAmount: row.selected_amount,
            joinedCount: row.joined_count,
            alreadyCount: row.already_count,
            failedCount: row.failed_count,
            processedCount: row.processed_count,
            retryCount: row.retry_count,
            currentConcurrency: row.current_concurrency ?? 8,
            currentThroughput: Number(row.current_throughput || 0),
            recoveryCount: row.recovery_count ?? 0,
            candidateCursor: row.candidate_cursor ?? null,
            lastError: row.last_error ?? null,
            startedByUserId: row.started_by_user_id,
            startedByChannelId: row.started_by_channel_id ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            completedAt: row.completed_at
        };
    }

    _hydrateItem(row) {
        return {
            id: row.id,
            campaignId: row.campaign_id,
            userId: row.user_id,
            tokenField: row.token_field,
            status: row.status,
            attempts: row.attempts,
            lastError: row.last_error,
            leasedUntil: row.leased_until,
            processingStartedAt: row.processing_started_at ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            completedAt: row.completed_at
        };
    }

    _hydratePanel(row) {
        return {
            messageId: row.message_id,
            channelId: row.channel_id,
            guildId: row.guild_id,
            mode: row.mode,
            sourceGuildId: row.source_guild_id,
            targetGuildId: row.target_guild_id,
            activeJobId: row.active_job_id,
            requestedAmount: row.requested_amount,
            lastReadyCount: row.last_ready_count,
            readyCount: row.last_ready_count,
            lastStatusSummary: row.last_status_summary,
            updatedAt: row.updated_at
        };
    }
}

module.exports = JoinCampaignRepository;
