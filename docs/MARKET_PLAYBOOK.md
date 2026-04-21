# GotaGuy Market Operations Playbook

Single source of truth for all geographic expansion operations. Each operation is a
strict checklist. A future Claude Code session can execute any operation by reading
this file and filling in the config block at the start of each operation.

---

## System Architecture Context

Before executing any operation, understand these architectural facts:

**Database (Supabase)**
- `markets` table: canonical list of active markets (added in migration 002)
- `workers` table: has `market_id UUID REFERENCES markets(id)` top-level column
- `workers.data.zip_codes TEXT[]`: zip codes stored inside JSONB — the set of zips a worker can receive jobs for
- Dispatch filters by `market_id` AND `data.zip_codes` overlap (belt + suspenders)

**Dispatch flow**
`dispatchAgent.js` → `getMarketByZip(zip)` → `getActiveWorkersByTradeAndZip(trade, zips, marketId)`
A worker must have matching `market_id` AND contain the job zip in `data.zip_codes` to receive a job card.

**Inbound SMS routing**
All markets share one Express webhook at `/sms`. Twilio routes each number's inbound messages to that same URL. The `req.body.To` field contains the Twilio number that received the message — this is how the market is identified at the application layer.

**Outbound SMS limitation (known)**
`src/services/twilio.js` currently sends all outbound SMS from `process.env.TWILIO_PHONE_NUMBER` (the McKinney number). Until a per-market `sendSMS` is implemented, customers in new markets will receive replies from the McKinney number. Operations below flag exactly where this matters. Do not launch a production market without resolving this.

**Valid trade values** (must match exactly — these are the canonical strings in `src/utils/constants.js`):
`electrical` `plumbing` `hvac` `handyman` `drywall` `painting` `sprinkler` `garage_door` `pool` `pest_control` `landscaping` `appliance` `fence`

**Migration naming**: migrations live in `migrations/` and are named `NNN_description.sql`. The next available number is `003`.

---

## OPERATION 1 — Add a New Market

### Config block

```
MARKET_NAME:      <human-readable name, e.g. "Aurora">
TWILIO_NUMBER:    <E.164 format, e.g. "+17208213271">
DOMAIN:           <domain for terms link, e.g. "gotaguyaurora.com">
ZIP_CODES:        <comma-separated 5-digit strings, e.g. "80010, 80011, 80012">
ZIP_TO_CITY_MAP:  <json object mapping each zip to its city name,
                   e.g. {"80010": "Aurora", "80011": "Aurora"}>
```

### Checklist

**Step 1 — Twilio: configure inbound webhook**
- Log in to console.twilio.com
- Navigate to the phone number TWILIO_NUMBER
- Under "Messaging → A message comes in", set:
  - Webhook URL: `https://gotaguy-production.up.railway.app/sms`
  - HTTP method: HTTP POST
- Save
- Confirm: send a test SMS to TWILIO_NUMBER from a non-registered phone → Railway logs should show `Inbound SMS from +1XXXXXXXXXX: <body>`

**Step 2 — Supabase: insert market row**

No new migration file is required — the markets table already exists. Run this SQL
in the Supabase SQL editor (`https://supabase.com/dashboard/project/mtizeqvlxlatybdvboji/sql`):

```sql
INSERT INTO markets (name, twilio_number, zip_codes, domain)
VALUES (
  '<MARKET_NAME>',
  '<TWILIO_NUMBER>',
  ARRAY['<zip1>', '<zip2>', '<zip3>'],   -- fill in all zips from config
  '<DOMAIN>'
)
ON CONFLICT (twilio_number) DO NOTHING;

-- Verify the row was created and capture the id
SELECT id, name, twilio_number, zip_codes, active
FROM markets
WHERE twilio_number = '<TWILIO_NUMBER>';
```

Copy the returned `id` UUID — you will need it in Step 5.

**Step 3 — Code: update `src/utils/constants.js` `ZIP_TO_CITY` map**

Add each new zip → city mapping to the `ZIP_TO_CITY` object. This controls what
city name appears on job cards sent to contractors.

```js
// Add inside ZIP_TO_CITY = { ... }
'<zip1>': '<city>',
'<zip2>': '<city>',
```

Do NOT modify `COLLIN_COUNTY_ZIPS` — that is the McKinney default and must not change.

**Step 4 — Code: resolve outbound SMS sender**

Current limitation: `src/services/twilio.js` `sendSMS()` sends from `process.env.TWILIO_PHONE_NUMBER` (McKinney) for all markets. Before going live with a new market, the per-market `from` number must be wired in. This requires a code change — defer to a separate ticket or session. Do not skip this step for a production market.

