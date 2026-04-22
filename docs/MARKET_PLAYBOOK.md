# GotaGuy Market Operations Playbook

Single source of truth for all geographic expansion operations. Each operation is a
strict numbered checklist. A future Claude Code session can execute any operation by
reading this file and filling in the config block at the start of each section.

**Before executing any operation**, read the architecture context section below in full.

---

## Architecture Context

### Database (Supabase)

| Table | Relevant columns |
|-------|-----------------|
| `markets` | `id UUID PK`, `name TEXT`, `twilio_number TEXT UNIQUE`, `zip_codes TEXT[]`, `domain TEXT`, `active BOOLEAN DEFAULT true`, `created_at TIMESTAMPTZ` |
| `workers` | `market_id UUID REFERENCES markets(id)` (top-level column, added migration 002) |
| `workers.data` JSONB | `data.zip_codes TEXT[]`, `data.trade TEXT`, `data.name TEXT`, `data.business_name TEXT`, `data.language_preference TEXT` |

The `customers` table has NO `market_id` column. Market is inferred at runtime from the
customer's address ZIP via `getMarketByZip(zip)` in `src/db/client.js`.

### Dispatch flow (`src/agents/dispatchAgent.js`)

```
dispatchJob(customerRecord)
  → extract zip from customerRecord.data.contact.address
  → getMarketByZip(zip)          ← queries markets WHERE zip_codes @> ARRAY[zip] AND active = true
  → getActiveWorkersByTradeAndZip(trade, [zip], market.id)
       ← DB filter: workers.status = 'active' AND workers.market_id = marketId (when provided)
       ← JS filter: data.trade match AND data.zip_codes overlap with job zip
```

A worker must satisfy BOTH the `market_id` DB filter AND the `data.zip_codes` JS filter
to receive a job card. This is belt-and-suspenders — one check alone is not sufficient.

### Inbound SMS routing (`src/routes/sms.js`)

```js
const from    = req.body.From;                                    // caller's number
const inboundTo = req.body.To || process.env.TWILIO_PHONE_NUMBER; // Twilio number that received the SMS
```

All markets share one webhook URL (`/sms`). The `req.body.To` field is how the application
knows which market's number was texted. All outbound replies use `inboundTo` as the `from`
parameter so replies come from the same number.

### Outbound SMS (`src/services/twilio.js`)

```js
async function sendSMS(to, body, from = process.env.TWILIO_PHONE_NUMBER)
```

The `from` parameter defaults to `TWILIO_PHONE_NUMBER` (McKinney primary). All customer-
and contractor-facing call sites that are market-aware pass the correct market number
explicitly. Admin alerts to `MY_CELL_NUMBER` always use the default.

### Worker onboarding (`src/agents/welcomeContractor.js`)

```js
async function welcomeContractor(workerRecord)
```

Fields read from `workerRecord`:

| Field | Used for |
|-------|---------|
| `workerRecord.phone` | Outbound SMS recipient, `updateWorker` lookup key |
| `workerRecord.status` | Passed to `updateWorker` |
| `workerRecord.market_id` | Looked up via `getMarketById()` to resolve correct outbound Twilio number |
| `workerRecord.data.name` | Greeting ("Hey {firstName}") |
| `workerRecord.data.business_name` | Alternate intro if contractor represents a business |

Three SMS messages are sent in sequence (3-second delay between each):
1. Welcome/intro (uses `data.name`, `data.business_name`)
2. Stripe Express onboarding link — or fallback "We'll send you a setup link shortly" + admin alert to `MY_CELL_NUMBER` if Stripe fails
3. Language preference: `"One quick question - what language do you prefer for job notifications? Reply EN for English or ES for Spanish."`

Worker record is updated with `status: 'pending_stripe'` at creation (set by admin API).
Worker becomes eligible for dispatch only when `status = 'active'` (set automatically by
`/stripe/connect/return` webhook after Stripe Express onboarding completes).

### Valid trade values (must match exactly — canonical strings in `src/utils/constants.js`)

`electrical` `plumbing` `hvac` `handyman` `drywall` `painting` `sprinkler` `garage_door` `pool` `pest_control` `landscaping` `appliance` `fence`

### Migration naming

Migrations live in `migrations/` and are named `NNN_description.sql`.  
Current highest: `002_markets.sql`. Next available: `003`.

---

## OPERATION 1 — Add a New Market

### Config block (fill this in before executing)

```
Market name:     [human-readable, e.g. "Denver"]
Twilio number:   [E.164, e.g. "+13031234567"]
Domain:          [e.g. "gotaguydenver.com"]
Zip codes:       [comma-separated 5-digit strings, e.g. "80201, 80202, 80203"]
.env key name:   [e.g. "TWILIO_DENVER_NUMBER"]
```

