-- 010_verification_webhook_delivery.sql
-- Migration 010: Verification Webhook Manager delivery queue, backfill jobs, checkpoints, and worker leases

CREATE TABLE IF NOT EXISTS verification_webhook_jobs (
    job_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    destination_version INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL, -- 'LIVE' or 'BACKFILL'
    status TEXT NOT NULL, -- 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED'
    total_eligible INTEGER DEFAULT 0,
    processed_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    last_cursor_verified_at INTEGER,
    last_cursor_id TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vwh_jobs_guild_status 
ON verification_webhook_jobs(guild_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vwh_single_active_job
ON verification_webhook_jobs(guild_id)
WHERE status IN ('RUNNING', 'PENDING');

CREATE TABLE IF NOT EXISTS verification_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    job_id TEXT,
    guild_id TEXT NOT NULL,
    destination_version INTEGER NOT NULL DEFAULT 1,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL, -- 'PENDING', 'SENDING', 'SENT', 'RETRY', 'FAILED'
    attempt_count INTEGER DEFAULT 0,
    next_retry_at INTEGER,
    last_attempt_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vwh_deliveries_queue
ON verification_webhook_deliveries(guild_id, status, next_retry_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vwh_deliveries_unique_dest_event
ON verification_webhook_deliveries(guild_id, destination_version, event_id);
