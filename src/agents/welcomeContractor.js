const { getStripe } = require('../services/stripe');
const { updateWorker, getMarketById } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { CONTRACTOR_TOS_PATH } = require('../utils/constants');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveMarket(workerRecord) {
  let marketNumber = process.env.TWILIO_PHONE_NUMBER;
  let market = null;
  if (workerRecord.market_id) {
    market = await getMarketById(workerRecord.market_id);
    if (market && market.twilio_number) {
      marketNumber = market.twilio_number;
    } else {
      console.warn(`[welcomeContractor] market lookup failed for market_id ${workerRecord.market_id} — falling back to TWILIO_PHONE_NUMBER`);
    }
  }
  return { marketNumber, market };
}

// Step 1 of contractor onboarding. Called immediately after worker record is created
// (status: pending_tos). Sends TOS message and waits for AGREE reply.
async function welcomeContractor(workerRecord) {
  const { marketNumber, market } = await resolveMarket(workerRecord);

  const domain = (market && market.domain) || 'gotaguymckinney.com';
  const tosUrl = `${domain}${CONTRACTOR_TOS_PATH}`;

  const tosMsg =
    `Hey, welcome to GotaGuy. We're glad to have you on the roster.\n\n` +
    `Before we get you set up, take a quick look at our sub agreement: ${tosUrl}\n\n` +
    `It covers how jobs are dispatched, how you get paid, and what we expect on the job.\n\n` +
    `Reply AGREE to confirm and we'll get your payment setup going. Reply STOP anytime to opt out.`;

  await sendSMS(workerRecord.phone, tosMsg, marketNumber);

  try {
    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      history: [{ ts: new Date().toISOString(), agent: 'welcomeContractor', action: 'TOS message sent' }],
    });
  } catch (err) {
    console.error('Failed to update worker history after TOS send:', err.message);
  }

  console.log(`TOS message sent to ${workerRecord.phone}`);
}

// Step 2 of contractor onboarding. Called after contractor replies AGREE.
// Guard: if tos_agreed is false (should not happen in normal flow), re-sends TOS instead.
async function sendStripeOnboarding(workerRecord) {
  if (!workerRecord.tos_agreed) {
    console.warn(`[sendStripeOnboarding] worker ${workerRecord.phone} has not agreed to TOS — re-sending TOS message`);
    return welcomeContractor(workerRecord);
  }

  const name = (workerRecord.data && workerRecord.data.name) || 'there';
  const firstName = name.split(' ')[0];

  const { marketNumber } = await resolveMarket(workerRecord);

  // Message 1 — intro and platform explainer
  const businessName = workerRecord.data && workerRecord.data.business_name;
  const msg1 = businessName
    ? `Hey ${firstName} - Wade here. Welcome to GotaGuy on behalf of ${businessName}. Jobs will come to this number - claim them, dispatch your team your way, and text ARRIVED when they're on site and DONE when the job is complete. Pay hits your account same day. One step to get set up:`
    : `Hey ${firstName} - Wade here. Welcome to GotaGuy. I'm sending repair jobs your way - pre-scoped, quoted, and ready to go. Pay hits your debit card the same day the job closes. One quick step to get set up for payouts:`;

  await sendSMS(workerRecord.phone, msg1, marketNumber);

  // Create Stripe Express account + onboarding link
  let stripeUrl = null;
  let accountId = null;

  try {
    const stripe = getStripe();

    console.log(`[sendStripeOnboarding] Creating Stripe Express account for ${workerRecord.phone}`);
    let account;
    try {
      account = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      console.log(`[sendStripeOnboarding] Stripe Express account created: ${accountId}`);
    } catch (err) {
      console.error(`[sendStripeOnboarding] stripe.accounts.create failed for ${workerRecord.phone} - code: ${err.code} type: ${err.type} message: ${err.message}`, err);
      throw err;
    }

    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      stripe_account_id: accountId,
    });

    console.log(`[sendStripeOnboarding] Creating account link for ${accountId}`);
    let accountLink;
    try {
      accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/refresh?account_id=' + accountId,
        return_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/return?account_id=' + accountId,
        type: 'account_onboarding',
      });
      console.log(`[sendStripeOnboarding] Account link created successfully for ${accountId}`);
    } catch (err) {
      console.error(`[sendStripeOnboarding] stripe.accountLinks.create failed for ${accountId} - code: ${err.code} type: ${err.type} message: ${err.message}`, err);
      throw err;
    }

    stripeUrl = accountLink.url;
  } catch (err) {
    console.error(`[sendStripeOnboarding] Stripe setup failed for ${workerRecord.phone} - ${err.message}`);
  }

  await delay(3000);

  // Message 2 — Stripe link or fallback
  if (stripeUrl) {
    const msg2 = `Add your debit card here - takes about 90 seconds: ${stripeUrl}\n\nOnce that's done I'll send you a sample of what a job card looks like. Any questions just reply here.`;
    await sendSMS(workerRecord.phone, msg2, marketNumber);
  } else {
    await sendSMS(workerRecord.phone, "We'll send you a setup link shortly - hang tight.", marketNumber);
    await sendSMS(process.env.MY_CELL_NUMBER, `STRIPE ERROR - could not generate Express link for ${name} ${workerRecord.phone}`);
  }

  // Message 3 — language preference
  await delay(3000);
  try {
    await sendSMS(workerRecord.phone, 'One quick question - what language do you prefer for job notifications? Reply EN for English or ES for Spanish.', marketNumber);
  } catch (err) {
    console.error('Failed to send language preference SMS:', err.message);
  }

  try {
    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {
      history: [{ ts: new Date().toISOString(), agent: 'welcomeContractor', action: 'Stripe Express link generated, language preference asked' }],
    });
  } catch (err) {
    console.error('Failed to update worker history after Stripe onboarding:', err.message);
  }

  console.log(`Stripe onboarding sequence sent to ${workerRecord.phone} (${name})`);
}

module.exports = { welcomeContractor, sendStripeOnboarding };