**Step 5 — .env: no changes required for routing**

The webhook URL is the same for all markets. Twilio routes by number, the app resolves by Supabase lookup. No new env vars are needed for the market itself.

However, confirm the following are already set in the Railway environment:
- `TWILIO_ACCOUNT_SID` — must be the account that owns TWILIO_NUMBER
- `TWILIO_AUTH_TOKEN` — same account
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — unchanged

**Step 6 — Commit and deploy**

```bash
git add src/utils/constants.js
git commit -m "feat: add <MARKET_NAME> zip codes to ZIP_TO_CITY"
git push
```

Force-deploy if auto-deploy is slow:
```bash
git commit --allow-empty -m "force deploy $(date)" && git push
```

Verify deploy: `GET https://gotaguy-production.up.railway.app/health` → returns new commit SHA.

### Confirmation checks (all must pass)

```sql
-- 1. Market row exists and is active
SELECT id, name, twilio_number, active, array_length(zip_codes, 1) AS zip_count
FROM markets
WHERE twilio_number = '<TWILIO_NUMBER>';
-- Expected: 1 row, active = true, zip_count = <expected number>

-- 2. No other market shares any of the new zip codes (overlap = leakage risk)
SELECT m.name, unnest(m.zip_codes) AS zip
FROM markets m
WHERE unnest(m.zip_codes) = ANY(ARRAY['<zip1>', '<zip2>'])  -- fill in all new zips
  AND m.twilio_number != '<TWILIO_NUMBER>';
-- Expected: 0 rows
```

- Send a test inbound SMS to TWILIO_NUMBER → Railway log shows `Inbound SMS from ...`
- No existing McKinney contractors appear in a dispatch query for any new market zip (verify in Step 2 above)

### Do NOT touch

- `COLLIN_COUNTY_ZIPS` in constants.js
- Any existing market rows
- Any existing worker `market_id` values
- The `/sms` webhook URL (shared across all markets)
- `TWILIO_PHONE_NUMBER` env var (McKinney primary number)

---

## OPERATION 2 — Add Zip Codes to an Existing Market

### Config block

```
MARKET_NAME:      <name of the existing market, e.g. "Aurora">
NEW_ZIP_CODES:    <comma-separated 5-digit strings to add, e.g. "80020, 80021">
ZIP_TO_CITY_MAP:  <json object mapping each NEW zip to its city name>
```

### Checklist

**Step 1 — Supabase: append zips to the market row**

```sql
-- Append new zips without duplicates
UPDATE markets
SET zip_codes = (
  SELECT array_agg(DISTINCT z ORDER BY z)
  FROM unnest(zip_codes || ARRAY['<zip1>', '<zip2>']) AS z
)
WHERE name = '<MARKET_NAME>';

-- Verify
SELECT name, zip_codes
FROM markets
WHERE name = '<MARKET_NAME>';
```

**Step 2 — Code: update `ZIP_TO_CITY` in `src/utils/constants.js`**

Add the new zip → city entries to the `ZIP_TO_CITY` object.

If the market is McKinney, also add the zips to `COLLIN_COUNTY_ZIPS` (the McKinney
default list used when creating contractors without explicit zip_codes).

**Step 3 — Update contractors who should cover the new zips**

By default, no existing contractor will receive jobs in the new zips — `data.zip_codes`
on each worker is set at onboarding time and is not automatically expanded. To add new
zips to existing contractors, run this SQL for each affected contractor (or use a bulk
update if all contractors in the market should cover the new zips):

```sql
-- Add new zips to every active worker in the market
UPDATE workers
SET data = jsonb_set(
  data,
  '{zip_codes}',
  (
    SELECT jsonb_agg(DISTINCT z ORDER BY z)
    FROM (
      SELECT jsonb_array_elements_text(data->'zip_codes') AS z
      UNION
      SELECT unnest(ARRAY['<zip1>', '<zip2>']) AS z
    ) t
  )
)
WHERE market_id = (SELECT id FROM markets WHERE name = '<MARKET_NAME>')
  AND status IN ('active', 'busy');

-- Verify one worker to confirm
SELECT id, phone, data->'zip_codes' AS zip_codes
FROM workers
WHERE market_id = (SELECT id FROM markets WHERE name = '<MARKET_NAME>')
LIMIT 3;
```

**Step 4 — Commit and deploy**

```bash
git add src/utils/constants.js
git commit -m "feat: add zips <NEW_ZIP_CODES> to <MARKET_NAME> market"
git push
```

### Confirmation checks