### Checklist

**Step 1 — Confirm Twilio number is purchased and webhook is configured**

- Log in to console.twilio.com
- Confirm the number is purchased and active under Phone Numbers → Manage
- Navigate to the number → Messaging configuration
- Set "A message comes in" to:
  - Webhook URL: `https://gotaguy-production.up.railway.app/sms`
  - HTTP method: `HTTP POST`
- Save
- Guard rail: do NOT set a different webhook URL per market — all markets share `/sms`

**Step 2 — Add .env key on Railway**

- Open Railway dashboard → GotaGuy project → Variables
- Add: `[.env key name]` = `[Twilio number in E.164 format]`
  - Example: `TWILIO_AURORA_NUMBER` = `+17208213271`
- This env var is informational/operational reference. Outbound routing uses the value
  stored in the `markets.twilio_number` DB column, not this env var directly.
- Deploy is not required for this step alone.

**Step 3 — Run migration to insert the market row**

Create `migrations/003_[market_name_lowercase]_market.sql` (or the next available number):

```sql
-- Migration 003: Add [Market name] market
INSERT INTO markets (name, twilio_number, zip_codes, domain)
VALUES (
  '[Market name]',
  '[Twilio number]',
  ARRAY['[zip1]', '[zip2]', '[zip3]'],   -- all zips from config block
  '[domain]'
)
ON CONFLICT (twilio_number) DO NOTHING;
```

Apply by pasting into the Supabase SQL editor:
`https://supabase.com/dashboard/project/mtizeqvlxlatybdvboji/sql`

Note: `ON CONFLICT (twilio_number) DO NOTHING` is a safety net only — do not rely on it
to re-run migrations. Each migration should be applied exactly once.

**Step 4 — Verify the market row in Supabase**

```sql
SELECT id, name, twilio_number, active, array_length(zip_codes, 1) AS zip_count
FROM markets
WHERE twilio_number = '[Twilio number]';
-- Expected: 1 row, active = true, zip_count = expected number of zips
```

Copy the returned `id` UUID — needed for contractor onboarding (Operation 3).

Also confirm no zip overlap with existing markets:

```sql
SELECT m.name, unnest(m.zip_codes) AS zip
FROM markets m
WHERE unnest(m.zip_codes) = ANY(ARRAY['[zip1]', '[zip2]'])
  AND m.twilio_number != '[Twilio number]';
-- Expected: 0 rows
```

**Step 5 — Send a test SMS to confirm webhook fires**

Text the new Twilio number from any non-registered phone with a test message (e.g., "test").
Confirm in Railway logs:
```
Inbound SMS from +1XXXXXXXXXX: test
```
The inbound number will be classified as a homeowner and a reply should come back from
the new Twilio number (not the McKinney number).

**Step 6 — Update `ZIP_TO_CITY` in `src/utils/constants.js`**

Add each new zip → city name mapping. This controls what city name appears on job cards.

```js
// Add inside the ZIP_TO_CITY object
'[zip1]': '[City]',
'[zip2]': '[City]',
```

Commit and deploy:
```bash
git add src/utils/constants.js migrations/003_[market]_market.sql
git commit -m "feat: add [Market name] market"
git push
```

### Do NOT touch

- `COLLIN_COUNTY_ZIPS` in `constants.js` — McKinney default list, must not change
- Any existing `markets` rows or their `zip_codes` arrays
- Any existing worker `market_id` values
- The `/sms` webhook URL (shared across all markets)
- `TWILIO_PHONE_NUMBER` env var (McKinney primary number, used as default fallback)
- The `002_markets.sql` migration file

---

## OPERATION 2 — Add Zip Codes to an Existing Market

### Config block (fill this in before executing)

```
Market name:          [must match markets.name exactly, case-sensitive]
New zip codes to add: [comma-separated 5-digit strings, e.g. "80020, 80021"]
```

### Checklist

**Step 1 — Confirm the market exists**

```sql
SELECT id, name, active, array_length(zip_codes, 1) AS current_zip_count
FROM markets
WHERE name = '[Market name]';
-- Expected: 1 row, active = true
-- If 0 rows: the name does not match exactly — check capitalization
```

**Step 2 — Append new zips to the market row (no overwrite)**

```sql
-- Append without duplicates using array_cat + DISTINCT unnest
UPDATE markets
SET zip_codes = (
  SELECT array_agg(DISTINCT z ORDER BY z)
  FROM unnest(zip_codes || ARRAY['[zip1]', '[zip2]']) AS z
)
WHERE name = '[Market name]';

-- Verify
SELECT name, zip_codes, array_length(zip_codes, 1) AS zip_count
FROM markets
WHERE name = '[Market name]';
```

