const Anthropic = require('@anthropic-ai/sdk');
const { loadSystemPrompt } = require('../utils/loadSystemPrompt');
const { STATUS_PENDING_DAY_CONFIRMATION } = require('../utils/constants');
const { notifyJerry } = require('../utils/jerryNotify');
const supabase = require('../db/client');
const { updateCustomer, updateWorker } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { createPaymentLink } = require('../services/stripe');
const { translateForWorker } = require('../services/translate');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function hasMultipleOptions(window) {
  if (!window) return false;
  return /\bor\b/i.test(window) || /,/.test(window);
}

async function runContractorAgent(workerRecord, customerRecord, inboundText, marketNumber) {
  try {
    const commandWord = (inboundText || '').trim().toUpperCase().split(/\s+/)[0];

    // Reliably detect pending day confirmation — query DB directly so we don't
    // depend on whatever customerRecord sms.js happened to pass
    if (commandWord !== 'CLAIM' && commandWord !== 'ARRIVED' && commandWord !== 'DONE') {
      const { data: pendingJobs } = await supabase
        .from('customers')
        .select('*')
        .eq('status', STATUS_PENDING_DAY_CONFIRMATION)
        .filter('data->schedule->>worker_id', 'eq', workerRecord.id)
        .filter('data->schedule->>pending_day_confirmation', 'eq', 'true')
        .limit(1);

      if (pendingJobs && pendingJobs.length > 0) {
        return await handleDayConfirmation(workerRecord, pendingJobs[0], inboundText, marketNumber);
      }
    }

    if (commandWord === 'CLAIM') {
      return await handleClaim(workerRecord, customerRecord, marketNumber);
    }
    if (commandWord === 'ARRIVED') {
      return await handleArrived(workerRecord, customerRecord, marketNumber);
    }
    if (commandWord === 'DONE') {
      return await handleDone(workerRecord, customerRecord, marketNumber);
    }

    // Intent detection for in-progress jobs
    if (customerRecord && ['active', 'price_locked', 'complete'].includes(customerRecord.status)) {
      const isAck = /^\s*(yes|ok|okay|great|thanks|thank you|got it|sounds good|perfect|awesome|on my way|omw|k|👍)\s*[!.]*\s*$/i.test(inboundText);
      const needsHelp = /late|reschedule|cancel|change|problem|issue|wrong|help|\?|can't make it|cannot make|delay|different day|different time/i.test(inboundText);

      if (isAck || !needsHelp) {
        const jobId = customerRecord.short_id || '????';
        const holdingText = customerRecord.status === 'price_locked'
          ? `Got it. Text DONE ${jobId} when the work is complete.`
          : `Got it - we'll pass that along. Text DONE ${jobId} when the work is complete.`;
        const msg = await translateForWorker(holdingText, workerRecord);
        await sendSMS(workerRecord.phone, msg, marketNumber);
        await updateWorker(workerRecord.phone, workerRecord.status, inboundText, holdingText, {});
        return { reply: null, action: 'held' };
      }
      // Falls through to handleFreeText for substantive messages
    }

    // Anything else — pass to Claude
    return await handleFreeText(workerRecord, customerRecord, inboundText, marketNumber);
  } catch (err) {
    console.error('contractorAgent error:', err.message);
    const errMsg = await translateForWorker("Something went wrong on our end. Try again or text " + process.env.MY_CELL_NUMBER + " for help.", workerRecord);
    await sendSMS(workerRecord.phone, errMsg, marketNumber).catch(() => {});
    return { reply: null, action: 'error' };
  }
}

