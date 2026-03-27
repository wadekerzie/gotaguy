const { getActiveWorkersByTradeAndZip, updateCustomer } = require('../db/client');
const { sendSMS } = require('../services/twilio');

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
      await sendSMS(process.env.MY_CELL_NUMBER, `ZIP EXTRACTION FAILED - Job ${customerRecord.id} - Address: ${address} - cannot dispatch.`);
      return;
    }

    const workers = await getActiveWorkersByTradeAndZip(trade, [zip]);

    if (workers.length === 0) {
      console.log(`No workers available for ${trade} in ${zip}`);
      await sendSMS(process.env.MY_CELL_NUMBER, `No workers available for ${trade} in ${zip} - job ${customerRecord.id}`);
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
      const jobCard = `Job #${shortId} - ${trade} - ${city} ${zip}\n${description}\nWindow: ${window}\nQuoted: $${priceLow}-$${priceHigh}\nReply CLAIM ${shortId} to take it`;

      try {
        await sendSMS(worker.phone, jobCard);
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

module.exports = { dispatchJob };