Guard rail: the `||` operator appends; `array_agg(DISTINCT ...)` deduplicates. This
pattern is safe to re-run — duplicate zips will not be created.

**Step 3 — Update contractors who should cover the new zips**

`data.zip_codes` on each worker is set at onboarding and is NOT automatically expanded
when the market's `zip_codes` array grows. Workers only receive jobs for zips in their
own `data.zip_codes`. To expand coverage for all active workers in the market:

```sql
-- Add new zips to every active or busy worker in the market
UPDATE workers
SET data = jsonb_set(
  data,
  '{zip_codes}',
  (
    SELECT jsonb_agg(DISTINCT z ORDER BY z)
    FROM (
      SELECT jsonb_array_elements_text(data->'zip_codes') AS z
      UNION
      SELECT unnest(ARRAY['[zip1]', '[zip2]']) AS z
    ) t
  )
)
WHERE market_id = (SELECT id FROM markets WHERE name = '[Market name]')
  AND status IN ('active', 'busy');

-- Verify a sample worker
SELECT id, phone, data->'zip_codes' AS zip_codes
FROM workers
WHERE market_id = (SELECT id FROM markets WHERE name = '[Market name]')
LIMIT 3;
```

**Step 4 — Update `ZIP_TO_CITY` in `src/utils/constants.js`**

Add each new zip → city mapping. If the market is McKinney, also add the zips to the
`COLLIN_COUNTY_ZIPS` array (used as the default zip list when creating McKinney
contractors without explicit `zip_codes`).

**Step 5 — Commit and deploy**

```bash
git add src/utils/constants.js
git commit -m "feat: add zips [list] to [Market name] market"
git push
```

### Do NOT touch

- `twilio_number`, `id`, `name`, `active`, `domain` on any market row
- Contractors in other markets
- `COLLIN_COUNTY_ZIPS` unless the market being expanded is McKinney

---

## OPERATION 3 — Add a Contractor to a Specific Market

### Config block (fill this in before executing)

```
Name:                [first last, 2-50 characters]
Phone:               [E.164, e.g. "+17204680020"]
Market:              [must match markets.name exactly, case-sensitive]
Trade:               [one valid trade string from constants.js list above]
Language preference: [en or es — default en]
Notes:               [optional]
```

### Checklist

**Step 1 — Confirm market exists and is active**

```sql
SELECT id, name, twilio_number, zip_codes, active
FROM markets
WHERE name = '[Market name]';
-- Expected: 1 row, active = true
-- Copy the id UUID for Step 2
```

If `active = false`: do not proceed. The market must be active before onboarding contractors.

**Step 2 — Create the contractor via the admin API**

The admin API creates the worker record AND fires `welcomeContractor()` automatically
(Stripe Express account creation + onboarding link SMS + language preference SMS).

```bash
curl -X POST https://gotaguy-production.up.railway.app/admin/contractors \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_SECRET" \
  -d '{
    "name":      "[Name]",
    "trades":    ["[trade1]", "[trade2]"],
    "phone":     "[Phone]",
    "market_id": "[UUID from Step 1]",
    "zip_codes": ["[zip1]", "[zip2]"]
  }'
```

Expected response: HTTP 201 with the full worker row JSON.

The worker is created with `status: 'pending_stripe'`. The admin API then calls
`welcomeContractor(workerRecord)` asynchronously (non-blocking on the response).

`welcomeContractor` reads these fields from the worker record:

| Field read | Purpose |
|-----------|---------|
| `workerRecord.phone` | All outbound SMS recipient + DB lookup key |
| `workerRecord.status` | Passed to `updateWorker` |
| `workerRecord.market_id` | Looked up via `getMarketById()` → resolves correct outbound Twilio number |
| `workerRecord.data.name` | First message greeting |
| `workerRecord.data.business_name` | Alternate intro (if set, uses "on behalf of [business_name]") |

Three SMS messages fire in order:
1. Welcome/intro — sent immediately from the market's Twilio number
2. Stripe Express onboarding link — `"Add your debit card here - takes about 90 seconds: [url]\n\nOnce that's done I'll send you a sample..."` — or fallback if Stripe fails
3. Language preference — `"One quick question - what language do you prefer for job notifications? Reply EN for English or ES for Spanish."`

**Step 3 — Verify the worker record in Supabase**

