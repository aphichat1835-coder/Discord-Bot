-- ============================================================================
-- 012_verification_webhook_sent_parts.sql
-- Migration 012: Add sent_parts tracking to verification_webhook_deliveries
-- ============================================================================

ALTER TABLE verification_webhook_deliveries ADD COLUMN sent_parts INTEGER DEFAULT 0;
