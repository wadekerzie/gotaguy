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

    // Not found — create new customer
    const { data: newCustomer, error: createErr } = await supabase
      .from('customers')
      .insert({ phone, status: 'new', data: {} })
      .select()
      .single();

    if (createErr) {
      throw new Error(`Failed to create customer: ${createErr.message}`);
    }

    console.log(`New customer created for ${phone}`);
    return { type: 'customer', record: newCustomer };
  } catch (err) {
    console.error(`resolveContact error for ${phone}:`, err.message);
    throw err;
  }
}

module.exports = { resolveContact };
