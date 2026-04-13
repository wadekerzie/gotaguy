const { getActiveWorkersByTradeAndZip, updateCustomer } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { translateForWorker } = require('../services/translate');

async function dispatchJob(customerRecord) {
  try {
    const data = customerRecord.data || {};
    const job = data.job || {};
    const contact = data.contact || {};
    const availability = data.availability || {};

    const trade = job.category;
    if (!trade) {
      console.error('dispatchJob: no trade category on customer', customerRecord.id);
      await sendSMS(process.env.MY_CELL_NUMBER, `Dispatch failed - no trade category on job ${customerRecord.id}`);
      return;
    }

    // Parse zip from address
    const address = contact.address || '';
    const zipMatch = address.match(/\b(\d{5})\b/);
    const zip = zipMatch ? zipMatch[1] : null;

    if (!zip) {
      console.error('dispatchJob: zip extraction failed for customer', customerRecord.id);
      await sendSMS(
        customerRecord.phone,
        `One quick thing before we find your pro - what's the ZIP code for the job? Just reply with the 5-digit ZIP.`
      );
      await sendSMS(
        process.env.MY_CELL_NUMBER,
        `ZIP EXTRACTION FAILED - Job ${customerRecord.id} - Address: "${address}" - asked customer to reply with ZIP.`
      );
      // Move to scoping so the next reply routes back through the customer agent
      // which will extract the ZIP from their response and retry dispatch
      await updateCustomer(customerRecord.phone, 'scoping', null, null, {
        job: {
          ...((customerRecord.data && customerRecord.data.job) || {}),
          needs_zip: true,
        },
      });
      return;
    }

    const workers = await getActiveWorkersByTradeAndZip(trade, [zip]);

    if (workers.length === 0) {
      console.log(`No workers available for ${trade} in ${zip} - waitlisting`);
      const now = new Date().toISOString();
      const shortId = customerRecord.short_id || '????';

      await updateCustomer(customerRecord.phone, 'waitlisted', null, null, {
        waitlist: {
          waitlisted_at: now,
          retry_count: 0,
          last_retry_at: null,
          escalated_at: null,
          reason: 'no_match',
        },
      });

      await sendSMS(customerRecord.phone, `We're lining up a ${trade} pro for your job (Job #${shortId}). Hang tight - we'll text you as soon as someone's available.`);
      await sendSMS(process.env.MY_CELL_NUMBER, `WAITLISTED - Job #${shortId} ${trade} in ${zip} - no available contractors. Auto-retry active.`);
      return;
    }

    const description = (job.description || '').substring(0, 80);
    const window = availability.window || availability.raw || 'TBD';
    const priceLow = job.quoted_price_low || 0;
    const priceHigh = job.quoted_price_high || 0;

    // Parse city from address
    const cityMatch = address.match(/([A-Za-z\s]+),?\s*[A-Z]{2}\s*\d{5}/);
    const city = cityMatch ? cityMatch[1].trim() : '';

    const shortId = customerRecord.short_id || '????';

    for (const worker of workers) {
      const jobCard = `Job #${shortId} - ${trade} - ${city} ${zip}\n${description}\nWindow: ${window}\nQuoted: $${priceLow}-$${priceHigh}\nNote: English communication required on site.\nReply CLAIM ${shortId} to take it`;

      try {
        const localizedCard = await translateForWorker(jobCard, worker);
        await sendSMS(worker.phone, localizedCard);
      } catch (err) {
        console.error(`Failed to send job card to worker ${worker.phone}:`, err.message);
      }
    }

    // Update customer status to dispatched
    await updateCustomer(customerRecord.phone, 'dispatched', null, null, {});

    console.log(`Job ${customerRecord.id} dispatched to ${workers.length} workers for ${trade} in ${zip}`);
  } catch (err) {
    console.error('dispatchJob error:', err.message);
    await sendSMS(process.env.MY_CELL_NUMBER, `Dispatch error - job ${customerRecord.id}: ${err.message}`).catch(() => {});
  }
}

async function retryDispatch(customerRecord) {
  try {
    const data = customerRecord.data || {};
    const job = data.job || {};
    const contact = data.contact || {};
    const availability = data.availability || {};
    const waitlist = data.waitlist || {};

    const trade = job.category;
    if (!trade) {
      console.error('retryDispatch: no trade category on customer', customerRecord.id);
      return { dispatched: false, reason: 'no_trade' };
    }

    const address = contact.address || '';
    const zipMatch = address.match(/\b(\d{5})\b/);
    const zip = zipMatch ? zipMatch[1] : null;

    if (!zip) {
      console.error('retryDispatch: zip extraction failed for customer', customerRecord.id);
      return { dispatched: false, reason: 'no_zip' };
      // Note: customer was already asked for ZIP by dispatchJob.
      // retryDispatch will not reach this point on a healthy job.
    }

    const workers = await getActiveWorkersByTradeAndZip(trade, [zip]);

    if (workers.length === 0) {
      // Still no match — increment retry count
      const now = new Date().toISOString();
      const retryCount = (waitlist.retry_count || 0) + 1;

      await updateCustomer(customerRecord.phone, 'waitlisted', null, null, {
        waitlist: {
          ...waitlist,
          retry_count: retryCount,
          last_retry_at: now,
        },
      });

      console.log(`retryDispatch: still no match for Job #${customerRecord.short_id || '????'} (attempt ${retryCount})`);
      return { dispatched: false, reason: 'no_match', retryCount };
    }

    // Workers found — dispatch normally
    const description = (job.description || '').substring(0, 80);
    const window = availability.window || availability.raw || 'TBD';
    const priceLow = job.quoted_price_low || 0;
    const priceHigh = job.quoted_price_high || 0;
    const cityMatch = address.match(/([A-Za-z\s]+),?\s*[A-Z]{2}\s*\d{5}/);
    const city = cityMatch ? cityMatch[1].trim() : '';
    const shortId = customerRecord.short_id || '????';

    for (const worker of workers) {
      const jobCard = `Job #${shortId} - ${trade} - ${city} ${zip}\n${description}\nWindow: ${window}\nQuoted: $${priceLow}-$${priceHigh}\nNote: English communication required on site.\nReply CLAIM ${shortId} to take it`;

      try {
        const localizedCard = await translateForWorker(jobCard, worker);
        await sendSMS(worker.phone, localizedCard);
      } catch (err) {
        console.error(`Failed to send job card to worker ${worker.phone}:`, err.message);
      }
    }

    await updateCustomer(customerRecord.phone, 'dispatched', null, null, {});
    await sendSMS(customerRecord.phone, `Great news - we found a pro for your job (Job #${shortId}). You'll hear from them soon.`);

    console.log(`retryDispatch: Job #${shortId} dispatched to ${workers.length} workers`);
    return { dispatched: true, workersNotified: workers.length };
  } catch (err) {
    console.error('retryDispatch error:', err.message);
    return { dispatched: false, reason: 'error', error: err.message };
  }
}

module.exports = { dispatchJob, retryDispatch };
