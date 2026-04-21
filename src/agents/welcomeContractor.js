const { getStripe } = require('../services/stripe');
const { updateWorker, getMarketById } = require('../db/client');
const { sendSMS } = require('../services/twilio');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function welcomeContractor(workerRecord) {
  const name = (workerRecord.data && workerRecord.data.name) || 'there';
  const firstName = name.split(' ')[0];

  // Resolve the correct outbound Twilio number for this worker's market
  let marketNumber = process.env.TWILIO_PHONE_NUMBER;
  if (workerRecord.market_id) {
    const market = await getMarketById(workerRecord.market_id);
    if (market && market.twilio_number) {
      marketNumber = market.twilio_number;
    } else {
      console.warn(`[welcomeContractor] market lookup failed for market_id ${workerRecord.market_id} — falling back to TWILIO_PHONE_NUMBER`);
    }
  }

  // Message 1 — always send
  const businessName = workerRecord.data && workerRecord.data.business_name;
  const msg1 = businessName
    ? `Hey ${firstName} - Wade here. Welcome to GotaGuy on behalf of ${businessName}. Jobs will come to this number - claim them, dispatch your team your way, and text ARRIVED when they're on site and DONE when the job is complete. Pay hits your account same day. One step to get set up:`
    : `Hey ${firstName} - Wade here. Welcome to GotaGuy. I'm sending repair jobs your way in Collin County - pre-scoped, quoted, and ready to go. Pay hits your debit card the same day the job closes. One quick step to get set up for payouts:`;

  await sendSMS(workerRecord.phone, msg1, marketNumber);

  // Try to generate Stripe Express account + onboarding link
  let stripeUrl = null;
  let accountId = null;

  try {
    const stripe = getStripe();

    console.log(`[welcomeContractor] Creating Stripe Express account for ${workerRecord.phone}`);
    let account;
    try {
      account = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      console.log(`[welcomeContractor] Stripe Express account created: ${accountId}`);
    } catch (err) {
      console.error(`[welcomeContractor] stripe.accounts.create failed for ${workerRecord.phone} - code: ${err.code} type: ${err.type} message: ${err.message}`, err);
      throw err;
    }

    // Store stripe_account_id on worker record immediately
    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      stripe_account_id: accountId,
    });

    console.log(`[welcomeContractor] Creating account link for ${accountId}`);
    let accountLink;
    try {
      accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/refresh?account_id=' + accountId,
        return_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/return?account_id=' + accountId,
        type: 'account_onboarding',
      });
      console.log(`[welcomeContractor] Account link created successfully for ${accountId}`);
    } catch (err) {
      console.error(`[welcomeContractor] stripe.accountLinks.create failed for ${accountId} - code: ${err.code} type: ${err.type} message: ${err.message}`, err);
      throw err;
    }

    stripeUrl = accountLink.url;
  } catch (err) {
    console.error(`[welcomeContractor] Stripe setup failed for ${workerRecord.phone} - ${err.message}`);
  }

  // 3-second delay between messages
  await delay(3000);

  // Message 2
  if (stripeUrl) {
    const msg2 = `Add your debit card here - takes about 90 seconds: ${stripeUrl}\n\nOnce that's done I'll send you a sample of what a job card looks like. Any questions just reply here.`;
    await sendSMS(workerRecord.phone, msg2, marketNumber);
  } else {
    // Stripe failed — send fallback
    await sendSMS(workerRecord.phone, "We'll send you a setup link shortly - hang tight.", marketNumber);
    await sendSMS(process.env.MY_CELL_NUMBER, `STRIPE ERROR - could not generate Express link for ${name} ${workerRecord.phone}`);
  }

  // Language preference question
  await delay(3000);
  try {
    await sendSMS(workerRecord.phone, 'One quick question - what language do you prefer for job notifications? Reply EN for English or ES for Spanish.', marketNumber);
  } catch (err) {
    console.error('Failed to send language preference SMS:', err.message);
  }

  // Append to worker history
  try {
    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      history: [{ ts: new Date().toISOString(), agent: 'welcomeContractor', action: 'welcome SMS sent, Stripe Express link generated, language preference asked' }],
    });
  } catch (err) {
    console.error('Failed to update worker history:', err.message);
  }

  console.log(`Welcome sequence sent to ${workerRecord.phone} (${name})`);
}

module.exports = { welcomeContractor };
