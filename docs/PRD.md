# GotaGuy - Product Requirements Document

## Overview

GotaGuy is an SMS-first home repair marketplace serving Collin County, TX. There is no app, no web form, and no account required. A homeowner texts a single phone number, an AI agent scopes the job, provides a price range, and matches them with a vetted local contractor. The contractor claims the job, shows up, and gets paid same-day via Stripe.

## How It Works

1. **Homeowner texts the GotaGuy number** describing their problem (e.g., "My kitchen faucet is leaking").
2. **AI scopes the job** by asking follow-up questions via SMS — trade category, urgency, photos if needed.
3. **AI quotes a price range** based on the job description and trade category.
4. **Homeowner agrees** to the price range and provides availability.
5. **Dispatch agent** finds matched contractors by trade and zip code, sends them a job card via SMS.
6. **Contractor claims the job**, confirms an ETA, and shows up.
7. **Contractor completes the work**, closes out the job via SMS.
8. **Homeowner is charged**, contractor is paid same-day via Stripe Connect.

## Scope Constraints

- **Trades:** Electrical, plumbing, HVAC, handyman
- **Repair only:** No remodels, no installs, no multi-day projects
- **One visit:** Single trade, single visit, parts from supply house
- **Budget:** Jobs under $800
- **Geography:** Collin County, TX (initial market)

## Fee Structure

- 10% of job value
- Minimum fee: $15
- Maximum fee: $150
