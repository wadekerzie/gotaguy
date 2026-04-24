const { sendSMS } = require('../services/twilio');

const JERRY_PHONE = '+14699910951';

const notifyJerry = async (trigger, jobOrWorker, market) => {
  const message = `GOTAGUY-OPS TRIGGER: ${trigger} | ID: ${jobOrWorker.id} | MARKET: ${market} | STATUS: ${jobOrWorker.status} | TIME: ${new Date().toISOString()}`;
  await sendSMS(JERRY_PHONE, message, process.env.TWILIO_PHONE_NUMBER);
};

module.exports = { notifyJerry };
