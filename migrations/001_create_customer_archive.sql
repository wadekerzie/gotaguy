-- Run this once in the Supabase SQL editor.
-- Creates the customer_archive table to store closed customer rows
-- before they are replaced by a new job from the same phone number.

CREATE TABLE IF NOT EXISTS customer_archive (
  id           UUID        NOT NULL,
  phone        TEXT        NOT NULL,
  short_id     INTEGER,
  status       TEXT,
  data         JSONB,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_archive_phone_idx ON customer_archive (phone);
CREATE INDEX IF NOT EXISTS customer_archive_archived_at_idx ON customer_archive (archived_at);
