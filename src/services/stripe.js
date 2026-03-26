const Stripe = require('stripe');

let stripe = null;
let cachedPriceId = null;

function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

async function getOrCreateCustomAmountPrice() {
  if (cachedPriceId) return cachedPriceId;

  const s = getStripe();

  // Create a product for GotaGuy service payments
  const product = await s.products.create({
    name: 'GotaGuy Home Service',
    description: 'Payment for home repair service',
  });

  // Create a price with custom_unit_amount (customer enters the amount)
  const price = await s.prices.create({
    currency: 'usd',
    custom_unit_amount: {
      enabled: true,
      minimum: 5000,    // $50 minimum
      maximum: 100000,  // $1000 maximum
    },
    product: product.id,
  });

  cachedPriceId = price.id;
  return cachedPriceId;
}

async function createPaymentLink(customerRecord) {
  try {
    const s = getStripe();
    const priceId = await getOrCreateCustomAmountPrice();

    const customerName = (customerRecord.data.contact && customerRecord.data.contact.name) || 'Customer';
    const jobCategory = (customerRecord.data.job && customerRecord.data.job.category) || 'home repair';

    const session = await s.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      payment_intent_data: {
        capture_method: 'manual',
        metadata: {
          customer_id: customerRecord.id,
          customer_phone: customerRecord.phone,
          job_category: jobCategory,
        },
        description: `GotaGuy - ${jobCategory} - ${customerName}`,
      },
      success_url: 'https://gotaguy-production.up.railway.app/payment-success',
      cancel_url: 'https://gotaguy-production.up.railway.app/payment-cancelled',
    });

    console.log(`Payment link created for customer ${customerRecord.id}: ${session.url}`);
    return session.url;
  } catch (err) {
    console.error('createPaymentLink error:', err.message);
    throw err;
  }
}

module.exports = { getStripe, createPaymentLink };
