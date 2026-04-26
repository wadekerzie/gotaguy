const { sendSMS } = require('../services/twilio');

const JERRY_PHONE = '+14699910951';

const sentNotifications = new Map();

const notifyJerry = async (trigger, jobOrWorker, market) => {
  const dedupeKey = `${trigger}-${jobOrWorker.id}`;

  if (sentNotifications.has(dedupeKey)) {
    console.log(`Jerry notification skipped - already sent: ${dedupeKey}`);
    return;
  }

  sentNotifications.set(dedupeKey, new Date().toISOString());

  const jerryNumber = process.env.JERRY_TWILIO_NUMBER;
  if (!jerryNumber) {
    console.error('JERRY_TWILIO_NUMBER not set - Jerry notification aborted');
    return;
  }

  const message = `GOTAGUY-OPS | ${trigger} | ID: ${jobOrWorker.id} | MARKET: ${market} | STATUS: ${jobOrWorker.status} | TIME: ${new Date().toISOString()}`;
  await sendSMS(JERRY_PHONE, message, jerryNumber);
};

module.exports = { notifyJerry };
