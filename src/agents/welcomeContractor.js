const { getStripe } = require('../services/stripe');
const { updateWorker } = require('../db/client');
const { sendSMS } = require('../services/twilio');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function welcomeContractor(workerRecord) {
  const name = (workerRecord.data && workerRecord.data.name) || 'there';
  const firstName = name.split(' ')[0];

  // Message 1 — always send
  const businessName = workerRecord.data && workerRecord.data.business_name;
  const msg1 = businessName
    ? `Hey ${firstName} - Wade here. Welcome to GotaGuy on behalf of ${businessName}. Jobs will come to this number - claim them, dispatch your team your way, and text ARRIVED when they're on site and DONE when the job is complete. Pay hits your account same day. One step to get set up:`
    : `Hey ${firstName} - Wade here. Welcome to GotaGuy. I'm sending repair jobs your way in Collin County - pre-scoped, quoted, and ready to go. Pay hits your debit card the same day the job closes. One quick step to get set up for payouts:`;

  await sendSMS(workerRecord.phone, msg1);

  // Try to generate Stripe Express account + onboarding link
  let stripeUrl = null;
  let accountId = null;

  try {
    const stripe = getStripe();

    const account = await stripe.accounts.create({
      type: 'express',
      capabilities: {
        transfers: { requested: true },
      },
    });
    accountId = account.id;

    // Store stripe_account_id on worker record immediately
    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      stripe_account_id: accountId,
    });

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/refresh?account_id=' + accountId,
      return_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/return?account_id=' + accountId,
      type: 'account_onboarding',
    });

    stripeUrl = accountLink.url;
  } catch (err) {
    console.error('Stripe Express account creation error:', err.message);
  }

  // 3-second delay between messages
  await delay(3000);

  // Message 2
  if (stripeUrl) {
    const msg2 = `Add your debit card here - takes about 90 seconds: ${stripeUrl}\n\nOnce that's done I'll send you a sample of what a job card looks like. Any questions just reply here.`;
    await sendSMS(workerRecord.phone, msg2);
  } else {
    // Stripe failed — send fallback
    await sendSMS(workerRecord.phone, "We'll send you a setup link shortly - hang tight.");
    await sendSMS(process.env.MY_CELL_NUMBER, `STRIPE ERROR - could not generate Express link for ${name} ${workerRecord.phone}`);
  }

  // Append to worker history
  try {
    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      history: [{ ts: new Date().toISOString(), agent: 'welcomeContractor', action: 'welcome SMS sent, Stripe Express link generated' }],
    });
  } catch (err) {
    console.error('Failed to update worker history:', err.message);
  }

  console.log(`Welcome sequence sent to ${workerRecord.phone} (${name})`);
}

module.exports = { welcomeContractor };
