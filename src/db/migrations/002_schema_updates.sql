-- Session 2 schema updates
-- Invoice fields are stored in JSONB - no column migration needed
-- Add workers(status) index for roster queries

CREATE INDEX IF NOT EXISTS idx_workers_status ON workers (status);
