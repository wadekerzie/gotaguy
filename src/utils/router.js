const supabase = require('../db/client');

async function resolveContact(phone) {
  try {
    // Check customers table first
    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (customer) {
      return { type: 'customer', record: customer };
    }

    // Check workers table
    const { data: worker } = await supabase
      .from('workers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (worker) {
      return { type: 'worker', record: worker };
    }

    // Not found — return null so sms.js can classify
    return null;
  } catch (err) {
    console.error(`resolveContact error for ${phone}:`, err.message);
    throw err;
  }
}

module.exports = { resolveContact };
