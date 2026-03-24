# Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| **Node.js** | Chosen for simplicity and Railway compatibility |
| **Express** | Lightweight, no overhead needed |
| **Supabase** | Postgres with JSONB for customer and worker objects, pg_notify for events |
| **Twilio** | SMS send and receive, webhook for inbound |
| **Claude API** | AI layer for all customer and contractor conversations |
| **Railway** | Always-on server needed for cron jobs and pg_notify listeners |
| **Stripe Connect** | Marketplace payments, instant contractor payout, 1099 handling |
| **One Twilio number** | AI routes by whether inbound number is in customers or workers table |
| **Fee structure** | 10% of job value, minimum $15, maximum $150 |
| **Repair only** | One trade, one visit, parts from supply house, under $800 |
