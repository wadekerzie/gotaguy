const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/client');
const { updateCustomer, updateWorker } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { createPaymentLink } = require('../services/stripe');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function runContractorAgent(workerRecord, customerRecord, inboundText) {
  try {
    const command = (inboundText || '').trim().toUpperCase();

    if (command === 'CLAIM') {
      return await handleClaim(workerRecord, customerRecord);
    }
    if (command === 'ARRIVED') {
      return await handleArrived(workerRecord, customerRecord);
    }
    if (command === 'DONE') {
      return await handleDone(workerRecord, customerRecord);
    }

    // Anything else — pass to Claude
    return await handleFreeText(workerRecord, customerRecord, inboundText);
  } catch (err) {
    console.error('contractorAgent error:', err.message);
    await sendSMS(workerRecord.phone, "Something went wrong on our end. Try again or text " + process.env.MY_CELL_NUMBER + " for help.").catch(() => {});
    return { reply: null, action: 'error' };
  }
}

async function handleClaim(workerRecord, customerRecord) {
  if (!customerRecord) {
    await sendSMS(workerRecord.phone, "We don't see an open job to claim right now. Text us if you need help.");
    return { reply: null, action: 'no_job' };
  }

  // Check if already claimed
  if (customerRecord.data && customerRecord.data.schedule && customerRecord.data.schedule.worker_id) {
    await sendSMS(workerRecord.phone, "Sorry - that job was just claimed by someone else.");
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
    await sendSMS(workerRecord.phone, "Sorry - that job was just claimed by someone else.");
    return { reply: null, action: 'race_lost' };
  }

  const customerName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'The customer';
  const firstName = customerName.split(' ')[0];
  const window = (customerRecord.data.availability && (customerRecord.data.availability.window || customerRecord.data.availability.raw)) || 'soon';
  const address = (customerRecord.data.contact && customerRecord.data.contact.address) || 'Address not provided';

  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];

  // Send to worker
  await sendSMS(workerRecord.phone, `Job is yours. ${firstName} is expecting you ${window}. Address: ${address}. Text ARRIVED when you get there.`);

  // Send to customer (non-blocking — don't fail the claim if customer SMS fails)
  try {
    await sendSMS(customerRecord.phone, `Good news - ${workerFirstName} will be there ${window}. Text us if you have any questions.`);
  } catch (err) {
    console.error('Failed to notify customer of claim:', err.message);
  }

  // Update worker history
  await updateWorker(workerRecord.phone, workerRecord.status, null, null, {});

  return { reply: null, action: 'claimed' };
}

async function handleArrived(workerRecord, customerRecord) {
  if (!customerRecord || customerRecord.status !== 'active') {
    await sendSMS(workerRecord.phone, `Hmm, something looks off - text us at ${process.env.MY_CELL_NUMBER} for help.`);
    return { reply: null, action: 'invalid_state' };
  }

  const customerName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'Hi';
  const firstName = customerName.split(' ')[0];
  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];

  // Generate Stripe payment link
  let paymentUrl;
  try {
    paymentUrl = await createPaymentLink(customerRecord);
  } catch (err) {
    console.error('Failed to create payment link:', err.message);
    await sendSMS(workerRecord.phone, "We hit a snag creating the payment link. Give us a sec - texting the team now.");
    await sendSMS(process.env.MY_CELL_NUMBER, `Payment link failed for job ${customerRecord.id}: ${err.message}`);
    return { reply: null, action: 'payment_link_error' };
  }

  // Send to customer with payment link
  try {
    await sendSMS(customerRecord.phone, `Hi ${firstName} - ${workerFirstName} is at your door. Agree on a final price with them, then enter it and your card here to get started. Your card will not be charged until you confirm the work is complete: ${paymentUrl}`);
  } catch (err) {
    console.error('Failed to send payment link to customer:', err.message);
  }

  // Update customer status to price_locked
  await updateCustomer(customerRecord.phone, 'price_locked', null, null, {});

  return { reply: null, action: 'arrived' };
}

async function handleDone(workerRecord, customerRecord) {
  if (!customerRecord || (customerRecord.status !== 'price_locked' && customerRecord.status !== 'active')) {
    await sendSMS(workerRecord.phone, `Hmm, something looks off - text us at ${process.env.MY_CELL_NUMBER} for help.`);
    return { reply: null, action: 'invalid_state' };
  }

  const invoice = (customerRecord.data && customerRecord.data.invoice) || {};
  if (!invoice.confirmed_price) {
    await sendSMS(workerRecord.phone, "Heads up - the customer hasn't locked in a price yet. Give them a moment or have them check their texts.");
    return { reply: null, action: 'price_not_locked' };
  }

  const workerName = (workerRecord.data && workerRecord.data.name) || 'Your contractor';
  const workerFirstName = workerName.split(' ')[0];
  const confirmedPrice = invoice.confirmed_price;

  // Update customer status to complete
  await updateCustomer(customerRecord.phone, 'complete', null, null, {});

  // Send to customer
  try {
    await sendSMS(customerRecord.phone, `${workerFirstName} says the job is done. Happy with the work? Reply YES to release your $${confirmedPrice} payment, or NO if you have a concern.`);
  } catch (err) {
    console.error('Failed to send completion notice to customer:', err.message);
  }

  return { reply: null, action: 'done' };
}

async function handleFreeText(workerRecord, customerRecord, inboundText) {
  const workerName = (workerRecord.data && workerRecord.data.name) || 'Contractor';
  const workerFirstName = workerName.split(' ')[0];

  const systemPrompt = `You are the support agent for GotaGuy, texting with a licensed contractor named ${workerFirstName}.
Keep responses brief and practical - this is SMS.
The contractor may have questions about a job, their payout, or how the platform works.
Current worker record: ${JSON.stringify(workerRecord)}
Current job they are on (if any): ${JSON.stringify(customerRecord || null)}
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
    await sendSMS(workerRecord.phone, "Got it - let me check on that. Text " + process.env.MY_CELL_NUMBER + " if you need immediate help.");
    return { reply: null, action: 'parse_error' };
  }

  const parsed = JSON.parse(jsonMatch[0]);

  if (parsed.flag === 'human') {
    await sendSMS(process.env.MY_CELL_NUMBER, `CONTRACTOR EXCEPTION - ${workerRecord.phone}: ${inboundText}`);
    await sendSMS(workerRecord.phone, parsed.reply);
  } else {
    await sendSMS(workerRecord.phone, parsed.reply);
  }

  return { reply: parsed.reply, action: 'ai_response', flag: parsed.flag };
}

module.exports = { runContractorAgent };
