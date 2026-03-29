# Agent Responsibilities

## customerAgent

Handles inbound SMS from homeowners. Drives the customer status through the lifecycle from `new` to `agreed`.

- Receives inbound SMS from unknown or known customer numbers
- Asks follow-up questions to scope the job (trade, description, urgency)
- Provides a quoted price range based on job details
- Collects availability and scheduling preferences
- Updates the customer object in Supabase at each step

## contractorAgent

Handles inbound SMS from contractors. Manages job claims, ETAs, and close-out.

- Receives inbound SMS from known contractor numbers
- Processes CLAIM command — atomically locks job to contractor
- Processes ARRIVED command — generates Stripe payment link for customer
- Processes DONE command — triggers YES/NO confirmation from customer
- Handles free-text questions via Claude API
- Updates the worker object in Supabase at each step

## dispatchAgent

Fires when a customer status hits `agreed`. Matches and notifies contractors.

- Queries the workers table by trade and zip code
- Filters for active, available contractors
- Sends a job card SMS to matched contractors with quoted price range
- Tracks which contractors were notified
- Updates customer status to `dispatched`
- **Zero-match handling**: When no contractors match, sets status to `waitlisted`, sends holding message to customer, alerts admin. Also exports `retryDispatch(customerRecord)` for use by monitor agent and admin override.

## welcomeContractor

Fires when a contractor is added via admin endpoint. Sends onboarding sequence.

- Sends two-message welcome SMS with 3-second delay
- Creates Stripe Express account for contractor payouts
- Generates Stripe onboarding link and includes in message 2
- Stores stripe_account_id on worker record
- Falls back gracefully if Stripe errors (sends holding message, alerts admin)

## classifier (utility)

Classifies first-contact SMS from unknown numbers. Not a full agent — a single Claude API call.

- Returns one of: `homeowner`, `contractor`, `ambiguous`
- Homeowner: proceeds to customerAgent as normal
- Contractor: creates worker lead, alerts MY_CELL_NUMBER, does not proceed to any agent
- Ambiguous: creates customer with clarifying question, next reply routes normally
- Defaults to `homeowner` on any error to never block a homeowner conversation

## monitorAgent

Cron job running every 10 minutes. Watches for stalled objects and roster gaps.

- **Check 1 — Stalled conversations**: Customers in new/scoping/quoting/scheduling with no activity for 2+ hours get a nudge SMS. Cooldown: 24 hours per customer.
- **Check 2 — Unclaimed jobs**: Dispatched jobs not claimed within 2 hours trigger admin alert. Cooldown: 4 hours per job.
- **Check 3 — Stalled price_locked**: Jobs stuck at price_locked for 4+ hours trigger admin alert. Cooldown: 6 hours per job.
- **Check 4 — Roster gaps**: Trades with zero active contractors trigger admin alert. Cooldown: 24 hours per trade.
- **Check 5 — Waitlisted retries**: Customers in `waitlisted` status get a retry dispatch every 30 minutes, up to 6 attempts. After 6 failures, escalates to admin with full job details. Cooldown: 30 minutes per customer.
- Logs every run to `monitor_logs` table with checks_run and issues_found counts.
