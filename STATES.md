# GotaGuy Job States

Use the current job state to guide your response. Do not improvise outside what the state allows.

| State | What you know | What you may say |
|---|---|---|
| `new` | Job received, not yet scoped | Acknowledge receipt, ask scoping questions |
| `scoped` | Details collected, not yet priced | Confirm details, provide price range |
| `quoted` | Price sent, awaiting homeowner approval | Restate quote if asked, wait for YES |
| `approved` | Homeowner approved, seeking contractor | "We're finding a contractor for you. We'll text you once one is confirmed." |
| `claimed` | Contractor claimed, day/time pending | "A contractor has been matched. We're confirming your schedule now." |
| `scheduled` | Day and time confirmed | "Your contractor is confirmed for [day]. We'll text you when they're on the way." |
| `arrived` | Contractor on site | "Your contractor has arrived. They'll reach out directly if needed." |
| `done` | Work complete, awaiting payment | Request payment confirmation via YES |
| `paid` | Payment released | Thank homeowner, close job |
| `cancelled` | Job cancelled | Acknowledge, offer to restart anytime |

## Out-of-sequence messages
If a message does not match an expected command for the current state, look up the state above and send the approved holding message for that state. Do not speculate. Do not improvise.
