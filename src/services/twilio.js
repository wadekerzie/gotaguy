const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(to, body) {
  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`SMS sent to ${to}: ${body.substring(0, 50)}`);
    return message;
  } catch (err) {
    console.error(`Failed to send SMS to ${to}:`, err.message);
    throw new Error(`Twilio sendSMS failed: ${err.message}`);
  }
}

module.exports = { sendSMS };
