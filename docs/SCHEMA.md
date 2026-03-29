# Database Schema

## Customer Object

Stored in the `customers` table with a JSONB `data` column.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `phone` | TEXT | E.164 format, unique |
| `status` | TEXT | One of: `new`, `scoping`, `quoting`, `scheduling`, `agreed`, `waitlisted`, `dispatched`, `price_locked`, `active`, `complete`, `closed` |
| `data` | JSONB | See structure below |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger on every row change |

### `data` JSONB Structure

```json
{
  "classified_as": "homeowner | contractor | ambiguous",
  "classified_at": "",
  "ambiguous": false,
  "contact": {
    "name": "",
    "email": "",
    "address": "",
    "timezone": ""
  },
  "job": {
    "category": "",
    "description": "",
    "urgency": "",
    "estimated_duration_hrs": 0,
    "quoted_price_low": 0,
    "quoted_price_high": 0
  },
  "availability": {
    "raw": "",
    "window": "",
    "flexible": false,
    "notes": ""
  },
  "schedule": {
    "confirmed_window": "",
    "worker_id": ""
  },
  "invoice": {
    "quoted_price_low": 0,
    "quoted_price_high": 0,
    "confirmed_price": 0,
    "stripe_payment_intent_id": "",
    "price_locked_at": "",
    "contractor_notified_at": "",
    "captured_at": "",
    "payout_amount": 0,
    "payout_fired_at": "",
    "status": "pending | authorized | captured | failed | disputed"
  },
  "waitlist": {
    "waitlisted_at": "",
    "retry_count": 0,
    "last_retry_at": "",
    "escalated_at": "",
    "reason": "no_match"
  },
  "last_nudge_at": "",
  "last_dispatch_alert_at": "",
  "last_locked_alert_at": "",
  "comms": [
    { "ts": "", "direction": "inbound|outbound", "body": "" }
  ],
  "history": [
    { "ts": "", "agent": "", "action": "" }
  ]
}
```

---

## Worker Object

Stored in the `workers` table with a JSONB `data` column.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `phone` | TEXT | E.164 format, unique |
| `status` | TEXT | One of: `lead`, `pending_stripe`, `active`, `inactive` |
| `data` | JSONB | See structure below |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger on every row change |

### `data` JSONB Structure

```json
{
  "name": "",
  "trade": "",
  "license_number": "",
  "license_verified": false,
  "zip_codes": [],
  "stripe_account_id": "",
  "onboarding": {
    "tier": 1,
    "license_verified": false,
    "stripe_express_complete": false,
    "jobs_completed": 0,
    "lifetime_earnings": 0
  },
  "comms": [
    { "ts": "", "direction": "inbound|outbound", "body": "" }
  ],
  "history": [
    { "ts": "", "agent": "", "action": "" }
  ]
}
```

---

## Monitor Logs

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `ran_at` | TIMESTAMPTZ | Default now() |
| `checks_run` | INTEGER | Number of checks executed |
| `issues_found` | INTEGER | Total issues detected |
| `details` | JSONB | Additional run details |
