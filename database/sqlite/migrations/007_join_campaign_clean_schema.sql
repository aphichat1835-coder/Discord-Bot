-- 007_join_campaign_clean_schema.sql
-- Migration 007: Drop legacy webhook_url column, enforce single active campaign constraint, and add throughput telemetry

ALTER TABLE join_campaign_jobs DROP COLUMN webhook_url;

ALTER TABLE join_campaign_jobs ADD COLUMN current_throughput REAL NOT NULL DEFAULT 0.0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_join_campaign_single_active 
ON join_campaign_jobs((1)) 
WHERE status IN ('RUNNING', 'STAGE');
