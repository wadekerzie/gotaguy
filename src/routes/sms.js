// v2
const express = require('express');
const twilio = require('twilio');
const router = express.Router();
const { resolveContact } = require('../utils/router');
const { runCustomerAgent } = require('../agents/customerAgent');
const { runContractorAgent } = require('../agents/contractorAgent');
const { updateCustomer, updateWorker, createWorker, getCustomerById, getWorkerById, generateShortId, getCustomerByShortId, getMarketById } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { dispatchJob, sendJobCardToWorker } = require('../agents/dispatchAgent');
const { getStripe } = require('../services/stripe');
const { calculateFee } = require('../utils/fees');
const { classifyContact } = require('../utils/classifier');
const { translateForWorker } = require('../services/translate');
const { MSG_SCHEDULE_PROMPT, GOOGLE_REVIEW_URL_MCKINNEY, MSG_REVIEW_REQUEST, TRADES, TRADE_ALIASES, TRADE_LABELS } = require('../utils/constants');
const { notifyJerry } = require('../utils/jerryNotify');
const { sendStripeOnboarding, welcomeContractor } = require('../agents/welcomeContractor');
const supabase = require('../db/client');

const SYSTEM_NUMBERS = [
  process.env.JERRY_TWILIO_NUMBER,
  process.env.TWILIO_PHONE_NUMBER,
].filter(Boolean);

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
  const from = req.body.From;

  if (SYSTEM_NUMBERS.includes(from)) {
    console.log(`Inbound from system number ${from} - ignored`);
    return res.sendStatus(200);
  }

  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  try {
    const inboundTo = req.body.To || process.env.TWILIO_PHONE_NUMBER;
    const body = req.body.Body || '';
    const trimmedBody = body.trim().toUpperCase();
    const mediaUrl = req.body.MediaUrl0 || null;
    const mediaType = req.body.MediaContentType0 || null;

    console.log(`Inbound SMS from ${from}: ${body}${mediaUrl ? ' [+photo]' : ''}`);
    console.log('FROM:', JSON.stringify(from), 'MY_CELL:', JSON.stringify(process.env.MY_CELL_NUMBER), 'MATCH:', from === process.env.MY_CELL_NUMBER, 'BODY:', JSON.stringify(trimmedBody));

    // --- STOP/HELP/START handling (before any routing) ---
    if (trimmedBody === 'STOP') {
      console.log(`STOP received from ${from} - Twilio handles opt-out`);
      return;
    }
    if (trimmedBody === 'HELP') {
      await sendSMS(from, `GotaGuy home repair. Reply with what needs fixing or call/text ${process.env.MY_CELL_NUMBER} for help.`, inboundTo);
      return;
    }
    if (trimmedBody === 'UNSTOP' || trimmedBody === 'START') {
      console.log(`Resubscription from ${from}`);
      return;
    }

    // Resolve contact
    let resolved = await resolveContact(from);

    // --- AGREE handling — must come before all other routing so it is never
    //     passed to the AI classifier ---
    if (trimmedBody === 'AGREE') {
      if (!resolved || resolved.type !== 'worker') {
        await sendSMS(from, "We don't have an application on file for this number. Questions? Text HELP.", inboundTo);
        return;
      }
      const agreeWorker = resolved.record;
      if (agreeWorker.status !== 'pending_tos') {
        await sendSMS(from, "You're already set up! Text HELP if you need anything.", inboundTo);
        return;
      }
      // Log TOS agreement and advance to pending_stripe
      const agreedAt = new Date().toISOString();
      await supabase
        .from('workers')
        .update({ tos_agreed: true, tos_agreed_at: agreedAt, status: 'pending_stripe' })
        .eq('phone', from);
      await updateWorker(from, 'pending_stripe', body, null, {});
      console.log(`TOS agreed by ${from} at ${agreedAt}`);
      const updatedWorker = { ...agreeWorker, tos_agreed: true, tos_agreed_at: agreedAt, status: 'pending_stripe' };
      sendStripeOnboarding(updatedWorker).catch(err => console.error('sendStripeOnboarding error:', err.message));
      try {
        await notifyJerry('WORKER_PENDING_STRIPE', updatedWorker, updatedWorker.market_id || 'unknown');
      } catch (err) {
        console.error('Jerry notification failed:', err.message);
      }
      return;
    }

    // --- RECRUIT admin command (admin phone only) ---
    if (from === process.env.MY_CELL_NUMBER && trimmedBody.startsWith('RECRUIT ')) {
      await handleRecruit(from, body, inboundTo);
      return;
    }

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
        await sendSMS(from, "Sounds like you might be one of the skilled tradespeople we work with. We'll pass your info to our team and someone will be in touch with you shortly.", inboundTo);
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
        await sendSMS(from, ambiguousReply, inboundTo);
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
      await sendSMS(from, "We already have your info - someone from GotaGuy will be in touch soon.", inboundTo);
      return;
    }

    // --- Worker flow ---
    if (type === 'worker') {
      // pending_tos workers must reply AGREE before anything else proceeds
      if (record.status === 'pending_tos') {
        await sendSMS(from, "Please reply AGREE to accept our Contractor Terms of Service and continue setup, or STOP to opt out.", inboundTo);
        return;
      }

      // Language preference during onboarding (pending_stripe status)
      if (record.status === 'pending_stripe' && (trimmedBody === 'EN' || trimmedBody === 'ES' || trimmedBody === 'LISTO')) {
        if (trimmedBody === 'EN') {
          await updateWorker(from, record.status, body, 'Got it - we will text you in English.', { language_preference: 'en' });
          await sendSMS(from, 'Got it - we will text you in English.', inboundTo);
          return;
        }
        if (trimmedBody === 'ES') {
          await updateWorker(from, record.status, body, 'Perfecto. Te enviaremos los trabajos en español. Nota importante: todos nuestros clientes hablan inglés. Es necesario que alguien en tu equipo pueda comunicarse en inglés en el trabajo. Reply LISTO when you understand.', { language_preference: 'es' });
          await sendSMS(from, 'Perfecto. Te enviaremos los trabajos en español. Nota importante: todos nuestros clientes hablan inglés. Es necesario que alguien en tu equipo pueda comunicarse en inglés en el trabajo. Reply LISTO when you understand.', inboundTo);
          return;
        }
        if (trimmedBody === 'LISTO') {
          await updateWorker(from, record.status, body, 'Entendido. Estarás listo para recibir trabajos en tu área pronto.', {});
          await sendSMS(from, 'Entendido. Estarás listo para recibir trabajos en tu área pronto.', inboundTo);
          return;
        }
      }

      // pending_trades: contractor is confirming trade selection after Stripe onboarding
      if (record.status === 'pending_trades') {
        if (trimmedBody === 'YES') {
          const pendingTrades = (record.data && record.data.pending_trades_selection) || [];
          if (pendingTrades.length === 0) {
            await sendSMS(from, 'Reply with the types of work you do (e.g., plumbing, electrical, hvac). You can list multiple.', inboundTo);
            return;
          }
          await supabase
            .from('workers')
            .update({
              status: 'active',
              data: { ...record.data, trades: pendingTrades, pending_trades_selection: null },
            })
            .eq('phone', from);
          await sendSMS(from, "You're live. We'll text you when a job matches your skills.", inboundTo);

          // Check for stale dispatched jobs linked to this contractor (relocated from stripeConnect.js)
          try {
            const { data: staleJobs } = await supabase
              .from('customers')
              .select('*')
              .eq('status', 'dispatched')
              .filter('data->schedule->>worker_id', 'eq', record.id);

            if (staleJobs && staleJobs.length > 0) {
              const staleMarket = record.market_id ? await getMarketById(record.market_id) : null;
              const staleMarketNumber = (staleMarket && staleMarket.twilio_number) || undefined;
              for (const job of staleJobs) {
                const jobId = job.short_id || '????';
                await sendSMS(
                  record.phone,
                  `You have a pending job ready to go. Job #${jobId} - reply CLAIM ${jobId} to accept it or ignore to pass.`,
                  staleMarketNumber
                );
              }
            }
          } catch (err) {
            console.error('[pending_trades] Failed to check stale dispatched jobs:', err.message);
          }

          // Notify contractor of open unclaimed dispatched jobs matching their trade (relocated from stripeConnect.js)
          try {
            const { data: allDispatched } = await supabase
              .from('customers')
              .select('*')
              .eq('status', 'dispatched');

            const workerTrades = (Array.isArray(pendingTrades) && pendingTrades.length > 0)
              ? pendingTrades
              : (record.data && record.data.trade ? [record.data.trade] : []);

            const openMatchingJobs = (allDispatched || []).filter(job => {
              const alreadyClaimed = job.data && job.data.schedule && job.data.schedule.worker_id;
              if (alreadyClaimed) return false;
              const jobTrade = job.data && job.data.job && job.data.job.category;
              return jobTrade && workerTrades.some(t => t.toLowerCase() === jobTrade.toLowerCase());
            });

            if (openMatchingJobs.length > 0) {
              const openMarket = record.market_id ? await getMarketById(record.market_id) : null;
              const openMarketNumber = (openMarket && openMarket.twilio_number) || undefined;
              for (const job of openMatchingJobs) {
                await sendJobCardToWorker(record, job, openMarketNumber);
              }
            }
          } catch (err) {
            console.error('[pending_trades] Failed to check open dispatched jobs:', err.message);
          }

          return;
        }

        // Any other text — parse as trade selection
        const rawTokens = body.toLowerCase().replace(/[,;]+/g, ' ').split(/\s+/).filter(Boolean);
        const resolvedTrades = [];

        for (const token of rawTokens) {
          if (TRADES.includes(token)) {
            if (!resolvedTrades.includes(token)) resolvedTrades.push(token);
          } else if (TRADE_ALIASES[token]) {
            const canonical = TRADE_ALIASES[token];
            if (!resolvedTrades.includes(canonical)) resolvedTrades.push(canonical);
          }
        }

        if (resolvedTrades.length === 0) {
          await sendSMS(from, `We didn't recognize any trades in that. Try: ${TRADES.slice(0, 5).join(', ')}, etc.`, inboundTo);
          return;
        }

        await supabase
          .from('workers')
          .update({ data: { ...record.data, pending_trades_selection: resolvedTrades } })
          .eq('phone', from);

        const tradeList = resolvedTrades.map(t => TRADE_LABELS[t] || t).join(', ');
        await sendSMS(from, `Got it — you do: ${tradeList}. Reply YES to confirm or send a corrected list.`, inboundTo);
        return;
      }

      // BUSY/AVAILABLE toggle
      if (trimmedBody === 'BUSY') {
        await updateWorker(from, 'busy', body, "Got it, you won't receive job cards until you text AVAILABLE.", {});
        await sendSMS(from, "Got it, you won't receive job cards until you text AVAILABLE.", inboundTo);
        return;
      }
      if (trimmedBody === 'AVAILABLE') {
        await updateWorker(from, 'active', body, "You're back on. Job cards will resume immediately.", {});
        await sendSMS(from, "You're back on. Job cards will resume immediately.", inboundTo);
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
          await sendSMS(from, `We can't find job #${commandJobId}. Double-check the number and try again.`, inboundTo);
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
          await sendSMS(from, `You have multiple active jobs (${jobList}) - please include the job number, e.g. ${commandKeyword} ${myJobs[0].short_id || '0000'}.`, inboundTo);
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

      const result = await runContractorAgent(record, customerRecord, body, inboundTo);

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
        await sendSMS(from, `Job #${shortId} has been cancelled. Text us anytime you need help with something around the house.`, inboundTo);
        await sendSMS(process.env.MY_CELL_NUMBER, `WAITLIST CANCEL - Job #${shortId} - ${from} cancelled while waitlisted.`);
        console.log(`Waitlisted job #${shortId} cancelled by customer ${from}`);
        try {
          await notifyJerry('JOB_CANCELLED', record, record.market_id || 'unknown');
        } catch (err) {
          console.error('Jerry notification failed:', err.message);
        }
        return;
      }
      // Any other text — holding message
      await sendSMS(from, "We're still working on finding a pro for your job. We'll text you as soon as someone's available. Reply CANCEL if you'd like to cancel.", inboundTo);
      await updateCustomer(from, 'waitlisted', body, "We're still working on finding a pro for your job. We'll text you as soon as someone's available. Reply CANCEL if you'd like to cancel.", {});
      return;
    }

    // Opt-out: homeowner replied NO to a stall reminder
    const STALLED_STATUSES = ['new', 'scoping', 'quoting', 'scheduling'];
    if (STALLED_STATUSES.includes(record.status) && (record.data.reminders_sent || 0) > 0 && trimmedBody === 'NO') {
      const optOutMsg = "Got it — we won't follow up on this one. Text us anytime you need help down the road.";
      await updateCustomer(from, 'closed', 'NO', optOutMsg, { opted_out: true });
      await sendSMS(from, optOutMsg, inboundTo);
      return;
    }

    console.log('[yes-debug] status=' + record.status + ' body=' + trimmedBody);
    // YES/NO handling when customer status is complete or price_locked
    if ((record.status === 'complete' || record.status === 'price_locked') && trimmedBody === 'YES') {
      await handleYes(record, from, inboundTo);
      return;
    }
    if ((record.status === 'complete' || record.status === 'price_locked') && trimmedBody === 'NO') {
      await handleNo(record, from, inboundTo);
      return;
    }

    // Intent detection for in-progress jobs
    if (['dispatched', 'active', 'price_locked'].includes(record.status)) {
      const isAck = /^\s*(yes|ok|okay|great|thanks|thank you|wonderful|got it|sounds good|perfect|awesome|k|👍)\s*[!.]*\s*$/i.test(body);
      const needsHelp = /cancel|reschedule|change|problem|issue|wrong|help|\?|running late|can't make it|cannot make|delay|different day|different time/i.test(body);

      if (isAck || !needsHelp) {
        const holdingMsg = "You're all set - we'll be in touch!";
        await sendSMS(from, holdingMsg, inboundTo);
        await updateCustomer(from, record.status, body, holdingMsg, {});
        return;
      }
      // Falls through to runCustomerAgent with the record's current status for context
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
      await sendSMS(process.env.MY_CELL_NUMBER, `FLAG - ${from}: ${body}`);
      const humanMsg = "You've been connected with our team. Someone will text you shortly.";
      await sendSMS(from, isFirstMessage ? humanMsg + tosNotice : humanMsg, inboundTo);
    } else {
      await sendSMS(from, isFirstMessage ? reply + tosNotice : reply, inboundTo);
    }

    // Deterministic scheduling prompt — sent directly, never through the AI pipeline
    if (record.status === 'quoting' && newStatus === 'scheduling') {
      await sendSMS(from, MSG_SCHEDULE_PROMPT, inboundTo);
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

    // Extract price range from reply on any status — agent sometimes skips quoting status
    const priceMatch = reply && reply.match(/\$(\d+)(?:[^$\d]*|-)\$?(\d+)/);
    if (priceMatch) {
      if (!additionalData.job) additionalData.job = {};
      additionalData.job.quoted_price_low = parseInt(priceMatch[1], 10);
      additionalData.job.quoted_price_high = parseInt(priceMatch[2], 10);
    }
    console.log(`[price-debug] status=${newStatus} matched=${!!priceMatch} low=${priceMatch ? priceMatch[1] : 'null'} high=${priceMatch ? priceMatch[2] : 'null'} reply=${JSON.stringify(reply)}`);

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

async function handleYes(customerRecord, from, marketNumber) {
  try {
    const invoice = (customerRecord.data && customerRecord.data.invoice) || {};
    const paymentIntentId = invoice.stripe_payment_intent_id;

    if (!paymentIntentId) {
      await sendSMS(from, "We're having trouble finding your payment info. Text us at " + process.env.MY_CELL_NUMBER + " for help.", marketNumber);
      return;
    }

    const confirmedPrice = invoice.confirmed_price || 0;
    const payoutAmount = invoice.payout_amount || calculateFee(confirmedPrice).contractorPayout;

    // Capture the payment
    const stripe = getStripe();
    try {
      const { platformFee } = calculateFee(confirmedPrice);
      console.log('[handleYes] starting capture for PI:', paymentIntentId, 'price:', confirmedPrice);
      console.log('[handleYes] platformFee:', platformFee, 'application_fee_amount:', Math.round(platformFee * 100));
      const captureResult = await stripe.paymentIntents.capture(paymentIntentId, {
        application_fee_amount: Math.round(platformFee * 100),
      });
      console.log('[handleYes] capture result:', captureResult.status);
    } catch (err) {
      console.log('[handleYes] capture ERROR:', err.message);
      console.error('Stripe capture failed:', err.message);
      await sendSMS(from, "There was an issue processing your payment. We're looking into it - text " + process.env.MY_CELL_NUMBER + " if you need help.", marketNumber);
      await sendSMS(process.env.MY_CELL_NUMBER, `CAPTURE FAILED - ${from} - PI: ${paymentIntentId} - ${err.message}`);
      try {
        await notifyJerry('PAYMENT_FAILURE', customerRecord, customerRecord.market_id || 'unknown');
      } catch (notifyErr) {
        console.error('Jerry notification failed:', notifyErr.message);
      }
      return;
    }

    const now = new Date().toISOString();

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
      await sendSMS(from, `Payment of $${confirmedPrice} confirmed for Job #${jobId}. Thanks for using GotaGuy - we hope to be your go-to for anything around the house.`, marketNumber);
    } catch (err) {
      console.error('Failed to send receipt SMS:', err.message);
    }

    // Send Google review request to customer — deterministic, fires on every confirmed payment
    try {
      await sendSMS(from, MSG_REVIEW_REQUEST(GOOGLE_REVIEW_URL_MCKINNEY), marketNumber);
    } catch (err) {
      console.error('Failed to send Google review SMS:', err.message);
    }

    // Send payout confirmation to contractor
    if (worker) {
      try {
        const payoutMsg = await translateForWorker(`Job #${jobId} closed. $${payoutAmount} is on its way to your debit card. Nice work.`, worker);
        await sendSMS(worker.phone, payoutMsg, marketNumber);
      } catch (err) {
        console.error('Failed to send payout SMS:', err.message);
      }
    }

    console.log(`Payment captured for ${from}: Job #${jobId} $${confirmedPrice}, payout: $${payoutAmount}`);
  } catch (err) {
    console.error('handleYes error:', err.message);
  }
}

