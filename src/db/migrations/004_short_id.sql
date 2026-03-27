ALTER TABLE customers ADD COLUMN IF NOT EXISTS short_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_short_id ON customers (short_id);
