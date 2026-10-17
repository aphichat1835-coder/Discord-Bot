-- 005_join_campaign.sql
-- Migration 005: Join Campaign Subsystem Persistence (Jobs, Candidate Items, Panels)

CREATE TABLE IF NOT EXISTS join_campaign_jobs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'ALL_TO_TARGET',
    source_guild_id TEXT,
    source_guild_name TEXT,
    target_guild_id TEXT NOT NULL,
    target_guild_name TEXT,
    status TEXT NOT NULL, -- 'STAGE', 'RUNNING', 'COMPLETED', 'FAILED'
    requested_amount INTEGER NOT NULL,
    selected_amount INTEGER NOT NULL,
    joined_count INTEGER NOT NULL DEFAULT 0,
    already_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    webhook_url TEXT,
    started_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS join_campaign_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_field TEXT NOT NULL DEFAULT 'oauth',
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'joined', 'already_member', 'failed'
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    leased_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS join_campaign_panels (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'ALL_TO_TARGET',
    source_guild_id TEXT,
    target_guild_id TEXT,
    last_ready_count INTEGER,
    last_status_summary TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_join_jobs_status 
ON join_campaign_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_join_jobs_created 
ON join_campaign_jobs(created_at);

CREATE INDEX IF NOT EXISTS idx_join_items_claim 
ON join_campaign_items(campaign_id, status, leased_until);

CREATE INDEX IF NOT EXISTS idx_join_panels_channel 
ON join_campaign_panels(channel_id);