async function handleNo(customerRecord, from, marketNumber) {
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

    await sendSMS(from, "No problem - what's the concern? We want to make sure you're satisfied before releasing payment.", marketNumber);

    const jobId = customerRecord.short_id || '????';
    await sendSMS(process.env.MY_CELL_NUMBER, `DISPUTE - ${from} - Job #${jobId} - ${jobCategory} - $${confirmedPrice} - ${contractorName}`);

    // Cancel the Stripe PaymentIntent to release the card hold
    const paymentIntentId = invoice.stripe_payment_intent_id;
    if (paymentIntentId) {
      try {
        const stripe = getStripe();
        await stripe.paymentIntents.cancel(paymentIntentId);
        console.log(`[handleNo] PaymentIntent ${paymentIntentId} cancelled for dispute on job #${jobId}`);
      } catch (err) {
        console.error(`[handleNo] Failed to cancel PaymentIntent ${paymentIntentId}:`, err.message);
        await sendSMS(process.env.MY_CELL_NUMBER, `DISPUTE PI CANCEL FAILED - Job #${jobId} - PI: ${paymentIntentId} - ${err.message}`);
      }
    }

    // Notify contractor that payment is on hold
    if (workerId) {
      try {
        const worker = await getWorkerById(workerId);
        if (worker) {
          const workerMsg = await translateForWorker(`The customer has raised a concern about Job #${jobId}. Payment is on hold while we look into it. We'll be in touch shortly.`, worker);
          await sendSMS(worker.phone, workerMsg, marketNumber);
        }
      } catch (err) {
        console.error('[handleNo] Failed to notify contractor of dispute:', err.message);
      }
    }

    await updateCustomer(from, 'complete', 'NO', "No problem - what's the concern? We want to make sure you're satisfied before releasing payment.", {});

    console.log(`Dispute flagged for ${from}: $${confirmedPrice}`);
  } catch (err) {
    console.error('handleNo error:', err.message);
  }
}