async function handleClaim(workerRecord, customerRecord, marketNumber) {
  if (!customerRecord) {
    const msg = await translateForWorker("We don't see an open job to claim right now. Text us if you need help.", workerRecord);
    await sendSMS(workerRecord.phone, msg, marketNumber);
    return { reply: null, action: 'no_job' };
  }

  // Check if already claimed
  if (customerRecord.data && customerRecord.data.schedule && customerRecord.data.schedule.worker_id) {
    const msg = await translateForWorker("Sorry - that job was just claimed by someone else.", workerRecord);
    await sendSMS(workerRecord.phone, msg, marketNumber);
    return { reply: null, action: 'already_claimed' };
  }

  // Use Postgres SELECT FOR UPDATE via RPC to atomically lock the row
  // Since Supabase JS doesn't support SELECT FOR UPDATE, we use a transaction-like approach:
  // Re-fetch with a conditional update (optimistic lock)
  const { data: locked, error: lockErr } = await supabase
    .from('customers')
    .update({
      status: 'active',
      data: {
        ...customerRecord.data,
        schedule: {
          ...(customerRecord.data.schedule || {}),
          worker_id: workerRecord.id
        },
        history: [
          ...((customerRecord.data && customerRecord.data.history) || []),
          { ts: new Date().toISOString(), agent: 'contractorAgent', action: `claimed by worker ${workerRecord.id}` }
        ]
      }
    })
    .eq('id', customerRecord.id)
    .is('data->schedule->worker_id', null) // Only update if no worker claimed yet
    .select()
    .single();

  if (lockErr || !locked) {
    const msg = await translateForWorker("Sorry - that job was just claimed by someone else.", workerRecord);
    await sendSMS(workerRecord.phone, msg, marketNumber);
    return { reply: null, action: 'race_lost' };
  }

  try {
    await notifyJerry('JOB_ACTIVE_STARTED', locked, locked.market_id || 'unknown');
  } catch (err) {
    console.error('Jerry notification failed:', err.message);
  }

  const customerName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'The customer';
  const firstName = customerName.split(' ')[0];
  const window = (customerRecord.data.availability && (customerRecord.data.availability.window || customerRecord.data.availability.raw)) || 'soon';
  const address = (customerRecord.data.contact && customerRecord.data.contact.address) || 'Address not provided';

  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];
  const jobId = customerRecord.short_id || '????';

  if (hasMultipleOptions(window)) {
    // Ask contractor to pick a specific day — don't confirm job until they respond
    const askMsg = await translateForWorker(`Job #${jobId} - which day works for you: ${window}? Reply with your day to confirm. Address: ${address}.`, workerRecord);
    await sendSMS(workerRecord.phone, askMsg, marketNumber);

    // Mark pending day confirmation on the customer record
    await supabase
      .from('customers')
      .update({
        data: {
          ...locked.data,
          schedule: {
            ...locked.data.schedule,
            pending_day_confirmation: true,
          },
        },
      })
      .eq('id', locked.id);

    await updateWorker(workerRecord.phone, workerRecord.status, null, null, {});
    return { reply: null, action: 'awaiting_day' };
  }

  // Single availability window — confirm immediately
  const claimMsg = await translateForWorker(`Job #${jobId} is yours. ${firstName} is expecting you ${window}. Address: ${address}. Text ARRIVED ${jobId} when you get there.`, workerRecord);
  await sendSMS(workerRecord.phone, claimMsg, marketNumber);

  // Send to customer (non-blocking — don't fail the claim if customer SMS fails)
  try {
    await sendSMS(customerRecord.phone, `Confirmed! ${workerFirstName} is booked for ${window}. We'll text you when they're on the way with a secure payment link. Questions? Just reply. (Job #${jobId})`, marketNumber);
  } catch (err) {
    console.error('Failed to notify customer of claim:', err.message);
  }

  // Update worker history
  await updateWorker(workerRecord.phone, workerRecord.status, null, null, {});

  return { reply: null, action: 'claimed' };
}

