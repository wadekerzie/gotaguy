const express = require('express');
const router = express.Router();
const { getWorkerByPhone } = require('../db/client');
const supabase = require('../db/client');
const { COLLIN_COUNTY_ZIPS, TRADES } = require('../utils/constants');

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
    const { name, trade, phone } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: 'name is required and must be 2-50 characters' });
    }
    if (!trade || !TRADES.includes(trade)) {
      return res.status(400).json({ error: `trade is required and must be one of: ${TRADES.join(', ')}` });
    }
    if (!phone || !/^\+1\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'phone is required in E.164 format (+1XXXXXXXXXX)' });
    }

    // Check if phone already exists
    const existing = await getWorkerByPhone(phone);
    if (existing) {
      return res.status(409).json({ error: 'Worker with this phone already exists' });
    }

    // Create worker record
    const { data: worker, error: createErr } = await supabase
      .from('workers')
      .insert({
        phone,
        status: 'pending_stripe',
        data: {
          name,
          trade,
          zip_codes: COLLIN_COUNTY_ZIPS,
          onboarding: {
            tier: 1,
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

    console.log(`Admin created worker: ${name} (${trade}) ${phone}`);
    return res.status(201).json(worker);
  } catch (err) {
    console.error('Admin contractor creation error:', err.message);
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
