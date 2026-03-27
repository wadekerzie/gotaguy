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
| **Fee structure** | 10% of job value, minimum $25, maximum $100. Contractor pitch: "We take 10% - minimum $25, never more than $100." |
| **Repair only** | One trade, one visit, parts from supply house, under $800 |
| **First-contact classifier** | Uses Claude API to classify unknown inbound numbers as homeowner, contractor, or ambiguous. Defaults to homeowner on error. |
| **Contractor intake** | Admin-only via POST /admin/contractors. Inbound contractor texts are captured as leads and flagged to MY_CELL_NUMBER. |
| **Default zip coverage** | All contractors default to the full Collin County cluster in constants.js. |
| **Monitor agent** | Runs every 10 minutes via node-cron. All alerts go to MY_CELL_NUMBER. |
| **Job card pricing** | Job card displays the customer-facing quoted range only. Contractor net is not shown on the job card. Contractors calculate their own take based on the flat fee structure communicated during onboarding. |
