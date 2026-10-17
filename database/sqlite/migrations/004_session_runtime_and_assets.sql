-- 004_session_runtime_and_assets.sql
-- Migration 004: Voice Session Runtime Heartbeats and Disk-Backed Asset Cache Metadata

-- 1. Voice Session Runtime Table (Offloading 60s heartbeats and active runtime state from MongoDB Atlas)
CREATE TABLE IF NOT EXISTS voice_session_runtime (
    session_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    state TEXT NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    reconnect_count INTEGER DEFAULT 0,
    status_label TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_session_runtime_server_owner 
ON voice_session_runtime(server_id, owner_id);

CREATE INDEX IF NOT EXISTS idx_voice_session_runtime_heartbeat 
ON voice_session_runtime(last_heartbeat);

-- 2. Upgrade asset_cache to lean filesystem metadata (dropping binary BLOB storage)
DROP TABLE IF EXISTS asset_cache;

CREATE TABLE IF NOT EXISTS asset_cache (
    asset_key TEXT PRIMARY KEY,
    asset_type TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_cache_expires 
ON asset_cache(expires_at);

CREATE INDEX IF NOT EXISTS idx_asset_cache_last_used 
ON asset_cache(last_used_at);
