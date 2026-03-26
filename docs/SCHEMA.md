# Database Schema

## Customer Object

Stored in the `customers` table with a JSONB `data` column.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `phone` | TEXT | E.164 format, unique |
| `status` | TEXT | One of: `new`, `scoping`, `quoting`, `scheduling`, `agreed`, `dispatched`, `price_locked`, `active`, `complete`, `closed` |
| `data` | JSONB | See structure below |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |

### `data` JSONB Structure

```json
{
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
| `status` | TEXT | One of: `lead`, `contacted`, `onboarding`, `active`, `inactive` |
| `data` | JSONB | See structure below |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |

### `data` JSONB Structure

```json
{
  "name": "",
  "trade": "",
  "license_number": "",
  "license_verified": false,
  "zip_codes": [],
  "stripe_account_id": "",
  "jobs_completed": 0,
  "rating": 0,
  "comms": [
    { "ts": "", "direction": "inbound|outbound", "body": "" }
  ],
  "history": [
    { "ts": "", "agent": "", "action": "" }
  ]
}
```
