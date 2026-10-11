-- 009_join_campaign_crash_consistency.sql
-- Migration 009: Track item processing start timestamp for crash consistency, and include INTERRUPTED in single active job constraint

ALTER TABLE join_campaign_items ADD COLUMN processing_started_at INTEGER;

DROP INDEX IF EXISTS idx_join_campaign_single_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_join_campaign_single_active 
ON join_campaign_jobs((1)) 
WHERE status IN ('RUNNING', 'STAGE', 'INTERRUPTED');
