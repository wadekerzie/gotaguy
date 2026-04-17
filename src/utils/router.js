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
      // Returning customer whose last job is closed — archive and start fresh
      if (customer.status === 'closed' || customer.status === 'complete') {
        await archiveCustomer(customer);
        // Return null so sms.js treats this as a new contact and creates a fresh row
        return null;
      }
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

async function archiveCustomer(customerRow) {
  const { error: archiveErr } = await supabase
    .from('customer_archive')
    .insert({
      id:          customerRow.id,
      phone:       customerRow.phone,
      short_id:    customerRow.short_id,
      status:      customerRow.status,
      data:        customerRow.data,
      created_at:  customerRow.created_at,
      updated_at:  customerRow.updated_at,
      archived_at: new Date().toISOString(),
    });

  if (archiveErr) {
    throw new Error(`Failed to archive customer ${customerRow.id}: ${archiveErr.message}`);
  }

  const { error: deleteErr } = await supabase
    .from('customers')
    .delete()
    .eq('id', customerRow.id);

  if (deleteErr) {
    // Archive succeeded but delete failed — log loudly, do not proceed
    // (unique constraint on phone would block the new insert anyway)
    throw new Error(`Archived customer ${customerRow.id} but failed to delete original: ${deleteErr.message}`);
  }

  console.log(`Archived customer ${customerRow.id} (${customerRow.phone}) job #${customerRow.short_id} status: ${customerRow.status}`);
}

module.exports = { resolveContact };