```sql
SELECT
  id,
  phone,
  status,
  market_id,
  data->>'name'                  AS name,
  data->>'trade'                 AS trade,
  data->'zip_codes'              AS zip_codes,
  data->>'language_preference'   AS language,
  data->'onboarding'             AS onboarding
FROM workers
WHERE phone = '[Phone]';
```

**Step 4 — Confirm all four checks pass**

**a. Worker row exists with correct market_id**
```sql
-- market_id must equal the UUID from Step 1
SELECT id, market_id FROM workers WHERE phone = '[Phone]';
```

**b. Welcome SMS was sent**
Check Railway logs for:
```
SMS sent to [Phone]: Hey [FirstName] - Wade here.
```
Or check Twilio console → Logs → Message logs, filter by the market's Twilio number.

**c. Stripe Express link was generated and texted**

Success path — Railway logs show:
```
[welcomeContractor] Creating Stripe Express account for [Phone]
[welcomeContractor] Stripe Express account created: acct_XXXXXXXX
[welcomeContractor] Creating account link for acct_XXXXXXXX
[welcomeContractor] Account link created successfully for acct_XXXXXXXX
SMS sent to [Phone]: Add your debit card here - takes about 90 seconds: https://connect.stripe.com/...
```

Failure path (Stripe error) — Railway logs show:
```
[welcomeContractor] Stripe setup failed for [Phone] - ...
SMS sent to [Phone]: We'll send you a setup link shortly - hang tight.
```
And an alert SMS fires to `MY_CELL_NUMBER`:
```
STRIPE ERROR - could not generate Express link for [Name] [Phone]
```

**d. Language preference SMS was sent as the third message**
Railway logs show:
```
SMS sent to [Phone]: One quick question - what language do you prefer...
```

**Step 5 — Verify dispatch eligibility**

Worker starts at `status: 'pending_stripe'`. They are NOT yet eligible for live dispatch
(dispatch queries filter for `status = 'active'` only). To confirm the record is correct
and will be eligible once onboarding completes, run:

```sql
-- Confirm contractor will appear for their market's zips when active
SELECT id, phone, data->>'name' AS name, market_id, status
FROM workers
WHERE phone = '[Phone]'
  AND market_id = (SELECT id FROM markets WHERE name = '[Market name]')
  AND data->'zip_codes' @> '["[any zip in market]"]'::jsonb
  AND data->'trades' @> '["[trade]"]'::jsonb;
-- Expected: 1 row

-- Confirm contractor will NOT appear for zips outside their market
SELECT id, phone, market_id
FROM workers
WHERE phone = '[Phone]'
  AND data->'zip_codes' @> '["75069"]'::jsonb;
-- Expected: 0 rows (unless market IS McKinney)
```

**Step 6 — Confirm status goes active after Stripe onboarding**

Once the contractor clicks the Stripe link and completes onboarding, the
`/stripe/connect/return?account_id=acct_XXXXXXXX` webhook fires and sets
`status = 'active'`. Verify:

```sql
SELECT status, data->'onboarding'->>'stripe_express_complete' AS stripe_done
FROM workers
WHERE phone = '[Phone]';
-- Expected after onboarding: status = 'active', stripe_done = 'true'
```

### Do NOT touch

- Any existing contractor records
- The `TRADES` or `LICENSED_TRADES` arrays in `constants.js` — only add contractors
  for trades already in those lists; adding new trade types is a separate code change
- Worker `status` — leave at `pending_stripe` until Stripe onboarding completes naturally

---

## OPERATION 4 — Deactivate a Market

### Config block (fill this in before executing)

```
Market name: [text — must match markets.name exactly]
Reason:      [brief note, e.g. "shutting down Aurora pilot"]
```

### Checklist

**Step 1 — Check for in-flight jobs before proceeding**

```sql
SELECT c.id, c.short_id, c.status, c.phone,
       c.data->'contact'->>'address' AS address
FROM customers c
WHERE c.status IN ('dispatched', 'active', 'price_locked', 'complete')
  AND c.data->'contact'->>'address' ~ ANY(
    SELECT unnest(zip_codes)::text FROM markets WHERE name = '[Market name]'
  );
```

If any rows are returned: resolve or hand off each job manually before continuing.
Do NOT set `active = false` with jobs in progress.

**Step 2 — Set `active = false` on the market row**

```sql
UPDATE markets
SET active = false
WHERE name = '[Market name]';

-- Verify
SELECT id, name, active FROM markets WHERE name = '[Market name]';
-- Expected: active = false
```

**How `active = false` is respected by dispatch:**

`dispatchAgent.js` calls `getMarketByZip(zip)`, which queries:
```sql
SELECT * FROM markets
WHERE zip_codes @> ARRAY[zip]
  AND active = true     -- ← this filter excludes the deactivated market
LIMIT 1
```

