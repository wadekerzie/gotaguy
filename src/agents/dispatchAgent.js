const { getActiveWorkersByTradeAndZip, updateCustomer, getMarketByZip } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { translateForWorker } = require('../services/translate');
const { ZIP_TO_CITY } = require('../utils/constants');

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
      console.error('dispatchJob: no ZIP in address for customer', customerRecord.id, '- address:', address);
      await sendSMS(process.env.MY_CELL_NUMBER, `ZIP MISSING - Job ${customerRecord.id} - Address: "${address}" - manual follow-up needed.`);
      return;
    }

    const market = await getMarketByZip(zip);
    if (!market) {
      console.warn(`[dispatchJob] No market found for zip ${zip} — dispatching without market filter`);
    }

    const workers = await getActiveWorkersByTradeAndZip(trade, [zip], market ? market.id : null);

    if (workers.length === 0) {
      console.log(`No workers available for ${trade} in ${zip} (market: ${market ? market.name : 'unknown'}) - waitlisting`);
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

      await sendSMS(customerRecord.phone, `We're lining up a ${trade} pro for your job (Job #${shortId}). Hang tight - we'll text you as soon as someone's available.`, market ? market.twilio_number : undefined);
      await sendSMS(process.env.MY_CELL_NUMBER, `WAITLISTED - Job #${shortId} ${trade} in ${zip} - no available contractors. Auto-retry active.`);
      return;
    }

    const description = (job.description || '').substring(0, 80);
    const window = availability.window || availability.raw || 'TBD';

    let priceLow = job.quoted_price_low || 0;
    let priceHigh = job.quoted_price_high || 0;

    // Fallback: scan comms history for a price range if prices weren't persisted
    if (!priceLow && !priceHigh) {
      const comms = data.comms || [];
      for (const msg of comms) {
        if (msg.direction === 'out') {
          const m = (msg.body || '').match(/\$(\d+)[^$]*\$(\d+)/);
          if (m) {
            priceLow = parseInt(m[1], 10);
            priceHigh = parseInt(m[2], 10);
            break;
          }
        }
      }
    }

    const city = ZIP_TO_CITY[zip] || zip;

    const shortId = customerRecord.short_id || '????';
    const photos = data.photos || [];
    const latestPhoto = photos.length > 0 ? photos[photos.length - 1].url : null;

    for (const worker of workers) {
      const jobCard = `Job #${shortId} - ${trade} - ${city}\n${description}\nAvailability: ${window}\nQuoted: $${priceLow}-$${priceHigh}${latestPhoto ? '\nPhoto: ' + latestPhoto : ''}\nReply CLAIM ${shortId} to take it`;

      try {
        const localizedCard = await translateForWorker(jobCard, worker);
        await sendSMS(worker.phone, localizedCard, market ? market.twilio_number : undefined);
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

    const market = await getMarketByZip(zip);
    const workers = await getActiveWorkersByTradeAndZip(trade, [zip], market ? market.id : null);

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

    let priceLow = job.quoted_price_low || 0;
    let priceHigh = job.quoted_price_high || 0;

    if (!priceLow && !priceHigh) {
      const comms = data.comms || [];
      for (const msg of comms) {
        if (msg.direction === 'out') {
          const m = (msg.body || '').match(/\$(\d+)[^$]*\$(\d+)/);
          if (m) {
            priceLow = parseInt(m[1], 10);
            priceHigh = parseInt(m[2], 10);
            break;
          }
        }
      }
    }

    const city = ZIP_TO_CITY[zip] || zip;
    const shortId = customerRecord.short_id || '????';
    const retryPhotos = data.photos || [];
    const retryLatestPhoto = retryPhotos.length > 0 ? retryPhotos[retryPhotos.length - 1].url : null;

    for (const worker of workers) {
      const jobCard = `Job #${shortId} - ${trade} - ${city}\n${description}\nAvailability: ${window}\nQuoted: $${priceLow}-$${priceHigh}${retryLatestPhoto ? '\nPhoto: ' + retryLatestPhoto : ''}\nReply CLAIM ${shortId} to take it`;

      try {
        const localizedCard = await translateForWorker(jobCard, worker);
        await sendSMS(worker.phone, localizedCard, market ? market.twilio_number : undefined);
      } catch (err) {
        console.error(`Failed to send job card to worker ${worker.phone}:`, err.message);
      }
    }

    await updateCustomer(customerRecord.phone, 'dispatched', null, null, {});
    await sendSMS(customerRecord.phone, `Great news - we found a pro for your job (Job #${shortId}). You'll hear from them soon.`, market ? market.twilio_number : undefined);

    console.log(`retryDispatch: Job #${shortId} dispatched to ${workers.length} workers`);
    return { dispatched: true, workersNotified: workers.length };
  } catch (err) {
    console.error('retryDispatch error:', err.message);
    return { dispatched: false, reason: 'error', error: err.message };
  }
}

// Sends the standard job card SMS to a single worker. Used when a contractor
// activates mid-dispatch and needs to be notified about an open job directly.
async function sendJobCardToWorker(worker, customerRecord, marketTwilioNumber) {
  const data = customerRecord.data || {};
  const job = data.job || {};
  const availability = data.availability || {};
  const contact = data.contact || {};

  const trade = job.category || 'repair';
  const address = contact.address || '';
  const zipMatch = address.match(/\b(\d{5})\b/);
  const zip = zipMatch ? zipMatch[1] : null;
  const city = (zip && ZIP_TO_CITY[zip]) || zip || 'Unknown';
  const description = (job.description || '').substring(0, 80);
  const window = availability.window || availability.raw || 'TBD';
  const shortId = customerRecord.short_id || '????';
  const photos = data.photos || [];
  const latestPhoto = photos.length > 0 ? photos[photos.length - 1].url : null;

  let priceLow = job.quoted_price_low || 0;
  let priceHigh = job.quoted_price_high || 0;

  if (!priceLow && !priceHigh) {
    const comms = data.comms || [];
    for (const msg of comms) {
      if (msg.direction === 'out') {
        const m = (msg.body || '').match(/\$(\d+)[^$]*\$(\d+)/);
        if (m) {
          priceLow = parseInt(m[1], 10);
          priceHigh = parseInt(m[2], 10);
          break;
        }
      }
    }
  }

  const jobCard = `Job #${shortId} - ${trade} - ${city}\n${description}\nAvailability: ${window}\nQuoted: $${priceLow}-$${priceHigh}${latestPhoto ? '\nPhoto: ' + latestPhoto : ''}\nReply CLAIM ${shortId} to take it`;
  const localizedCard = await translateForWorker(jobCard, worker);
  await sendSMS(worker.phone, localizedCard, marketTwilioNumber);
}

module.exports = { dispatchJob, retryDispatch, sendJobCardToWorker };
