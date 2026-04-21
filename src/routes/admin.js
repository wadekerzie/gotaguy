const express = require('express');
const router = express.Router();
const { getWorkerByPhone, getMarketByTwilioNumber, getMarketById } = require('../db/client');
const supabase = require('../db/client');
const { COLLIN_COUNTY_ZIPS, TRADES, LICENSED_TRADES } = require('../utils/constants');

// Auth middleware
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET) {
    console.warn(`Admin auth failed at ${new Date().toISOString()} from ${req.ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.post('/contractors', requireAdminKey, async (req, res) => {
  try {
    const { name, trade, trades, phone, market_id, zip_codes } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: 'name is required and must be 2-50 characters' });
    }

    // Accept single string (trade) or array (trades) — normalize to array
    let resolvedTrades;
    if (Array.isArray(trades) && trades.length > 0) {
      resolvedTrades = trades;
    } else if (typeof trade === 'string' && trade.length > 0) {
      resolvedTrades = [trade];
    } else {
      return res.status(400).json({ error: `trade or trades is required. Must be one or more of: ${TRADES.join(', ')}` });
    }
    const invalidTrades = resolvedTrades.filter(t => !TRADES.includes(t));
    if (invalidTrades.length > 0) {
      return res.status(400).json({ error: `Invalid trade(s): ${invalidTrades.join(', ')}. Must be one of: ${TRADES.join(', ')}` });
    }

    if (!phone || !/^\+1\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'phone is required in E.164 format (+1XXXXXXXXXX)' });
    }

    // Check if phone already exists
    const existing = await getWorkerByPhone(phone);
    if (existing) {
      return res.status(409).json({ error: 'Worker with this phone already exists' });
    }

    // Resolve market_id — explicit > McKinney default
    let resolvedMarketId = market_id || null;
    if (!resolvedMarketId) {
      const mckinney = await getMarketByTwilioNumber(process.env.TWILIO_PHONE_NUMBER);
      if (mckinney) resolvedMarketId = mckinney.id;
    }

    // Zip codes: explicit in body > McKinney defaults
    const resolvedZips = Array.isArray(zip_codes) && zip_codes.length > 0
      ? zip_codes
      : COLLIN_COUNTY_ZIPS;

    // Create worker record
    const { data: worker, error: createErr } = await supabase
      .from('workers')
      .insert({
        phone,
        status: 'pending_stripe',
        market_id: resolvedMarketId,
        data: {
          name,
          trades: resolvedTrades,
          zip_codes: resolvedZips,
          onboarding: {
            tier: 1,
            license_required: resolvedTrades.some(t => LICENSED_TRADES.includes(t)),
            license_verified: false,
            stripe_express_complete: false,
            jobs_completed: 0,
            lifetime_earnings: 0,
          },
        },
      })
      .select()
      .single();

    if (createErr) {
      console.error('Failed to create worker:', createErr.message);
      return res.status(500).json({ error: 'Failed to create worker record' });
    }

    // Fire welcome flow (async — don't block the response)
    try {
      const { welcomeContractor } = require('../agents/welcomeContractor');
      welcomeContractor(worker).catch(err => {
        console.error('welcomeContractor error:', err.message);
      });
    } catch (err) {
      console.warn('welcomeContractor not yet available:', err.message);
    }

    console.log(`Admin created worker: ${name} (${resolvedTrades.join(',')}) ${phone}`);
    return res.status(201).json(worker);
  } catch (err) {
    console.error('Admin contractor creation error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Deactivate a contractor
router.post('/contractors/:id/deactivate', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: worker, error: fetchErr } = await supabase
      .from('workers')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    const now = new Date().toISOString();
    const history = (worker.data && worker.data.history) || [];
    history.push({ ts: now, agent: 'admin', action: 'deactivated by admin' });

    await supabase
      .from('workers')
      .update({ status: 'inactive', data: { ...worker.data, history } })
      .eq('id', id);

    try {
      const { sendSMS } = require('../services/twilio');
      const deactivateMarket = worker.market_id ? await getMarketById(worker.market_id) : null;
      const deactivateMarketNumber = (deactivateMarket && deactivateMarket.twilio_number) || undefined;
      await sendSMS(worker.phone, 'Your GotaGuy account has been deactivated. Contact wade@kerzie.ai if you have questions.', deactivateMarketNumber);
    } catch (err) {
      console.error('Failed to send deactivation SMS:', err.message);
    }

    console.log(`Admin deactivated worker ${id} (${worker.phone})`);
    return res.status(200).json({ success: true, worker_id: id, status: 'inactive' });
  } catch (err) {
    console.error('Admin deactivation error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual dispatch override for waitlisted jobs
router.post('/dispatch/:customerId', requireAdminKey, async (req, res) => {
  try {
    const { customerId } = req.params;

    // Look up customer by UUID
    const { data: customer, error: fetchErr } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .single();

    if (fetchErr || !customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (customer.status !== 'waitlisted') {
      return res.status(400).json({ error: `Customer status is '${customer.status}', expected 'waitlisted'` });
    }

    const { retryDispatch } = require('../agents/dispatchAgent');
    const result = await retryDispatch(customer);

    if (result.dispatched) {
      console.log(`Admin force-dispatched Job #${customer.short_id || '????'} to ${result.workersNotified} workers`);
      return res.status(200).json({ success: true, workersNotified: result.workersNotified });
    }

    return res.status(200).json({ success: false, reason: result.reason, retryCount: result.retryCount });
  } catch (err) {
    console.error('Admin dispatch override error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
