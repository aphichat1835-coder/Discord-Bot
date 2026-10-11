-- 008_join_campaign_channel_persistence.sql
-- Migration 008: Persist started_by_channel_id on join_campaign_jobs for Discord panel reconnect and recovery

ALTER TABLE join_campaign_jobs ADD COLUMN started_by_channel_id TEXT;