async function handleDayConfirmation(workerRecord, customerRecord, inboundText, marketNumber) {
  const confirmedDay = (inboundText || '').trim();
  const jobId = customerRecord.short_id || '????';
  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];
  const address = (customerRecord.data.contact && customerRecord.data.contact.address) || 'Address not provided';

  // Clear pending flag and store confirmed day
  await supabase
    .from('customers')
    .update({
      data: {
        ...customerRecord.data,
        schedule: {
          ...customerRecord.data.schedule,
          pending_day_confirmation: false,
          confirmed_day: confirmedDay,
        },
        availability: {
          ...((customerRecord.data && customerRecord.data.availability) || {}),
          window: confirmedDay,
        },
      },
    })
    .eq('id', customerRecord.id);

  // Confirm to contractor with homeowner contact and ARRIVED reminder
  const customerName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'Customer';
  const customerPhone = customerRecord.phone;
  const confirmMsg = await translateForWorker(
    `Got it - Job #${jobId} is yours. ${confirmedDay} at ${address}.\n\nCustomer: ${customerName} ${customerPhone} - reach out directly if you need to adjust timing.\n\nImportant: text ARRIVED ${jobId} when you're on site - that's what triggers payment and gets you paid.`,
    workerRecord
  );
  await sendSMS(workerRecord.phone, confirmMsg, marketNumber);

  // Notify homeowner of specific day with contractor contact
  const workerPhone = workerRecord.phone;
  try {
    await sendSMS(
      customerRecord.phone,
      `Confirmed - your pro will be there ${confirmedDay} at ${address}.\n\nContractor: ${workerFirstName} ${workerPhone} - reach out directly if you need to adjust timing.\n\nYou'll receive a text with a secure payment link when they arrive. (Job #${jobId})`,
      marketNumber
    );
  } catch (err) {
    console.error('Failed to notify customer of confirmed day:', err.message);
  }

  await updateWorker(workerRecord.phone, workerRecord.status, inboundText, null, {});
  return { reply: null, action: 'day_confirmed' };
}

async function handleArrived(workerRecord, customerRecord, marketNumber) {
  if (!customerRecord || customerRecord.status !== 'active') {
    const msg = await translateForWorker(`Hmm, something looks off - text us at ${process.env.MY_CELL_NUMBER} for help.`, workerRecord);
    await sendSMS(workerRecord.phone, msg, marketNumber);
    return { reply: null, action: 'invalid_state' };
  }

  const customerName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'Hi';
  const firstName = customerName.split(' ')[0];
  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];

  // Send address confirmation to contractor with homeowner contact and payment context
  const address = (customerRecord.data.contact && customerRecord.data.contact.address) || 'Address not provided';
  const jobId = customerRecord.short_id || '????';
  const customerContactName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'Customer';
  const customerContactPhone = customerRecord.phone;
  const arrivedMsg = await translateForWorker(
    `Job #${jobId} confirmed. Head to ${address}.\n\nCustomer: ${customerContactName} ${customerContactPhone} - reach out directly if you need to adjust timing.\n\nThe customer will receive a payment link to authorize the agreed amount. Text DONE ${jobId} when the work is complete.`,
    workerRecord
  );
  await sendSMS(workerRecord.phone, arrivedMsg, marketNumber);

  // Generate Stripe payment link
  let paymentUrl;
  try {
    const workerStripeAccountId = workerRecord.data && workerRecord.data.stripe_account_id;
    paymentUrl = await createPaymentLink(customerRecord, workerStripeAccountId);
  } catch (err) {
    console.error('Failed to create payment link:', err.message);
    const errMsg = await translateForWorker("We hit a snag creating the payment link. Give us a sec - texting the team now.", workerRecord);
    await sendSMS(workerRecord.phone, errMsg, marketNumber);
    await sendSMS(process.env.MY_CELL_NUMBER, `Payment link failed for job ${customerRecord.id}: ${err.message}`);
    return { reply: null, action: 'payment_link_error' };
  }

  // Send to customer with payment link
  try {
    await sendSMS(customerRecord.phone, `Hi ${firstName} - ${workerFirstName} is at your door. Agree on a final price with them, then enter it and your card here to get started. Your card will not be charged until you confirm the work is complete: ${paymentUrl}`, marketNumber);
  } catch (err) {
    console.error('Failed to send payment link to customer:', err.message);
  }

  // Update customer status to price_locked
  await updateCustomer(customerRecord.phone, 'price_locked', null, null, {});

  return { reply: null, action: 'arrived' };
}

