-- GotaGuy initial schema
-- Customers and Workers tables with JSONB data columns

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN (
      'new', 'scoping', 'quoting', 'scheduling', 'agreed',
      'card_captured', 'dispatched', 'active', 'complete', 'closed'
    )),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK (status IN (
      'lead', 'contacted', 'onboarding', 'active', 'inactive'
    )),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common lookups
CREATE INDEX idx_customers_phone ON customers (phone);
CREATE INDEX idx_customers_status ON customers (status);
CREATE INDEX idx_workers_phone ON workers (phone);
CREATE INDEX idx_workers_status ON workers (status);
