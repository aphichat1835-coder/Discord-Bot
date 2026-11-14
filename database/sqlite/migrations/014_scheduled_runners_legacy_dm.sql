-- ============================================================================
-- 014_scheduled_runners_legacy_dm.sql
-- Migration 014: Normalize legacy scheduled runners channel_id to 'dm'
-- In versions prior to explicit log channel selection, scheduled runners
-- stored the panel interaction channelId while exclusively outputting to DM.
-- To prevent unsolicited log output into guild channels upon restoring legacy
-- runners, normalize pre-existing channel_id values to 'dm'.
-- ============================================================================

UPDATE scheduled_runners
SET channel_id = 'dm'
WHERE channel_id != 'dm' AND channel_id IS NOT NULL;
