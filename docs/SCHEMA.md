# Database Schema

## Customer Object

Stored in the `customers` table with a JSONB `data` column.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `phone` | TEXT | E.164 format, unique |
| `status` | TEXT | One of: `new`, `scoping`, `quoting`, `scheduling`, `agreed`, `card_captured`, `dispatched`, `active`, `complete`, `closed` |
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
    "amount": 0,
    "status": "",
    "paid_at": ""
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
