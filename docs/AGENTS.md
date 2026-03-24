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
- Processes job claim responses (accept/decline)
- Collects ETA and arrival confirmations
- Handles job close-out and completion reporting
- Updates the worker object in Supabase at each step

## dispatchAgent

Fires when a customer status hits `agreed`. Matches and notifies contractors.

- Queries the workers table by trade and zip code
- Filters for active, available contractors
- Sends a job card SMS to matched contractors
- Tracks which contractors were notified
- Updates customer status to `dispatched`

## monitorAgent

Cron job running every 10 minutes. Watches for stalled objects and exceptions.

- Scans for customer objects stuck in a status too long
- Fires follow-up SMS to nudge stalled conversations
- Scans for contractor objects that need attention
- Alerts `MY_CELL_NUMBER` on exceptions or objects that need human intervention
