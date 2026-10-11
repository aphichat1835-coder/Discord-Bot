-- ============================================================================
-- 001_initial_core.sql
-- Migration 001: Core Operational Tables, Metadata, and Ephemeral Verification State
-- ============================================================================

-- Database metadata
CREATE TABLE IF NOT EXISTS database_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Schema migration registry
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    app_version TEXT NOT NULL
);

-- Operational maintenance log
CREATE TABLE IF NOT EXISTS maintenance_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    details_json TEXT
);

-- ----------------------------------------------------------------------------
-- Core 1: Quest Execution Logs (Relational split: Logs -> Accounts -> Details)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quest_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoker_id TEXT NOT NULL,
    invoker_tag TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    total_tokens INTEGER DEFAULT 0,
    overall_status TEXT NOT NULL DEFAULT 'in_progress',
    dm_delivered INTEGER DEFAULT 0,
    dm_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quest_logs_invoker_id ON quest_logs(invoker_id);
CREATE INDEX IF NOT EXISTS idx_quest_logs_created_at ON quest_logs(created_at);

CREATE TABLE IF NOT EXISTS quest_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER NOT NULL REFERENCES quest_logs(id) ON DELETE CASCADE,
    account_index INTEGER NOT NULL DEFAULT 0,
    target_user_id TEXT,
    target_username TEXT,
    masked_token TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    quests_found INTEGER DEFAULT 0,
    quests_completed INTEGER DEFAULT 0,
    error_message TEXT,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_quest_accounts_log_id ON quest_accounts(log_id);

CREATE TABLE IF NOT EXISTS quest_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES quest_accounts(id) ON DELETE CASCADE,
    detail_index INTEGER NOT NULL DEFAULT 0,
    quest_id TEXT NOT NULL DEFAULT '',
    quest_name TEXT NOT NULL DEFAULT '',
    event_name TEXT NOT NULL DEFAULT '',
    progress INTEGER DEFAULT 0,
    target INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    claimed INTEGER DEFAULT 0,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_quest_details_account_id ON quest_details(account_id);

-- ----------------------------------------------------------------------------
-- Core 2: Scheduled Quest Runners
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    username TEXT DEFAULT '',
    token_ciphertext TEXT NOT NULL,
    token_iv TEXT NOT NULL,
    token_tag TEXT NOT NULL,
    token_salt TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'scheduled',
    enabled INTEGER NOT NULL DEFAULT 1,
    next_check_at INTEGER,
    last_check_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_runners_owner_account ON scheduled_runners(owner_id, account_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_runners_next_check ON scheduled_runners(next_check_at, enabled);

-- ----------------------------------------------------------------------------
-- Core 3: DM Notification Queue
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dm_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    recipient_id TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    priority_rank INTEGER NOT NULL DEFAULT 2,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    sent_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_notifications_queue ON dm_notifications(status, next_attempt_at, priority_rank, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_notifications_recipient ON dm_notifications(recipient_id);
CREATE INDEX IF NOT EXISTS idx_dm_notifications_expires_at ON dm_notifications(expires_at);

-- ----------------------------------------------------------------------------
-- Core 4: Verification Recovery State
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_recovery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT,
    result TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    persistence_json TEXT,
    role_applied INTEGER DEFAULT 0,
    rollback_attempted INTEGER DEFAULT 0,
    rollback_succeeded INTEGER DEFAULT 0,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_recovery_status_updated ON verification_recovery(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_verification_recovery_guild_user ON verification_recovery(guild_id, user_id);

-- ----------------------------------------------------------------------------
-- Temp 1: Verification State Nonce (Ephemeral OAuth state with TTL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_state_nonce (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nonce_hash TEXT NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    expected_user_id TEXT,
    panel_revision TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_nonce_expires ON verification_state_nonce(expires_at);
CREATE INDEX IF NOT EXISTS idx_verification_nonce_guild ON verification_state_nonce(guild_id);
