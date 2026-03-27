-- Monitor logs table
CREATE TABLE IF NOT EXISTS monitor_logs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz default now(),
  checks_run integer default 0,
  issues_found integer default 0,
  details jsonb default '{}'
);

-- Add updated_at to customers and workers for monitor agent queries
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at timestamptz default now();
ALTER TABLE workers ADD COLUMN IF NOT EXISTS updated_at timestamptz default now();

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER workers_updated_at
  BEFORE UPDATE ON workers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
