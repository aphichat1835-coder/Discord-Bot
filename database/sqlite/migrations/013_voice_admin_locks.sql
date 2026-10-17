-- ============================================================================
-- 013_voice_admin_locks.sql
-- Migration 013: Voice Admin subsystem locks and unauthorized notice tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_admin_locks (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mute_locked INTEGER NOT NULL DEFAULT 0,
    deaf_locked INTEGER NOT NULL DEFAULT 0,
    mute_locked_by TEXT,
    deaf_locked_by TEXT,
    mute_locked_at INTEGER,
    deaf_locked_at INTEGER,
    mute_version TEXT,
    deaf_version TEXT,
    mute_owner_forced INTEGER NOT NULL DEFAULT 0,
    locked_by TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_admin_locks_guild_id ON voice_admin_locks(guild_id);

CREATE TABLE IF NOT EXISTS voice_admin_notices (
    guild_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    notified_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_admin_notices_notified_at ON voice_admin_notices(notified_at);
CREATE INDEX IF NOT EXISTS idx_voice_admin_notices_guild_target ON voice_admin_notices(guild_id, target_id);
