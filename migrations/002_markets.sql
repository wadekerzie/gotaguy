-- Migration 002: Add markets table and market_id to workers
-- Run in Supabase SQL editor or via migration script

-- 1. Markets table
CREATE TABLE IF NOT EXISTS markets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  twilio_number TEXT       NOT NULL UNIQUE,
  zip_codes    TEXT[]      NOT NULL DEFAULT '{}',
  domain       TEXT,
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Add market_id FK to workers
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS market_id UUID REFERENCES markets(id);

-- 3. Seed markets
INSERT INTO markets (name, twilio_number, zip_codes, domain)
VALUES
  (
    'McKinney',
    '+14692736216',
    ARRAY[
      '75069','75070','75071','75072',
      '75002','75013',
      '75023','75024','75025','75026','75074','75075','75086','75093','75094',
      '75078','75009','75098','75048',
      '75409','75454','75407','75166',
      '75080','75082'
    ],
    'gotaguymckinney.com'
  ),
  (
    'Aurora',
    '+17208213271',
    ARRAY[
      '80010','80011','80012','80013','80014','80015','80016','80017','80018',
      '80019','80040','80041','80042','80044','80045','80046','80047'
    ],
    'gotaguyaurora.com'
  )
ON CONFLICT (twilio_number) DO NOTHING;

-- 4. Backfill existing workers to McKinney market
UPDATE workers
SET market_id = (SELECT id FROM markets WHERE name = 'McKinney')
WHERE market_id IS NULL;