async function handleDone(workerRecord, customerRecord, marketNumber) {
  if (!customerRecord || (customerRecord.status !== 'price_locked' && customerRecord.status !== 'active')) {
    const msg = await translateForWorker(`Hmm, something looks off - text us at ${process.env.MY_CELL_NUMBER} for help.`, workerRecord);
    await sendSMS(workerRecord.phone, msg, marketNumber);
    return { reply: null, action: 'invalid_state' };
  }

  const invoice = (customerRecord.data && customerRecord.data.invoice) || {};
  if (!invoice.confirmed_price) {
    const msg = await translateForWorker("Heads up - the customer hasn't locked in a price yet. Give them a moment or have them check their texts.", workerRecord);
    await sendSMS(workerRecord.phone, msg, marketNumber);
    return { reply: null, action: 'price_not_locked' };
  }

  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];
  const confirmedPrice = invoice.confirmed_price;
  const jobId = customerRecord.short_id || '????';

  // Update customer status to complete
  await updateCustomer(customerRecord.phone, 'complete', null, null, {});

  // Send to contractor
  const doneMsg = await translateForWorker(`Job #${jobId} marked complete. Waiting on customer to confirm.`, workerRecord);
  await sendSMS(workerRecord.phone, doneMsg, marketNumber);

  // Send to customer
  try {
    await sendSMS(customerRecord.phone, `${workerFirstName} says the job is done (Job #${jobId}). Happy with the work? Reply YES to release your $${confirmedPrice} payment, or NO if you have a concern.`, marketNumber);
  } catch (err) {
    console.error('Failed to send completion notice to customer:', err.message);
  }

  return { reply: null, action: 'done' };
}

async function handleFreeText(workerRecord, customerRecord, inboundText, marketNumber) {
  const workerName = (workerRecord.data && workerRecord.data.name) || 'Contractor';
  const workerFirstName = workerName.split(' ')[0];

  const jobContext = customerRecord
    ? `Current job state: ${customerRecord.status}\nJob ID: ${customerRecord.short_id || 'n/a'}\nJob record: ${JSON.stringify(customerRecord)}`
    : 'No active job found for this worker. Handle as a general platform question.';

  const base = loadSystemPrompt();
  const systemPrompt = (base ? base + '\n\n' : '') +
    `You are the support agent for GotaGuy, texting with a licensed contractor named ${workerFirstName}.
Keep responses brief and practical - this is SMS.
The contractor may have questions about a job, their payout, or how the platform works.
Current worker record: ${JSON.stringify(workerRecord)}
${jobContext}
Answer their question directly. If you cannot answer it, tell them to text ${process.env.MY_CELL_NUMBER}.
Output format: {"reply": "...", "flag": null}
Set flag to "human" if you cannot resolve it.`;

  const messages = [];
  const comms = (workerRecord.data && workerRecord.data.comms) || [];
  for (const msg of comms) {
    messages.push({
      role: msg.direction === 'in' ? 'user' : 'assistant',
      content: msg.body,
    });
  }
  messages.push({ role: 'user', content: inboundText });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: systemPrompt,
    messages,
  });

  const responseText = response.content[0].text;
  const jsonMatch = responseText.match(/\{[^{}]*"reply"[^{}]*\}/);

  if (!jsonMatch) {
    const fallbackMsg = await translateForWorker("Got it - let me check on that. Text " + process.env.MY_CELL_NUMBER + " if you need immediate help.", workerRecord);
    await sendSMS(workerRecord.phone, fallbackMsg, marketNumber);
    return { reply: null, action: 'parse_error' };
  }

  const parsed = JSON.parse(jsonMatch[0]);

  if (parsed.flag === 'human') {
    await sendSMS(process.env.MY_CELL_NUMBER, `CONTRACTOR EXCEPTION - ${workerRecord.phone}: ${inboundText}`);
    const localizedReply = await translateForWorker(parsed.reply, workerRecord);
    await sendSMS(workerRecord.phone, localizedReply, marketNumber);
  } else {
    const localizedReply = await translateForWorker(parsed.reply, workerRecord);
    await sendSMS(workerRecord.phone, localizedReply, marketNumber);
  }

  return { reply: parsed.reply, action: 'ai_response', flag: parsed.flag };
}

module.exports = { runContractorAgent };
