const { getActiveWorkersByTradeAndZip, updateCustomer } = require('../db/client');
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

    const city = ZIP_TO_CITY[zip] || zip;

    const shortId = customerRecord.short_id || '????';
    const photos = data.photos || [];
    const latestPhoto = photos.length > 0 ? photos[photos.length - 1].url : null;

    for (const worker of workers) {
      const jobCard = `Job #${shortId} - ${trade} - ${city}\n${description}\nAvailability: ${window}\nQuoted: $${priceLow}-$${priceHigh}${latestPhoto ? '\nPhoto: ' + latestPhoto : ''}\nReply CLAIM ${shortId} to take it`;

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
    const city = ZIP_TO_CITY[zip] || zip;
    const shortId = customerRecord.short_id || '????';
    const retryPhotos = data.photos || [];
    const retryLatestPhoto = retryPhotos.length > 0 ? retryPhotos[retryPhotos.length - 1].url : null;

    for (const worker of workers) {
      const jobCard = `Job #${shortId} - ${trade} - ${city}\n${description}\nAvailability: ${window}\nQuoted: $${priceLow}-$${priceHigh}${retryLatestPhoto ? '\nPhoto: ' + retryLatestPhoto : ''}\nReply CLAIM ${shortId} to take it`;

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
