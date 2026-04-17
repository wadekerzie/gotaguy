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
| **Fee structure** | 10% of job value, minimum $25, maximum $250. Contractor pitch: "We take 10% - minimum $25, never more than $250." |
| **Repair only** | One trade, one visit, parts from supply house, under $800. 13 trades supported. |
| **Licensed trades** | electrical, plumbing, hvac, pool, pest_control — TDLR or equivalent verification available. All other trades rely on personal vetting by Wade. |
| **Landscaping scope** | Landscaping is in scope for discrete one-visit jobs only — seasonal cleanup, small removals, sod repair. Recurring lawn care is explicitly out of scope. |
| **Painting scope** | Painting is in scope for interior touch-up and single room repaints only. Whole house exterior is out of scope. |
| **First-contact classifier** | Uses Claude API to classify unknown inbound numbers as homeowner, contractor, or ambiguous. Defaults to homeowner on error. |
| **Contractor intake** | Admin-only via POST /admin/contractors. Inbound contractor texts are captured as leads and flagged to MY_CELL_NUMBER. |
| **Default zip coverage** | All contractors default to the full Collin County cluster in constants.js. |
| **Monitor agent** | Runs every 10 minutes via node-cron. All alerts go to MY_CELL_NUMBER. |
| **Job card pricing** | Job card displays the customer-facing quoted range only. Contractor net is not shown on the job card. Contractors calculate their own take based on the flat fee structure communicated during onboarding. |
| **Waitlist overflow** | When dispatch finds zero matching contractors, customer moves to `waitlisted` status with a holding message. Monitor agent retries every 30 minutes up to 6 times, then escalates to admin. Admin can manually force-dispatch via POST /admin/dispatch/:customerId. Customer texts while waitlisted get a holding reply; CANCEL cancels the job. |
| **Spanish language support** | Spanish language support is available for contractor SMS communications. Contractors select EN or ES during onboarding. The English path is unchanged. Translation uses Claude API with fallback to English on error. CLAIM, ARRIVED, DONE, STOP, HELP, YES, NO remain in English as system-recognized commands. English communication is required on job sites regardless of language preference. |
