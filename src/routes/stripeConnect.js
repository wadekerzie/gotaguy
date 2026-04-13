const express = require('express');
const router = express.Router();
const { getStripe } = require('../services/stripe');
const { updateWorker } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const supabase = require('../db/client');

// GET /stripe/connect/return — contractor completed Stripe Express onboarding
router.get('/return', async (req, res) => {
  const accountId = req.query.account_id;

  if (!accountId) {
    return res.status(400).send('<p style="font-family:sans-serif;text-align:center;padding:40px">Missing account ID. Please contact support.</p>');
  }

  try {
    // Look up worker by stripe_account_id
    const { data: workers, error: lookupErr } = await supabase
      .from('workers')
      .select('*')
      .eq('data->>stripe_account_id', accountId);

    if (lookupErr || !workers || workers.length === 0) {
      console.error('No worker found for Stripe account:', accountId);
      return res.send('<p style="font-family:sans-serif;text-align:center;padding:40px">You\'re all set. We\'ll text you when jobs are available in your area.</p>');
    }

    const worker = workers[0];
    const name = (worker.data && worker.data.name) || 'there';
    const firstName = name.split(' ')[0];
    const trade = (worker.data && worker.data.trade) || 'home repair';

    // Update worker: onboarding.stripe_express_complete = true, status = active
    await updateWorker(worker.phone, 'active', null, null, {
      onboarding: {
        ...((worker.data && worker.data.onboarding) || {}),
        stripe_express_complete: true,
      },
    });

    // Append to history
    const now = new Date().toISOString();
    const history = (worker.data && worker.data.history) || [];
    history.push({ ts: now, agent: 'stripeConnect', action: 'Express onboarding complete, status set to active' });
    await supabase
      .from('workers')
      .update({ data: { ...worker.data, history, onboarding: { ...((worker.data && worker.data.onboarding) || {}), stripe_express_complete: true } } })
      .eq('id', worker.id);

    // Send sample job card SMS
    try {
      await sendSMS(
        worker.phone,
        `You're all set ${firstName}. When a job comes in matching your area you'll get a text like this:\n\n${trade} repair - McKinney 75069\nWindow: Tue 4-7pm\nReply CLAIM to take it\n\nThat's it. We'll be in touch.`
      );
    } catch (err) {
      console.error('Failed to send onboarding complete SMS:', err.message);
    }

    console.log(`Stripe Connect onboarding complete for ${worker.phone} (${name})`);

    return res.send('<p style="font-family:sans-serif;text-align:center;padding:40px">You\'re all set. We\'ll text you when jobs are available in your area.</p>');
  } catch (err) {
    console.error('Stripe Connect return error:', err.message);
    return res.send('<p style="font-family:sans-serif;text-align:center;padding:40px">You\'re all set. We\'ll text you when jobs are available in your area.</p>');
  }
});

// GET /stripe/connect/refresh — contractor's link expired
router.get('/refresh', async (req, res) => {
  const accountId = req.query.account_id;

  if (!accountId) {
    return res.status(400).send('<p style="font-family:sans-serif;text-align:center;padding:40px">Missing account ID. Please contact support.</p>');
  }

  try {
    const stripe = getStripe();

    // Generate new account link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/refresh?account_id=' + accountId,
      return_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/return?account_id=' + accountId,
      type: 'account_onboarding',
    });

    // Try to find worker and SMS them the new link
    try {
      const { data: workers } = await supabase
        .from('workers')
        .select('*')
        .eq('data->>stripe_account_id', accountId);

      if (workers && workers.length > 0) {
        await sendSMS(workers[0].phone, `Your setup link expired - here's a fresh one: ${accountLink.url}`);
      }
    } catch (err) {
      console.error('Failed to SMS refresh link:', err.message);
    }

    // Redirect to new onboarding URL
    return res.redirect(accountLink.url);
  } catch (err) {
    console.error('Stripe Connect refresh error:', err.message);
    return res.status(500).send('<p style="font-family:sans-serif;text-align:center;padding:40px">Something went wrong. Please text us for a new link.</p>');
  }
});

module.exports = router;
