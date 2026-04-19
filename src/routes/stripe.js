const express = require('express');
const router = express.Router();
const { getStripe } = require('../services/stripe');
const { updateCustomer, getCustomerById, getCustomerByPhone, getWorkerById } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { calculateFee } = require('../utils/fees');

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.amount_capturable_updated') {
    const paymentIntent = event.data.object;

    try {
      const customerId = paymentIntent.metadata.customer_id;
      const customerPhone = paymentIntent.metadata.customer_phone;
      const confirmedPrice = paymentIntent.amount_capturable / 100;

      console.log('[stripe-webhook] metadata customer_id:', customerId);
      console.log('[stripe-webhook] metadata customer_phone:', paymentIntent.metadata.customer_phone);

      let customer = null;
      try { customer = await getCustomerById(customerId); } catch (_) {}

      console.log('[stripe-webhook] getCustomerById result:', customer ? customer.id : 'NOT FOUND');

      if (!customer && customerPhone) {
        console.log(`[stripe-webhook] falling back to phone lookup: ${customerPhone}`);
        let customerByPhone = null;
        try { customerByPhone = await getCustomerByPhone(customerPhone); } catch (_) {}
        console.log('[stripe-webhook] phone fallback result:', customerByPhone ? customerByPhone.id : 'NOT FOUND');
        customer = customerByPhone;
      }

      if (!customer) {
        console.error('Customer not found by id or phone for PI:', paymentIntent.id);
        return res.status(200).json({ received: true });
      }

      // Calculate payout
      const { contractorPayout } = calculateFee(confirmedPrice);

      // Look up contractor
      const workerId = customer.data && customer.data.schedule && customer.data.schedule.worker_id;
      let worker = null;
      let workerFirstName = 'your contractor';

      if (workerId) {
        try {
          worker = await getWorkerById(workerId);
          if (worker && worker.data && worker.data.name) {
            workerFirstName = worker.data.name.split(' ')[0];
          }
        } catch (err) {
          console.error('Failed to look up worker:', err.message);
        }
      }

      // Update customer invoice data
      const now = new Date().toISOString();
      await updateCustomer(customer.phone, 'price_locked', null, null, {
        invoice: {
          ...((customer.data && customer.data.invoice) || {}),
          confirmed_price: confirmedPrice,
          stripe_payment_intent_id: paymentIntent.id,
          price_locked_at: now,
          payout_amount: contractorPayout,
          status: 'authorized',
        },
      });

      // Send to homeowner
      try {
        await sendSMS(
          customer.phone,
          `Got it - $${confirmedPrice} is locked in. Your card won't be charged until you confirm ${workerFirstName} is done. We'll text you when they finish.`
        );
      } catch (err) {
        console.error('Failed to SMS homeowner:', err.message);
      }

      // Send to contractor
      if (worker) {
        try {
          await sendSMS(
            worker.phone,
            `The customer has locked in $${confirmedPrice}. Complete the work and text DONE ${customer.short_id || ''} when finished.`.trim()
          );
        } catch (err) {
          console.error('Failed to SMS contractor:', err.message);
        }
      } else {
        console.warn('No contractor found for customer:', customer.id);
      }

      console.log(`Price locked for ${customer.phone}: $${confirmedPrice}, payout: $${contractorPayout}, PI: ${paymentIntent.id}`);
    } catch (err) {
      console.error('Error processing payment_intent.amount_capturable_updated:', err.message);
    }
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;

    try {
      const customerId = paymentIntent.metadata.customer_id;
      const amount = paymentIntent.amount / 100;

      const customer = await getCustomerById(customerId);
      if (!customer) {
        console.error('Customer not found for id:', customerId);
        return res.status(200).json({ received: true });
      }

      // Guard: if handleYes already closed this job, skip all side effects.
      // handleYes is the authoritative capture path. This webhook is a safety
      // net only - it ensures the DB reflects captured status but never sends
      // duplicate SMS to customer or contractor.
      const invoice = (customer.data && customer.data.invoice) || {};
      if (customer.status === 'closed' && invoice.status === 'captured') {
        console.log(`payment_intent.succeeded: job already closed by handleYes for customer ${customerId} - skipping duplicate actions`);
        return res.status(200).json({ received: true });
      }

      // Only reaches here if handleYes did not run (e.g. Stripe auto-capture
      // or an edge case). Update DB only, no SMS.
      const now = new Date().toISOString();
      await updateCustomer(customer.phone, 'closed', null, null, {
        invoice: {
          ...invoice,
          status: 'captured',
          captured_at: now,
        },
      });

      // Alert admin so the edge case is visible and can be followed up manually
      await sendSMS(
        process.env.MY_CELL_NUMBER,
        `WEBHOOK CAPTURE - Job closed via Stripe webhook (not handleYes) for customer ${customerId} - $${amount}. Verify payout fired.`
      );

      console.log(`payment_intent.succeeded safety net fired for ${customer.phone}: $${amount}`);
    } catch (err) {
      console.error('Error processing payment_intent.succeeded:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
