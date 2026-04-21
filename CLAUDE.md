# GotaGuy — Claude Code Context

## What this is
SMS-first home repair marketplace for Collin County TX. Homeowners text one number, an AI scopes the job and quotes a price range, matched contractors claim and get paid same-day via Stripe. No app, no web form required.

## Stack
- Node.js / Express on Railway
- Supabase (Postgres + JSONB) — customers and workers tables
- Twilio — inbound/outbound SMS + MMS
- Stripe Connect Express — contractor payouts, `application_fee_amount` on capture
- Anthropic Claude API (claude-sonnet-4-20250514) — customer and contractor agents
- node-cron — monitor agent every 10 minutes

## Key files
- `src/index.js` — Express app entry, cron schedule, health endpoint
- `src/routes/sms.js` — Twilio webhook, all SMS routing logic
- `src/routes/stripe.js` — Stripe webhook (payment_intent events)
- `src/agents/customerAgent.js` — homeowner scoping/booking agent (Claude)
- `src/agents/contractorAgent.js` — contractor CLAIM/ARRIVED/DONE + free text
- `src/agents/dispatchAgent.js` — job card broadcast to matched workers
- `src/agents/monitorAgent.js` — 8 background checks (stalled, unclaimed, waitlist, etc.)
- `src/db/client.js` — Supabase client + all DB helpers
- `src/services/stripe.js` — createPaymentLink (checkout session creation)
- `src/services/twilio.js` — sendSMS wrapper
- `src/services/translate.js` — translateForWorker (EN/ES via Claude)
- `src/utils/router.js` — resolveContact (customer/worker lookup + archive)
- `src/utils/constants.js` — COLLIN_COUNTY_ZIPS (29 zips), ZIP_TO_CITY, TRADES
- `src/utils/fees.js` — calculateFee: 10% platform fee, min $25, max $250
- `src/utils/classifier.js` — classifyContact (homeowner/contractor/ambiguous)

## Customer status machine
`new` → `scoping` → `quoting` → `scheduling` → `agreed` → `dispatched` → `waitlisted` → `active` → `price_locked` → `complete` → `closed`

- `agreed`: all info collected, triggers dispatchJob
- `dispatched`: job cards sent to workers, waiting for CLAIM
- `waitlisted`: no workers matched, auto-retry every 30min (max 6)
- `active`: contractor claimed, en route
- `price_locked`: customer submitted Stripe checkout (Stripe webhook fires)
- `complete`: contractor texted DONE, waiting for customer YES/NO
- `closed`: payment captured, job done

## Supabase customers.data JSONB shape
```
{
  job: { category, description, quoted_price_low, quoted_price_high },
  contact: { name, address },
  availability: { window, raw },
  schedule: { worker_id, pending_day_confirmation, confirmed_day },
  invoice: { confirmed_price, stripe_payment_intent_id, payout_amount, status, captured_at },
  waitlist: { waitlisted_at, retry_count, last_retry_at, escalated_at },
  comms: [{ ts, direction: 'in'|'out', body }],
  history: [{ ts, agent, action }],
  photos: [{ ts, url, type }],
  reminders_sent, first_reminder_at, appointment_reminder_sent, opted_out
}
```

## workers.data trade field
- New workers store trades as `data.trades` (JSON array, e.g. `["electrical","plumbing"]`)
- Legacy McKinney workers store a single string at `data.trade`
- `getActiveWorkersByTradeAndZip` in db/client.js handles both: checks `data.trades[]` first,
  falls back to `[data.trade]` if `data.trades` is absent — existing contractors are unaffected
- Admin POST /contractors accepts `trade` (string) or `trades` (array); both normalize to `trades[]`

## Critical routing rules in sms.js
- STOP/HELP/UNSTOP handled first
- resolveContact returns null only for unknown numbers OR `closed` status (NOT `complete`)
- Worker flow handled before customer flow
- `waitlisted` customers: only CANCEL works, else holding message
- `price_locked` OR `complete` + YES → handleYes (payment capture)
- `price_locked` OR `complete` + NO → handleNo (dispute + PaymentIntent cancel + contractor notified)
- `dispatched/active/price_locked` free text: simple acks → holding template; cancel/reschedule/help/? → runCustomerAgent
- All other customer SMS → runCustomerAgent

## Stripe payment flow
1. Contractor texts ARRIVED → createPaymentLink called with workerStripeAccountId
2. Session created with `capture_method: manual` + `transfer_data.destination: workerStripeAccountId`
3. Customer enters price on Stripe checkout → `payment_intent.amount_capturable_updated` webhook
4. Webhook sets customer to `price_locked`, stores confirmed_price + payment_intent_id
5. Contractor texts DONE → customer to `complete`, asks customer YES/NO
6. Customer texts YES → handleYes: calculateFee, capture with application_fee_amount, Stripe transfer to contractor, close job
7. `application_fee_amount = Math.round(platformFee * 100)` — requires transfer_data.destination set at session creation

## Known bugs fixed this session (important context)
- `complete` status was triggering archive in resolveContact — destroyed record before handleYes ran
- `confirmedPrice` was used before declaration in handleYes (ReferenceError silently aborted capture)
- `application_fee_amount` was never passed to Stripe capture (was $3 instead of $25+)
- `transfer_data.destination` was missing from checkout session (required for fee to work)
- YES regex in sms.js only fired on `quoting` status — now fires on all turns
- Price regex only matched two `$` signs — now handles `$110-175` format too

## Contractor command flow
- CLAIM [job#] → handleClaim → optimistic lock, check for multiple availability options
  - Multiple options (contains "or" or ","): ask contractor which day, set pending_day_confirmation
  - Single option: confirm immediately, text homeowner
- Contractor day reply → handleDayConfirmation → update availability.window, confirm both parties
- ARRIVED [job#] → handleArrived → send payment link to customer
- DONE [job#] → handleDone → move to complete, ask customer YES/NO

## Monitor agent (8 checks, runs every 10 min)
1. Stalled conversations — 2 reminders with YES/NO opt-out, then auto-close
2. Unclaimed dispatched jobs — alert admin after 2h
3. Stalled price_locked jobs — alert admin after 4h
4. Roster coverage — disabled
5. Waitlisted retries — every 30min, max 6, then escalate
6. Pending Stripe onboarding followup — 24h after pending_stripe
7. 30-day closed job followup
8. Appointment reminders — dispatched/active jobs 12h+ with no reminder sent

## Deployment
- Railway, auto-deploy from main branch (sometimes needs force push)
- Health check: GET /health → `{ commit: RAILWAY_GIT_COMMIT_SHA, deployed: timestamp }`
- Force redeploy: `git commit --allow-empty -m "force deploy $(date)" && git push`
- railway.json: NIXPACKS builder, healthcheckPath /health, restartPolicyType ON_FAILURE

## Geography
- Service area: Collin County TX (McKinney, Allen, Frisco, Plano, Prosper, Celina, Wylie, Sachse, Anna, Melissa, Princeton, Lavon, Richardson)
- 29 ZIP codes in COLLIN_COUNTY_ZIPS + ZIP_TO_CITY mapping in constants.js
- Job cards show city name (not ZIP): "Job #2359 - drywall - McKinney"
