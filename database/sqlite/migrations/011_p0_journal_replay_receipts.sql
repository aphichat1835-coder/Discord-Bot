-- ============================================================================
-- 011_p0_journal_replay_receipts.sql
-- Migration 011: Idempotency receipts for P0 emergency journal replay
-- ============================================================================

CREATE TABLE IF NOT EXISTS p0_journal_receipts (
    entry_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    replayed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_p0_journal_receipts_replayed ON p0_journal_receipts(replayed_at);
