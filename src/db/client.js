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

async function getWorkerByPhone(phone) {
  try {
    const { data, error } = await supabase
      .from('workers')
      .select('*')
      .eq('phone', phone)
      .single();
    if (error && error.code === 'PGRST116') return null;
    if (error) throw new Error(`getWorkerByPhone error: ${error.message}`);
    return data;
  } catch (err) {
    console.error('getWorkerByPhone error:', err.message);
    throw err;
  }
}

async function createWorker(phone) {
  try {
    const { data, error } = await supabase
      .from('workers')
      .insert({ phone, status: 'lead', data: {} })
      .select()
      .single();
    if (error) throw new Error(`createWorker error: ${error.message}`);
    console.log(`New worker created for ${phone}`);
    return data;
  } catch (err) {
    console.error('createWorker error:', err.message);
    throw err;
  }
}

async function updateWorker(phone, status, newMessageIn, newMessageOut, additionalData) {
  try {
    const now = new Date().toISOString();

    const { data: current, error: fetchErr } = await supabase
      .from('workers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (fetchErr) throw new Error(`Failed to fetch worker ${phone}: ${fetchErr.message}`);

    const data = current.data || {};
    if (!data.comms) data.comms = [];
    if (!data.history) data.history = [];

    if (newMessageIn) {
      data.comms.push({ ts: now, direction: 'in', body: newMessageIn });
    }
    if (newMessageOut) {
      data.comms.push({ ts: now, direction: 'out', body: newMessageOut });
    }
    if (status !== current.status) {
      data.history.push({ ts: now, agent: 'contractorAgent', action: `status changed to ${status}` });
    }

    if (additionalData && Object.keys(additionalData).length > 0) {
      for (const key of Object.keys(additionalData)) {
        if (data[key] === undefined) {
          data[key] = additionalData[key];
        } else if (typeof data[key] === 'object' && !Array.isArray(data[key]) && typeof additionalData[key] === 'object') {
          data[key] = { ...data[key], ...additionalData[key] };
        } else {
          data[key] = additionalData[key];
        }
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from('workers')
      .update({ status, data })
      .eq('phone', phone)
      .select()
      .single();

    if (updateErr) throw new Error(`Failed to update worker ${phone}: ${updateErr.message}`);
    return updated;
  } catch (err) {
    console.error('updateWorker error:', err.message);
    throw err;
  }
}

async function getActiveWorkersByTradeAndZip(trade, zipCodes) {
  try {
    const { data, error } = await supabase
      .from('workers')
      .select('*')
      .eq('status', 'active');

    if (error) throw new Error(`getActiveWorkersByTradeAndZip error: ${error.message}`);
    if (!data) return [];

    return data.filter(worker => {
      const workerTrade = worker.data && worker.data.trade;
      const workerZips = (worker.data && worker.data.zip_codes) || [];
      const tradeMatch = workerTrade && workerTrade.toLowerCase() === trade.toLowerCase();
      const zipMatch = zipCodes.some(zip => workerZips.includes(zip));
      return tradeMatch && zipMatch;
    });
  } catch (err) {
    console.error('getActiveWorkersByTradeAndZip error:', err.message);
    throw err;
  }
}

async function getCustomerById(id) {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new Error(`getCustomerById error: ${error.message}`);
    return data;
  } catch (err) {
    console.error('getCustomerById error:', err.message);
    throw err;
  }
}

async function getWorkerById(id) {
  try {
    const { data, error } = await supabase
      .from('workers')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new Error(`getWorkerById error: ${error.message}`);
    return data;
  } catch (err) {
    console.error('getWorkerById error:', err.message);
    throw err;
  }
}

module.exports = supabase;
module.exports.updateCustomer = updateCustomer;
module.exports.getWorkerByPhone = getWorkerByPhone;
module.exports.createWorker = createWorker;
module.exports.updateWorker = updateWorker;
module.exports.getActiveWorkersByTradeAndZip = getActiveWorkersByTradeAndZip;
module.exports.getCustomerById = getCustomerById;
module.exports.getWorkerById = getWorkerById;
