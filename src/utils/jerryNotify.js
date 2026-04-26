const { sendSMS } = require('../services/twilio');

const sentNotifications = new Map();

const notifyJerry = async (trigger, jobOrWorker, market) => {
  if (process.env.JERRY_ENABLED !== 'true') {
    console.log('Jerry SMS suppressed - JERRY_ENABLED=false, no action taken');
    return;
  }

  const dedupeKey = `${trigger}-${jobOrWorker.id}`;
  if (sentNotifications.has(dedupeKey)) {
    console.log(`Jerry notification skipped - already sent: ${dedupeKey}`);
    return;
  }
  sentNotifications.set(dedupeKey, new Date().toISOString());

  const fromNumber = process.env.JERRY_TWILIO_NUMBER;
  if (!fromNumber) {
    console.error('JERRY_TWILIO_NUMBER not set - Jerry notification aborted');
    return;
  }

  const toNumber = process.env.JERRY_ADMIN_PHONE || process.env.MY_CELL_NUMBER;
  if (!toNumber) {
    console.error('JERRY_ADMIN_PHONE and MY_CELL_NUMBER both unset - Jerry notification aborted');
    return;
  }

  const message = `GOTAGUY-OPS | ${trigger} | ID: ${jobOrWorker.id} | MARKET: ${market} | STATUS: ${jobOrWorker.status} | TIME: ${new Date().toISOString()}`;
  await sendSMS(toNumber, message, fromNumber);
};

module.exports = { notifyJerry };
