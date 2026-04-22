-- Migration 003: Add TOS agreement fields to workers
-- Run in Supabase SQL editor before deploying the pending_tos flow

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS tos_agreed     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tos_agreed_at  TIMESTAMPTZ;

-- Backfill all contractors already in the pipeline so the guard in
-- sendStripeOnboarding does not retroactively block them.
-- Covers pending_stripe (Yoni, Tony), active, busy, and inactive workers.
-- lead workers remain tos_agreed = false — they have not been onboarded.
UPDATE workers
SET tos_agreed    = true,
    tos_agreed_at = now()
WHERE status IN ('pending_stripe', 'active', 'busy', 'inactive')
  AND tos_agreed = false;