When `active = false`, `getMarketByZip` returns `null`. `dispatchAgent.js` then logs:
```
[dispatchJob] No market found for zip XXXXX — dispatching without market filter
```
and passes `null` as `marketId` to `getActiveWorkersByTradeAndZip`, which then skips
the `market_id` DB filter entirely. **This means any active worker whose `data.zip_codes`
includes a zip in the deactivated market could still receive jobs.**

The hard stop is deactivating the workers in Step 3 — no active workers = no dispatch.
Setting `active = false` alone is NOT sufficient to prevent dispatch.

**Step 3 — Deactivate all contractors in the market**

```sql
UPDATE workers
SET
  status = 'inactive',
  data = jsonb_set(
    data,
    '{history}',
    coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'ts',     now()::text,
        'agent',  'admin',
        'action', 'market deactivated: [Reason]'
      )
    )
  )
WHERE market_id = (SELECT id FROM markets WHERE name = '[Market name]')
  AND status NOT IN ('inactive', 'lead');

-- Verify no active workers remain
SELECT status, count(*) FROM workers
WHERE market_id = (SELECT id FROM markets WHERE name = '[Market name]')
GROUP BY status;
-- Expected: only 'inactive' and/or 'lead' rows
```

**Step 4 — Release or park the Twilio number**

- Log in to console.twilio.com → Phone Numbers → Manage
- Navigate to the market's Twilio number
- Option A (full deactivation): "Release this phone number" — number is returned to Twilio
- Option B (hold the number): Remove the webhook URL from Messaging configuration

Do not leave an active webhook pointed at the server for a deactivated market.
Inbound texts to an active webhook would still trigger the SMS handler and be classified
as new homeowner leads.

**Step 5 — Remove zip entries from `ZIP_TO_CITY` in `src/utils/constants.js` (optional)**

If the market will not be reactivated, remove the zip → city mappings to keep the
codebase clean. If you might reactivate later, leave them in place.

**Step 6 — Commit and deploy (only if constants.js was changed)**

```bash
git add src/utils/constants.js
git commit -m "feat: deactivate [Market name] market - remove ZIP_TO_CITY entries"
git push
```

This operation is reversible by setting `active = true` (market row) and updating
worker statuses back to `active` — no data is deleted.

### Do NOT touch

- Other markets' rows, workers, or customers
- The `markets` table schema
- Closed/archived customer records for the deactivated market (preserve for history)
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` env vars

---

## Reference: markets table schema (from `migrations/002_markets.sql`)

```sql
CREATE TABLE IF NOT EXISTS markets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  twilio_number TEXT        NOT NULL UNIQUE,
  zip_codes     TEXT[]      NOT NULL DEFAULT '{}',
  domain        TEXT,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Reference: workers market columns (from `migrations/002_markets.sql`)

```sql
-- Top-level column on workers table
market_id UUID REFERENCES markets(id)

-- Inside workers.data JSONB
data->'trades'                 -- string[], one or more of the 13 valid TRADES strings
data->'zip_codes'              -- TEXT[], subset of the market's zip_codes array
data->>'language_preference'   -- 'en' or 'es' (default 'en')
data->>'name'                  -- contractor display name
data->>'business_name'         -- optional, used in welcome SMS
```

Note: legacy McKinney workers created before this change store a single string at
`data->>'trade'`. Dispatch handles both — `data.trades[]` is checked first, then
`data.trade` as fallback. All new workers created via the admin API use `data.trades[]`.

## Reference: admin API endpoint (`src/routes/admin.js`)

```
POST /admin/contractors
Header: x-admin-key: <ADMIN_SECRET env var>
Body (JSON):
  name:       string   (required, 2-50 chars)
  trades:     string[] (required, one or more values from TRADES array)
              — also accepts trade: string for backwards compatibility (wrapped to array internally)
  phone:      string   (required, E.164 +1XXXXXXXXXX)
  market_id:  UUID     (optional — defaults to McKinney market if omitted)
  zip_codes:  string[] (optional — defaults to COLLIN_COUNTY_ZIPS if omitted)
Response 201: full worker row JSON
Response 409: phone already exists
```

Fires `welcomeContractor(workerRecord)` asynchronously after 201 response is sent.

## Reference: sendSMS signature (`src/services/twilio.js`)

```js
async function sendSMS(to, body, from = process.env.TWILIO_PHONE_NUMBER)
```

All customer- and contractor-facing call sites pass the market's `twilio_number` as `from`.
Admin alerts to `MY_CELL_NUMBER` use the default (McKinney number).
