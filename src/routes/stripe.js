const express = require('express');
const router = express.Router();
const { getStripe } = require('../services/stripe');
const supabase = require('../db/client');
const { updateCustomer } = require('../db/client');
const { sendSMS } = require('../services/twilio');

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
      const customerPhone = paymentIntent.metadata.customer_phone;
      const confirmedPrice = paymentIntent.amount_capturable / 100; // cents to dollars

      // Fetch customer record
      const { data: customer, error: custErr } = await supabase
        .from('customers')
        .select('*')
        .eq('phone', customerPhone)
        .single();

      if (custErr || !customer) {
        console.error('Customer not found for phone:', customerPhone);
        return res.status(200).json({ received: true });
      }

      // Get contractor phone from schedule.worker_id
      const workerId = customer.data && customer.data.schedule && customer.data.schedule.worker_id;
      let contractorPhone = null;

      if (workerId) {
        const { data: worker } = await supabase
          .from('workers')
          .select('phone')
          .eq('id', workerId)
          .single();

        if (worker) {
          contractorPhone = worker.phone;
        }
      }

      // Update customer object
      await updateCustomer(customerPhone, 'price_locked', null, null, {
        job: {
          ...((customer.data && customer.data.job) || {}),
          confirmed_price: confirmedPrice,
          stripe_payment_intent_id: paymentIntent.id,
        },
      });

      // Send confirmation SMS to homeowner
      await sendSMS(
        customerPhone,
        `Your payment of $${confirmedPrice} has been authorized. Your contractor will be in touch shortly.`
      );

      // Send confirmation SMS to contractor
      if (contractorPhone) {
        const jobDesc = (customer.data && customer.data.job && customer.data.job.description) || 'repair job';
        await sendSMS(
          contractorPhone,
          `Payment of $${confirmedPrice} authorized for ${jobDesc}. You're good to go.`
        );
      } else {
        console.warn('No contractor found for customer:', customerPhone);
      }

      console.log(`Price locked for ${customerPhone}: $${confirmedPrice}, PI: ${paymentIntent.id}`);
    } catch (err) {
      console.error('Error processing payment_intent.amount_capturable_updated:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
