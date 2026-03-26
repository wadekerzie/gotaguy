const express = require('express');
const twilio = require('twilio');
const router = express.Router();
const { resolveContact } = require('../utils/router');
const { runCustomerAgent } = require('../agents/customerAgent');
const { runContractorAgent } = require('../agents/contractorAgent');
const { updateCustomer, updateWorker, getCustomerById, getWorkerById } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { dispatchJob } = require('../agents/dispatchAgent');
const { getStripe } = require('../services/stripe');
const { calculateFee } = require('../utils/fees');
const supabase = require('../db/client');

// Twilio signature validation middleware
function validateTwilioSignature(req, res, next) {
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!valid) {
    console.warn('Invalid Twilio signature');
    return res.status(403).send('Forbidden');
  }
  next();
}

router.post('/', validateTwilioSignature, async (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  try {
    const from = req.body.From;
    const body = req.body.Body || '';
    const trimmedBody = body.trim().toUpperCase();
    const mediaUrl = req.body.MediaUrl0 || null;
    const mediaType = req.body.MediaContentType0 || null;

    console.log(`Inbound SMS from ${from}: ${body}${mediaUrl ? ' [+photo]' : ''}`);

    // --- STOP/HELP/START handling (before any routing) ---
    if (trimmedBody === 'STOP') {
      console.log(`STOP received from ${from} - Twilio handles opt-out`);
      return;
    }
    if (trimmedBody === 'HELP') {
      await sendSMS(from, `GotaGuy home repair. Reply with what needs fixing or call/text ${process.env.MY_CELL_NUMBER} for help.`);
      return;
    }
    if (trimmedBody === 'UNSTOP' || trimmedBody === 'START') {
      console.log(`Resubscription from ${from}`);
      return;
    }

    // Resolve contact
    const { type, record } = await resolveContact(from);

    // --- Worker flow ---
    if (type === 'worker') {
      // Find the customer record this worker is assigned to (if any)
      let customerRecord = null;
      const { data: assignedCustomers } = await supabase
        .from('customers')
        .select('*')
        .in('status', ['dispatched', 'active', 'price_locked', 'complete'])
        .order('created_at', { ascending: false });

      if (assignedCustomers) {
        customerRecord = assignedCustomers.find(c =>
          c.data && c.data.schedule && c.data.schedule.worker_id === record.id
        );
      }

      // If no assigned customer and command is CLAIM, find most recent dispatched job
      if (!customerRecord && trimmedBody === 'CLAIM') {
        const { data: dispatchedJobs } = await supabase
          .from('customers')
          .select('*')
          .eq('status', 'dispatched')
          .order('created_at', { ascending: false })
          .limit(1);

        if (dispatchedJobs && dispatchedJobs.length > 0) {
          customerRecord = dispatchedJobs[0];
        }
      }

      const result = await runContractorAgent(record, customerRecord, body);

      // Update worker comms
      const outMsg = result.reply || '';
      await updateWorker(from, record.status, body, outMsg, {});
      return;
    }

    // --- Customer flow ---

    // YES/NO handling when customer status is complete
    if (record.status === 'complete' && trimmedBody === 'YES') {
      await handleYes(record, from);
      return;
    }
    if (record.status === 'complete' && trimmedBody === 'NO') {
      await handleNo(record, from);
      return;
    }

    // Normal customer agent flow
    const { reply, newStatus, flag } = await runCustomerAgent(record, body, mediaUrl);

    if (flag === 'human') {
      await sendSMS(process.env.MY_CELL_NUMBER, `EXCEPTION - ${from}: ${body}`);
      await sendSMS(from, "You've been connected with our team. Someone will text you shortly.");
    } else {
      await sendSMS(from, reply);
    }

    const additionalData = {};
    if (mediaUrl) {
      const photos = (record.data && record.data.photos) || [];
      photos.push({ ts: new Date().toISOString(), url: mediaUrl, type: mediaType });
      additionalData.photos = photos;
    }

    if (newStatus === 'quoting') {
      const priceMatch = reply.match(/\$(\d+)[^$]*\$(\d+)/);
      if (priceMatch) {
        if (!additionalData.job) additionalData.job = {};
        additionalData.job.quoted_price_low = parseInt(priceMatch[1], 10);
        additionalData.job.quoted_price_high = parseInt(priceMatch[2], 10);
      }
    }

    const outboundMsg = flag === 'human'
      ? "You've been connected with our team. Someone will text you shortly."
      : reply;

    const updatedRecord = await updateCustomer(from, newStatus, body, outboundMsg, additionalData);

    if (newStatus === 'agreed') {
      dispatchJob(updatedRecord).catch(err => {
        console.error('Dispatch trigger error:', err.message);
      });
    }

  } catch (err) {
    console.error('SMS webhook error:', err.message);
  }
});