```sql
-- Market has new zips
SELECT '<zip1>' = ANY(zip_codes) AS has_new_zip
FROM markets WHERE name = '<MARKET_NAME>';
-- Expected: true

-- No cross-market zip overlap
SELECT m.name, unnest(m.zip_codes) AS zip
FROM markets m
WHERE unnest(m.zip_codes) = ANY(ARRAY['<zip1>', '<zip2>'])
GROUP BY 1, 2
HAVING count(DISTINCT m.id) > 1;
-- Expected: 0 rows
```

### Do NOT touch

- `twilio_number`, `id`, `name`, `active` on any market row
- Contractors in other markets
- `COLLIN_COUNTY_ZIPS` unless the market is McKinney

---

## OPERATION 3 — Add a Contractor to a Specific Market

### Config block

```
CONTRACTOR_NAME:  <full name, 2-50 characters>
CONTRACTOR_PHONE: <E.164, e.g. "+17204680020">
TRADE:            <one of the valid trade values listed in the architecture section>
MARKET_NAME:      <must match an existing markets.name exactly>
ZIP_CODES:        <comma-separated — use the market's full zip list unless restricting
                   the contractor to a sub-area>
LANGUAGE:         <"en" or "es" — contractor's preferred language>
```

### Checklist

**Step 1 — Get the market's UUID**

```sql
SELECT id, name, twilio_number, zip_codes
FROM markets
WHERE name = '<MARKET_NAME>';
```

Copy the `id` UUID for use in Step 2.

**Step 2 — Create the contractor via the admin API**

The admin API fires `welcomeContractor` automatically (Stripe Express link + onboarding SMS).

```bash
curl -X POST https://gotaguy-production.up.railway.app/admin/contractors \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_SECRET" \
  -d '{
    "name": "<CONTRACTOR_NAME>",
    "trade": "<TRADE>",
    "phone": "<CONTRACTOR_PHONE>",
    "market_id": "<UUID from Step 1>",
    "zip_codes": ["<zip1>", "<zip2>"]
  }'
```

Expected response: HTTP 201 with the full worker JSON including `id` and `market_id`.

The contractor is created with `status: 'pending_stripe'`. They become eligible for
dispatch once `status` is updated to `'active'` (done automatically after Stripe
Express onboarding completes, or manually via SQL).

**Step 3 — Verify the record**

```sql
SELECT
  id,
  phone,
  status,
  market_id,
  data->>'name'        AS name,
  data->>'trade'       AS trade,
  data->'zip_codes'    AS zip_codes,
  data->>'language_preference' AS language
FROM workers
WHERE phone = '<CONTRACTOR_PHONE>';
```

Confirm:
- `market_id` matches the UUID from Step 1
- `zip_codes` in `data` contains only zips in the target market
- No McKinney zip codes present if this is a non-McKinney contractor

**Step 4 — Dispatch eligibility check**

Run a synthetic dispatch query to confirm the contractor DOES appear for their market
and does NOT appear for other markets:

```sql
-- Should appear: dispatch for a zip in their market with their trade
SELECT id, phone, data->>'name' AS name, market_id
FROM workers
WHERE status = 'active'                                          -- or pending_stripe during setup
  AND market_id = (SELECT id FROM markets WHERE name = '<MARKET_NAME>')
  AND data->'zip_codes' @> '["<any zip in market>"]'::jsonb
  AND data->>'trade' = '<TRADE>';

-- Should NOT appear: dispatch for a McKinney zip (or any other market zip)
SELECT id, phone, market_id
FROM workers
WHERE phone = '<CONTRACTOR_PHONE>'
  AND data->'zip_codes' @> '["75069"]'::jsonb;  -- McKinney zip example
-- Expected: 0 rows (unless contractor IS in McKinney)
```

### Do NOT touch

- Any existing contractor records
- The `TRADES` or `LICENSED_TRADES` arrays in constants.js — only add contractors for
  trades already in those lists; adding new trade types is a separate code change
- Contractor status — leave at `pending_stripe` until Stripe onboarding completes

---

## OPERATION 4 — Deactivate a Market

### Config block

```
MARKET_NAME:      <name of the market to deactivate>
TWILIO_NUMBER:    <the market's Twilio number, for reference>
REASON:           <brief note on why (used in history entries)>
```

### Checklist

**Step 1 — Check for in-flight jobs before proceeding**

```sql
-- Jobs currently in progress in this market's zip codes
SELECT c.id, c.short_id, c.status, c.phone,
       c.data->'contact'->>'address' AS address
FROM customers c
WHERE c.status IN ('dispatched', 'active', 'price_locked', 'complete')
  AND c.data->'contact'->>'address' ~ ANY(
    SELECT unnest(zip_codes) FROM markets WHERE name = '<MARKET_NAME>'
  );
```

