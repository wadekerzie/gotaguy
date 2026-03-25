const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function updateCustomer(phone, status, newMessageIn, newMessageOut, additionalData) {
  try {
    const now = new Date().toISOString();

    // Fetch current record
    const { data: current, error: fetchErr } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (fetchErr) {
      throw new Error(`Failed to fetch customer ${phone}: ${fetchErr.message}`);
    }

    const data = current.data || {};

    // Ensure comms array exists
    if (!data.comms) data.comms = [];
    // Ensure history array exists
    if (!data.history) data.history = [];

    // Append inbound message
    if (newMessageIn) {
      data.comms.push({ ts: now, direction: 'in', body: newMessageIn });
    }

    // Append outbound reply
    if (newMessageOut) {
      data.comms.push({ ts: now, direction: 'out', body: newMessageOut });
    }

    // Append history entry if status changed
    if (status !== current.status) {
      data.history.push({ ts: now, agent: 'customerAgent', action: `status changed to ${status}` });
    }

    // Merge additional data
    if (additionalData && Object.keys(additionalData).length > 0) {
      Object.assign(data, additionalData);
    }

    // Update the record
    const { data: updated, error: updateErr } = await supabase
      .from('customers')
      .update({ status, data })
      .eq('phone', phone)
      .select()
      .single();

    if (updateErr) {
      throw new Error(`Failed to update customer ${phone}: ${updateErr.message}`);
    }

    return updated;
  } catch (err) {
    console.error('updateCustomer error:', err.message);
    throw err;
  }
}

module.exports = supabase;
module.exports.updateCustomer = updateCustomer;
