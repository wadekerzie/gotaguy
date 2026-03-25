const express = require('express');
const twilio = require('twilio');
const router = express.Router();
const { resolveContact } = require('../utils/router');
const { runCustomerAgent } = require('../agents/customerAgent');
const { updateCustomer } = require('../db/client');
const { sendSMS } = require('../services/twilio');

// Twilio signature validation middleware
function validateTwilioSignature(req, res, next) {
  if (process.env.NODE_ENV === 'development') {
    return next(); // Skip validation in dev for local testing
  }

  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!valid) {
    console.warn('Invalid Twilio signature');
    return res.status(403).send('Forbidden');
  }
  next();
}

router.post('/', validateTwilioSignature, async (req, res) => {
  // Always return TwiML immediately so Twilio doesn't retry
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  try {
    const from = req.body.From;
    const body = req.body.Body || '';
    const mediaUrl = req.body.MediaUrl0 || null;
    const mediaType = req.body.MediaContentType0 || null;

    console.log(`Inbound SMS from ${from}: ${body}${mediaUrl ? ' [+photo]' : ''}`);

    // Resolve contact
    const { type, record } = await resolveContact(from);

    // Worker messages — not built yet
    if (type === 'worker') {
      console.log('Worker message received - contractor agent not built yet');
      return;
    }

    // Customer flow
    const { reply, newStatus, flag } = await runCustomerAgent(record, body, mediaUrl);

    if (flag === 'human') {
      await sendSMS(process.env.MY_CELL_NUMBER, `EXCEPTION - ${from}: ${body}`);
      await sendSMS(from, "You've been connected with our team. Someone will text you shortly.");
    } else {
      await sendSMS(from, reply);
    }

    // Build additional data for photo storage
    const additionalData = {};
    if (mediaUrl) {
      const photos = (record.data && record.data.photos) || [];
      photos.push({ ts: new Date().toISOString(), url: mediaUrl, type: mediaType });
      additionalData.photos = photos;
    }

    // Extract price range if status is quoting
    if (newStatus === 'quoting') {
      const priceMatch = reply.match(/\$(\d+)[^$]*\$(\d+)/);
      if (priceMatch) {
        if (!additionalData.job) additionalData.job = {};
        additionalData.job.quoted_price_low = parseInt(priceMatch[1], 10);
        additionalData.job.quoted_price_high = parseInt(priceMatch[2], 10);
      }
    }

    const outboundMsg = flag === 'human'
      ? "You've been connected with our team. Someone will text you shortly."
      : reply;

    await updateCustomer(from, newStatus, body, outboundMsg, additionalData);

  } catch (err) {
    console.error('SMS webhook error:', err.message);
  }
});

module.exports = router;
