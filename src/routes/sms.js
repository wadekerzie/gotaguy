const express = require('express');
const twilio = require('twilio');
const router = express.Router();
const { resolveContact } = require('../utils/router');
const { runCustomerAgent } = require('../agents/customerAgent');
const { runContractorAgent } = require('../agents/contractorAgent');
const { updateCustomer, updateWorker, createWorker, getCustomerById, getWorkerById, generateShortId, getCustomerByShortId } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { dispatchJob } = require('../agents/dispatchAgent');
const { getStripe } = require('../services/stripe');
const { calculateFee } = require('../utils/fees');
const { classifyContact } = require('../utils/classifier');
const { translateForWorker } = require('../services/translate');
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
    let resolved = await resolveContact(from);

    // --- New contact (unknown number) ---
    if (!resolved) {
      const now = new Date().toISOString();
      const classification = await classifyContact(body);
      console.log(`Classified ${from} as: ${classification}`);

      if (classification === 'contractor') {
        // Create worker lead — do NOT proceed to any agent
        await createWorker(from);
        await supabase
          .from('workers')
          .update({
            status: 'lead',
            data: { first_message: body, flagged_at: now, source: 'inbound_sms' }
          })
          .eq('phone', from);
        await sendSMS(from, "Sounds like you might be one of the skilled tradespeople we work with. We'll pass your info to our team and someone will be in touch with you shortly.");
        await sendSMS(process.env.MY_CELL_NUMBER, `CONTRACTOR LEAD - ${from} - ${body}`);
        return;
      }

      if (classification === 'ambiguous') {
        // Create customer with ambiguous flag
        const ambiguousShortId = await generateShortId();
        const { data: newCustomer, error: createErr } = await supabase
          .from('customers')
          .insert({
            phone: from,
            status: 'new',
            short_id: ambiguousShortId,
            data: {
              ambiguous: true,
              classified_as: 'ambiguous',
              classified_at: now,
              comms: [{ ts: now, direction: 'in', body: body }],
              history: [{ ts: now, agent: 'classifier', action: 'classified as ambiguous' }]
            }
          })
          .select()
          .single();

        if (createErr) {
          console.error('Failed to create ambiguous customer:', createErr.message);
          return;
        }

        const ambiguousReply = "Hey - are you looking to get something fixed around the house, or are you a tradesperson looking to pick up jobs in Collin County?";
        await sendSMS(from, ambiguousReply);
        await updateCustomer(from, 'new', null, ambiguousReply, {});
        return;
      }

      // Default: homeowner — create customer and fall through to customerAgent
      const homeownerShortId = await generateShortId();
      const { data: newCustomer, error: createErr } = await supabase
        .from('customers')
        .insert({
          phone: from,
          status: 'new',
          short_id: homeownerShortId,
          data: {
            classified_as: 'homeowner',
            classified_at: now,
            comms: [],
            history: [{ ts: now, agent: 'classifier', action: 'classified as homeowner' }]
          }
        })
        .select()
        .single();

      if (createErr) {
        console.error('Failed to create homeowner customer:', createErr.message);
        return;
      }

      console.log(`New homeowner customer created for ${from}`);
      // Fall through to customer flow below with the new record
      resolved = { type: 'customer', record: newCustomer };
    }

    const { type, record } = resolved;

    // --- Worker lead returning ---
    if (type === 'worker' && record.status === 'lead') {
      await sendSMS(from, "We already have your info - someone from GotaGuy will be in touch soon.");
      return;
    }

    // --- Worker flow ---
    if (type === 'worker') {
      // Language preference during onboarding (pending_stripe status)
      if (record.status === 'pending_stripe' && (trimmedBody === 'EN' || trimmedBody === 'ES' || trimmedBody === 'LISTO')) {
        if (trimmedBody === 'EN') {
          await updateWorker(from, record.status, body, 'Got it - we will text you in English.', { language_preference: 'en' });
          await sendSMS(from, 'Got it - we will text you in English.');
          return;
        }
        if (trimmedBody === 'ES') {
          await updateWorker(from, record.status, body, 'Perfecto. Te enviaremos los trabajos en español. Nota importante: todos nuestros clientes hablan inglés. Es necesario que alguien en tu equipo pueda comunicarse en inglés en el trabajo. Reply LISTO when you understand.', { language_preference: 'es' });
          await sendSMS(from, 'Perfecto. Te enviaremos los trabajos en español. Nota importante: todos nuestros clientes hablan inglés. Es necesario que alguien en tu equipo pueda comunicarse en inglés en el trabajo. Reply LISTO when you understand.');
          return;
        }
        if (trimmedBody === 'LISTO') {
          await updateWorker(from, record.status, body, 'Entendido. Estarás listo para recibir trabajos en tu área pronto.', {});
          await sendSMS(from, 'Entendido. Estarás listo para recibir trabajos en tu área pronto.');
          return;
        }
      }

      // BUSY/AVAILABLE toggle
      if (trimmedBody === 'BUSY') {
        await updateWorker(from, 'busy', body, "Got it, you won't receive job cards until you text AVAILABLE.", {});
        await sendSMS(from, "Got it, you won't receive job cards until you text AVAILABLE.");
        return;
      }
      if (trimmedBody === 'AVAILABLE') {
        await updateWorker(from, 'active', body, "You're back on. Job cards will resume immediately.", {});
        await sendSMS(from, "You're back on. Job cards will resume immediately.");
        return;
      }

      // Parse command + optional job ID (e.g. "CLAIM 4821", "ARRIVED", "DONE 3190")
      const commandMatch = trimmedBody.match(/^(CLAIM|ARRIVED|DONE)(?:\s+(\d{4}))?$/);
      const commandKeyword = commandMatch ? commandMatch[1] : null;
      const commandJobId = commandMatch ? (commandMatch[2] ? parseInt(commandMatch[2], 10) : null) : null;

      let customerRecord = null;

      if (commandJobId) {
        // Explicit job ID provided — look up by short_id
        try {
          customerRecord = await getCustomerByShortId(commandJobId);
        } catch (err) {
          await sendSMS(from, `We can't find job #${commandJobId}. Double-check the number and try again.`);
          return;
        }
      } else if (commandKeyword === 'CLAIM') {
        // CLAIM with no job ID — find most recent dispatched job
        const { data: dispatchedJobs } = await supabase
          .from('customers')
          .select('*')
          .eq('status', 'dispatched')
          .order('created_at', { ascending: false })
          .limit(1);

        if (dispatchedJobs && dispatchedJobs.length > 0) {
          customerRecord = dispatchedJobs[0];
        }
      } else if (commandKeyword) {
        // ARRIVED or DONE with no job ID — find jobs assigned to this worker
        const { data: assignedCustomers } = await supabase
          .from('customers')
          .select('*')
          .in('status', ['active', 'price_locked', 'complete'])
          .order('created_at', { ascending: false });

        const myJobs = (assignedCustomers || []).filter(c =>
          c.data && c.data.schedule && c.data.schedule.worker_id === record.id
        );

        if (myJobs.length === 1) {
          customerRecord = myJobs[0];
        } else if (myJobs.length > 1) {
          const jobList = myJobs.map(j => `#${j.short_id || '?'}`).join(', ');
          await sendSMS(from, `You have multiple active jobs (${jobList}) - please include the job number, e.g. ${commandKeyword} ${myJobs[0].short_id || '0000'}.`);
          return;
        }
      } else {
        // Free text — find assigned customer for context
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
      }

      const result = await runContractorAgent(record, customerRecord, body);

      // Update worker comms
      const outMsg = result.reply || '';
      await updateWorker(from, record.status, body, outMsg, {});
      return;
    }

    // --- Customer flow ---

    // --- Waitlisted customer handling ---
    if (record.status === 'waitlisted') {
      if (trimmedBody === 'CANCEL') {
        const shortId = record.short_id || '????';
        await updateCustomer(from, 'closed', 'CANCEL', null, {});
        await sendSMS(from, `Job #${shortId} has been cancelled. Text us anytime you need help with something around the house.`);
        await sendSMS(process.env.MY_CELL_NUMBER, `WAITLIST CANCEL - Job #${shortId} - ${from} cancelled while waitlisted.`);
        console.log(`Waitlisted job #${shortId} cancelled by customer ${from}`);
        return;
      }
      // Any other text — holding message
      await sendSMS(from, "We're still working on finding a pro for your job. We'll text you as soon as someone's available. Reply CANCEL if you'd like to cancel.");
      await updateCustomer(from, 'waitlisted', body, "We're still working on finding a pro for your job. We'll text you as soon as someone's available. Reply CANCEL if you'd like to cancel.", {});
      return;
    }

    // Opt-out: homeowner replied NO to a stall reminder
    const STALLED_STATUSES = ['new', 'scoping', 'quoting', 'scheduling'];
    if (STALLED_STATUSES.includes(record.status) && (record.data.reminders_sent || 0) > 0 && trimmedBody === 'NO') {
      const optOutMsg = "Got it — we won't follow up on this one. Text us anytime you need help down the road.";
      await updateCustomer(from, 'closed', 'NO', optOutMsg, { opted_out: true });
      await sendSMS(from, optOutMsg);
      return;
    }

    // YES/NO handling when customer status is complete or price_locked
    if ((record.status === 'complete' || record.status === 'price_locked') && trimmedBody === 'YES') {
      await handleYes(record, from);
      return;
    }
    if ((record.status === 'complete' || record.status === 'price_locked') && trimmedBody === 'NO') {
      await handleNo(record, from);
      return;
    }

    // Download and permanently store any inbound photo before passing to agent
    let permanentMediaUrl = null;
    if (mediaUrl) {
      permanentMediaUrl = await storePhoto(mediaUrl, from);
    }

    // Normal customer agent flow
    const { reply, newStatus, trade, contact, availability, flag } = await runCustomerAgent(record, body, permanentMediaUrl);

    // Append TOS notice on very first outbound SMS to a new homeowner
    const isFirstMessage = !record.data.comms || record.data.comms.length === 0;
    const tosNotice = '\n\nBy texting GotaGuy you agree to our terms at gotaguymckinney.com/terms.';

    if (flag === 'human') {
      await sendSMS(process.env.MY_CELL_NUMBER, `EXCEPTION - ${from}: ${body}`);
      const humanMsg = "You've been connected with our team. Someone will text you shortly.";
      await sendSMS(from, isFirstMessage ? humanMsg + tosNotice : humanMsg);
    } else {
      await sendSMS(from, isFirstMessage ? reply + tosNotice : reply);
    }

    const additionalData = {};
    if (permanentMediaUrl) {
      const photos = (record.data && record.data.photos) || [];
      photos.push({ ts: new Date().toISOString(), url: permanentMediaUrl, type: mediaType });
      additionalData.photos = photos;
    }

    if (trade) {
      if (!additionalData.job) additionalData.job = {};
      additionalData.job.category = trade;
    }

    if (contact) {
      const existing = (record.data && record.data.contact) || {};
      additionalData.contact = { ...existing };
      if (contact.address) additionalData.contact.address = contact.address;
      if (contact.name) additionalData.contact.name = contact.name;
    }

    if (availability) {
      additionalData.availability = {
        ...((record.data && record.data.availability) || {}),
        window: availability,
      };
    }

    // Reset reminder counter when stalled customer re-engages
    if (STALLED_STATUSES.includes(record.status) && (record.data.reminders_sent || 0) > 0) {
      additionalData.reminders_sent = 0;
      additionalData.first_reminder_at = null;
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
      const { platformFee } = calculateFee(confirmedPrice);
      await stripe.paymentIntents.capture(paymentIntentId, {
        application_fee_amount: Math.round(platformFee * 100),
      });
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

    const jobId = customerRecord.short_id || '????';

    // Send receipt to customer
    try {
      await sendSMS(from, `Payment of $${confirmedPrice} confirmed for Job #${jobId}. Thanks for using GotaGuy - we hope to be your go-to for anything around the house.`);
    } catch (err) {
      console.error('Failed to send receipt SMS:', err.message);
    }

    // Send Google review request to customer
    if (process.env.GOOGLE_REVIEW_LINK) {
      try {
        await sendSMS(from, `Happy to hear it. If you have 60 seconds, a Google review helps us bring more great pros to McKinney: ${process.env.GOOGLE_REVIEW_LINK}. Thanks for using GotaGuy.`);
      } catch (err) {
        console.error('Failed to send Google review SMS:', err.message);
      }
    }

    // Send payout confirmation to contractor
    if (worker) {
      try {
        const payoutMsg = await translateForWorker(`Job #${jobId} closed. $${payoutAmount} is on its way to your debit card. Nice work.`, worker);
        await sendSMS(worker.phone, payoutMsg);
      } catch (err) {
        console.error('Failed to send payout SMS:', err.message);
      }
    }

    console.log(`Payment captured for ${from}: Job #${jobId} $${confirmedPrice}, payout: $${payoutAmount}`);
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

    const jobId = customerRecord.short_id || '????';
    await sendSMS(process.env.MY_CELL_NUMBER, `DISPUTE - ${from} - Job #${jobId} - ${jobCategory} - $${confirmedPrice} - ${contractorName}`);

    await updateCustomer(from, 'complete', 'NO', "No problem - what's the concern? We want to make sure you're satisfied before releasing payment.", {});

    console.log(`Dispute flagged for ${from}: $${confirmedPrice}`);
  } catch (err) {
    console.error('handleNo error:', err.message);
  }
}

async function storePhoto(twilioUrl, phone) {
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(twilioUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const ext = (contentType.split('/')[1] || 'jpg').split(';')[0];
    const filename = `${phone.replace('+', '')}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from('job-photos')
      .upload(filename, Buffer.from(buffer), { contentType, upsert: false });
    if (error) throw error;
    const { data } = supabase.storage.from('job-photos').getPublicUrl(filename);
    return data.publicUrl;
  } catch (err) {
    console.error('storePhoto error:', err.message);
    return twilioUrl;
  }
}

module.exports = router;