If any rows are returned: resolve or hand off each job manually before continuing.
Do NOT deactivate a market with active jobs.

**Step 2 — Deactivate all contractors in the market**

```sql
-- Deactivate workers and append to their history
UPDATE workers
SET
  status = 'inactive',
  data = jsonb_set(
    data,
    '{history}',
    coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'ts', now()::text,
        'agent', 'admin',
        'action', 'market deactivated: <REASON>'
      )
    )
  )
WHERE market_id = (SELECT id FROM markets WHERE name = '<MARKET_NAME>')
  AND status NOT IN ('inactive', 'lead');

-- Verify
SELECT status, count(*) FROM workers
WHERE market_id = (SELECT id FROM markets WHERE name = '<MARKET_NAME>')
GROUP BY status;
-- Expected: all rows show inactive (or lead)
```

**Step 3 — Deactivate the market row**

```sql
UPDATE markets
SET active = false
WHERE name = '<MARKET_NAME>';

-- Verify
SELECT id, name, active FROM markets WHERE name = '<MARKET_NAME>';
-- Expected: active = false
```

Once `active = false`, `getMarketByZip` returns null for all zips in this market,
so `dispatchJob` falls back to no-market-filter mode (logs a warning). To fully
block dispatch, the contractors being inactive is the hard stop — no active workers =
no dispatch.

**Step 4 — Twilio: release or reassign the phone number**

- Log in to console.twilio.com
- Navigate to the phone number TWILIO_NUMBER
- Option A (full deactivation): Release the number → "Release this phone number"
- Option B (hold the number): Remove the webhook URL from the number's SMS configuration

Do not leave an active webhook pointed at the server for a deactivated market —
inbound texts would still be processed and could confuse the contact resolution flow.

**Step 5 — Code: remove zips from `ZIP_TO_CITY` (optional)**

If the market's zip codes should not appear anywhere in the system (job cards, etc.),
remove their entries from `ZIP_TO_CITY` in `src/utils/constants.js`. If you might
reactivate the market later, leave them in place.

**Step 6 — Commit and deploy (if constants.js was changed)**

```bash
git add src/utils/constants.js
git commit -m "feat: remove <MARKET_NAME> zips from ZIP_TO_CITY (market deactivated)"
git push
```

### Confirmation checks

```sql
-- Market is inactive
SELECT name, active FROM markets WHERE name = '<MARKET_NAME>';
-- Expected: active = false

-- No active workers remain in this market
SELECT count(*) FROM workers
WHERE market_id = (SELECT id FROM markets WHERE name = '<MARKET_NAME>')
  AND status = 'active';
-- Expected: 0

-- No open jobs remain in market zips
SELECT count(*) FROM customers c
WHERE c.status NOT IN ('closed', 'complete')
  AND EXISTS (
    SELECT 1 FROM markets m
    WHERE m.name = '<MARKET_NAME>'
      AND c.data->'contact'->>'address' ~ (
        array_to_string(m.zip_codes, '|')
      )
  );
-- Expected: 0
```

### Do NOT touch

- Other markets' rows or contractors
- The `markets` table schema
- Closed/archived customer records for the deactivated market (preserve for history)
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` env vars

---

## Reference: markets table schema

```sql
CREATE TABLE markets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  twilio_number TEXT        NOT NULL UNIQUE,
  zip_codes     TEXT[]      NOT NULL DEFAULT '{}',
  domain        TEXT,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Reference: workers table market columns

```sql
-- Top-level column (first-class FK)
market_id UUID REFERENCES markets(id)

-- Inside workers.data JSONB (set at contractor creation, not auto-synced)
data->>'trade'           -- one of the valid TRADES strings
data->'zip_codes'        -- TEXT[], subset of the market's zip_codes
data->>'language_preference'  -- 'en' or 'es'
```

## Reference: dispatch market filter (src/db/client.js)

```js
// When marketId is provided, only workers in that market are considered
let query = supabase.from('workers').select('*').eq('status', 'active');
if (marketId) {
  query = query.eq('market_id', marketId);
}
// JS filter then checks data.zip_codes overlap and trade match
```

## Reference: admin API endpoint

```
POST /admin/contractors
Header: x-admin-key: <ADMIN_SECRET>
Body: {
  name: string (2-50 chars),
  trade: string (must be in TRADES),
  phone: string (E.164 +1XXXXXXXXXX),
  market_id: UUID (optional — defaults to McKinney if omitted),
  zip_codes: string[] (optional — defaults to COLLIN_COUNTY_ZIPS if omitted)
}
Response 201: full worker row JSON
Response 409: phone already exists
```
