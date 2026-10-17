-- 006_join_campaign_hardening.sql
-- Migration 006: Join Campaign Hardening (Concurrency, Recovery Tracking, Checkpoint Cursor, and Panel Association)

ALTER TABLE join_campaign_jobs ADD COLUMN current_concurrency INTEGER NOT NULL DEFAULT 8;
ALTER TABLE join_campaign_jobs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_campaign_jobs ADD COLUMN candidate_cursor TEXT;
ALTER TABLE join_campaign_jobs ADD COLUMN last_error TEXT;

ALTER TABLE join_campaign_items ADD COLUMN completed_at INTEGER;

ALTER TABLE join_campaign_panels ADD COLUMN active_job_id TEXT;
ALTER TABLE join_campaign_panels ADD COLUMN requested_amount INTEGER;
