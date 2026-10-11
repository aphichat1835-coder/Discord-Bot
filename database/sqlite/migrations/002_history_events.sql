-- ============================================================================
-- 002_history_events.sql
-- Migration 002: Operational and Runtime Event History
-- ============================================================================

-- Voice lifecycle events (buffered write-behind for deep retention without RAM bloat)
CREATE TABLE IF NOT EXISTS voice_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    account_id TEXT,
    guild_id TEXT,
    voice_id TEXT,
    detail TEXT,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_events_occurred ON voice_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_voice_events_session ON voice_events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_voice_events_guild ON voice_events(guild_id, occurred_at);

-- Slash and admin command execution events
CREATE TABLE IF NOT EXISTS command_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    command_name TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_command_events_occurred ON command_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_command_events_name ON command_events(command_name, occurred_at);

-- Worker session lifecycle events (created, connected, reconnecting, stopped, etc.)
CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    account_id TEXT,
    event_type TEXT NOT NULL,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_events_occurred ON session_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, occurred_at);

-- General runtime events (diagnostics, warnings, maintenance cycles)
CREATE TABLE IF NOT EXISTS runtime_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runtime_events_occurred ON runtime_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_runtime_events_cat ON runtime_events(category, occurred_at);
