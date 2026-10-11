-- ============================================================================
-- 003_cache_subsystem.sql
-- Migration 003: Generic Persistent Cache & Asset Registry
-- ============================================================================

-- Generic persistent cache with namespace isolation, TTL, and LRU metadata
CREATE TABLE IF NOT EXISTS cache_entries (
    namespace TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/json',
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_accessed_at INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    metadata_json TEXT,
    PRIMARY KEY (namespace, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_cache_entries_expires ON cache_entries(namespace, expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_entries_lru ON cache_entries(namespace, last_accessed_at);

-- External asset metadata registry (avatars, icons, badges stored in SQLITE_ASSET_DIR)
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
    expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_asset_cache_expires ON asset_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_asset_cache_lru ON asset_cache(last_used_at);