async function handleRecruit(adminPhone, rawBody, inboundTo) {
  // Syntax: RECRUIT <phone> <trade> [name...] [market]
  const RECRUIT_MARKETS = ['mckinney', 'aurora'];

  const parts = rawBody.trim().split(/\s+/);
  if (parts.length < 3) {
    await sendSMS(adminPhone, 'Usage: RECRUIT <phone> <trade> [name] [market]', inboundTo);
    return;
  }

  const rawPhone = parts[1].replace(/\D/g, '');
  if (rawPhone.length !== 10) {
    await sendSMS(adminPhone, `Invalid phone: "${parts[1]}". Must be 10 digits.`, inboundTo);
    return;
  }
  const e164Phone = '+1' + rawPhone;

  const rawTrade = parts[2].toLowerCase();
  const resolvedTrade = TRADES.includes(rawTrade) ? rawTrade : (TRADE_ALIASES[rawTrade] || null);
  if (!resolvedTrade) {
    await sendSMS(adminPhone, `Unknown trade: "${parts[2]}". Valid: ${TRADES.join(', ')}`, inboundTo);
    return;
  }

  const nameAndMarket = parts.slice(3);
  const lastWord = (nameAndMarket[nameAndMarket.length - 1] || '').toLowerCase();

  let marketSlug = 'mckinney';
  let nameParts = nameAndMarket;
  if (RECRUIT_MARKETS.includes(lastWord)) {
    marketSlug = lastWord;
    nameParts = nameAndMarket.slice(0, -1);
  }

  const name = nameParts.join(' ') || 'Unknown';

  const marketName = marketSlug.charAt(0).toUpperCase() + marketSlug.slice(1);
  const { data: market } = await supabase
    .from('markets')
    .select('id, name, twilio_number')
    .ilike('name', marketName)
    .maybeSingle();

  if (!market) {
    await sendSMS(adminPhone, `Unknown market: "${marketSlug}". Valid: mckinney, aurora`, inboundTo);
    return;
  }

  const resolvedMarketId = market.id;

  const { data: existing } = await supabase.from('workers').select('id').eq('phone', e164Phone).maybeSingle();
  if (existing) {
    await sendSMS(adminPhone, `Worker ${e164Phone} already exists.`, inboundTo);
    return;
  }

  const { data: newWorker, error: insertErr } = await supabase
    .from('workers')
    .insert({
      phone: e164Phone,
      status: 'pending_tos',
      market_id: resolvedMarketId,
      data: { name, trades: [resolvedTrade], source: 'recruit' },
    })
    .select()
    .single();

  if (insertErr) {
    console.error('RECRUIT insert failed:', insertErr.message);
    await sendSMS(adminPhone, `Failed to add ${e164Phone}: ${insertErr.message}`, inboundTo);
    return;
  }

  try {
    await welcomeContractor(newWorker);
  } catch (err) {
    console.error('welcomeContractor error in RECRUIT:', err.message);
  }

  await sendSMS(adminPhone, `Recruited ${name} (${resolvedTrade}, ${marketSlug}) — TOS sent to ${e164Phone}`, inboundTo);
  console.log(`Admin recruited worker: ${name} (${resolvedTrade}, ${marketSlug}) ${e164Phone}`);
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