async function handleYes(customerRecord, from) {
  try {
    const invoice = (customerRecord.data && customerRecord.data.invoice) || {};
    const paymentIntentId = invoice.stripe_payment_intent_id;

    if (!paymentIntentId) {
      await sendSMS(from, "We're having trouble finding your payment info. Text us at " + process.env.MY_CELL_NUMBER + " for help.");
      return;
    }

    // Capture the payment
    const stripe = getStripe();
    try {
      await stripe.paymentIntents.capture(paymentIntentId);
    } catch (err) {
      console.error('Stripe capture failed:', err.message);
      await sendSMS(from, "There was an issue processing your payment. We're looking into it - text " + process.env.MY_CELL_NUMBER + " if you need help.");
      await sendSMS(process.env.MY_CELL_NUMBER, `CAPTURE FAILED - ${from} - PI: ${paymentIntentId} - ${err.message}`);
      return;
    }

    const now = new Date().toISOString();
    const confirmedPrice = invoice.confirmed_price || 0;
    const payoutAmount = invoice.payout_amount || calculateFee(confirmedPrice).contractorPayout;

    // Update customer to closed
    await updateCustomer(from, 'closed', 'YES', null, {
      invoice: {
        ...invoice,
        status: 'captured',
        captured_at: now,
        payout_fired_at: now,
      },
    });

    // Look up contractor
    const workerId = customerRecord.data && customerRecord.data.schedule && customerRecord.data.schedule.worker_id;
    let worker = null;
    if (workerId) {
      try {
        worker = await getWorkerById(workerId);
      } catch (err) {
        console.error('Failed to look up worker:', err.message);
      }
    }

    // Initiate Stripe Connect transfer to contractor
    if (worker && worker.data && worker.data.stripe_account_id) {
      try {
        await stripe.transfers.create({
          amount: Math.round(payoutAmount * 100),
          currency: 'usd',
          destination: worker.data.stripe_account_id,
          transfer_group: customerRecord.id,
        });
      } catch (err) {
        console.error('Stripe transfer failed:', err.message);
        await sendSMS(process.env.MY_CELL_NUMBER, `PAYOUT FAILED - Worker ${workerId} - $${payoutAmount} - ${err.message}`);
      }
    }

    // Send receipt to customer
    try {
      await sendSMS(from, `Payment of $${confirmedPrice} confirmed. Thanks for using GotaGuy - we hope to be your go-to for anything around the house.`);
    } catch (err) {
      console.error('Failed to send receipt SMS:', err.message);
    }

    // Send payout confirmation to contractor
    if (worker) {
      try {
        await sendSMS(worker.phone, `Job closed. $${payoutAmount} is on its way to your debit card. Nice work.`);
      } catch (err) {
        console.error('Failed to send payout SMS:', err.message);
      }
    }

    console.log(`Payment captured for ${from}: $${confirmedPrice}, payout: $${payoutAmount}`);
  } catch (err) {
    console.error('handleYes error:', err.message);
  }
}

async function handleNo(customerRecord, from) {
  try {
    const invoice = (customerRecord.data && customerRecord.data.invoice) || {};
    const confirmedPrice = invoice.confirmed_price || 0;
    const jobCategory = (customerRecord.data.job && customerRecord.data.job.category) || 'unknown';

    // Get contractor name
    const workerId = customerRecord.data && customerRecord.data.schedule && customerRecord.data.schedule.worker_id;
    let contractorName = 'unknown';
    if (workerId) {
      try {
        const worker = await getWorkerById(workerId);
        if (worker && worker.data) contractorName = worker.data.name || 'unknown';
      } catch (err) {
        console.error('Failed to look up worker:', err.message);
      }
    }

    await sendSMS(from, "No problem - what's the concern? We want to make sure you're satisfied before releasing payment.");

    await sendSMS(process.env.MY_CELL_NUMBER, `DISPUTE - ${from} - Job ${customerRecord.id} - ${jobCategory} - $${confirmedPrice} - ${contractorName}`);

    await updateCustomer(from, 'complete', 'NO', "No problem - what's the concern? We want to make sure you're satisfied before releasing payment.", {});

    console.log(`Dispute flagged for ${from}: $${confirmedPrice}`);
  } catch (err) {
    console.error('handleNo error:', err.message);
  }
}

module.exports = router;
