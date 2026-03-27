const supabase = require('../db/client');
const { updateCustomer } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { TRADES } = require('../utils/constants');

// In-memory cooldown tracker for roster gap alerts
const lastRosterAlert = {};

async function runMonitorAgent() {
  let issuesFound = 0;

  try {
    // CHECK 1 - Stalled customer conversations
    issuesFound += await checkStalledConversations();

    // CHECK 2 - Jobs dispatched but not claimed
    issuesFound += await checkUnclaimedJobs();

    // CHECK 3 - Jobs stuck at price_locked
    issuesFound += await checkStalledPriceLocked();

    // CHECK 4 - Roster coverage by trade
    issuesFound += await checkRosterCoverage();

    // Log to monitor_logs
    try {
      await supabase.from('monitor_logs').insert({
        checks_run: 4,
        issues_found: issuesFound,
        details: {},
      });
    } catch (err) {
      console.error('Failed to insert monitor_logs:', err.message);
    }

    console.log(`Monitor run complete - ${issuesFound} issues found`);
  } catch (err) {
    console.error('runMonitorAgent error:', err.message);
  }

  return issuesFound;
}

async function checkStalledConversations() {
  let issues = 0;
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: stalled, error } = await supabase
      .from('customers')
      .select('*')
      .in('status', ['new', 'scoping', 'quoting', 'scheduling'])
      .lt('updated_at', twoHoursAgo);

    if (error) {
      console.error('Check 1 query error:', error.message);
      return 0;
    }
    if (!stalled || stalled.length === 0) return 0;

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const customer of stalled) {
      const lastNudge = customer.data && customer.data.last_nudge_at;
      if (lastNudge && lastNudge > oneDayAgo) continue;

      const category = (customer.data && customer.data.job && customer.data.job.category) || 'repair';

      try {
        await sendSMS(customer.phone, `Hey - still looking for help with that ${category}? Just reply and we'll pick up where we left off.`);
      } catch (err) {
        console.error('Failed to send stall nudge:', err.message);
        continue;
      }

      await updateCustomer(customer.phone, customer.status, null, null, {
        last_nudge_at: new Date().toISOString(),
      });

      issues++;
    }
  } catch (err) {
    console.error('checkStalledConversations error:', err.message);
  }
  return issues;
}

async function checkUnclaimedJobs() {
  let issues = 0;
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: unclaimed, error } = await supabase
      .from('customers')
      .select('*')
      .eq('status', 'dispatched')
      .lt('updated_at', twoHoursAgo);

    if (error) {
      console.error('Check 2 query error:', error.message);
      return 0;
    }
    if (!unclaimed || unclaimed.length === 0) return 0;

    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    for (const job of unclaimed) {
      const lastAlert = job.data && job.data.last_dispatch_alert_at;
      if (lastAlert && lastAlert > fourHoursAgo) continue;

      const category = (job.data && job.data.job && job.data.job.category) || 'unknown';
      const address = (job.data && job.data.contact && job.data.contact.address) || '';
      const zipMatch = address.match(/\b(\d{5})\b/);
      const zip = zipMatch ? zipMatch[1] : 'unknown';
      const hoursWaiting = Math.round((Date.now() - new Date(job.updated_at).getTime()) / (60 * 60 * 1000));

      try {
        await sendSMS(process.env.MY_CELL_NUMBER, `NO CLAIM - Job ${job.id} ${category} in ${zip} has been waiting ${hoursWaiting} hrs. Consider adding more ${category} contractors.`);
      } catch (err) {
        console.error('Failed to send unclaimed alert:', err.message);
        continue;
      }

      await updateCustomer(job.phone, job.status, null, null, {
        last_dispatch_alert_at: new Date().toISOString(),
      });

      issues++;
    }
  } catch (err) {
    console.error('checkUnclaimedJobs error:', err.message);
  }
  return issues;
}

async function checkStalledPriceLocked() {
  let issues = 0;
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: stalled, error } = await supabase
      .from('customers')
      .select('*')
      .eq('status', 'price_locked')
      .lt('updated_at', fourHoursAgo);

    if (error) {
      console.error('Check 3 query error:', error.message);
      return 0;
    }
    if (!stalled || stalled.length === 0) return 0;

    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    for (const job of stalled) {
      const lastAlert = job.data && job.data.last_locked_alert_at;
      if (lastAlert && lastAlert > sixHoursAgo) continue;

      const confirmedPrice = (job.data && job.data.invoice && job.data.invoice.confirmed_price) || '?';
      const workerId = (job.data && job.data.schedule && job.data.schedule.worker_id) || 'unknown';

      try {
        await sendSMS(process.env.MY_CELL_NUMBER, `STALLED - Job ${job.id} price locked $${confirmedPrice} but not complete. Customer: ${job.phone} Worker: ${workerId}`);
      } catch (err) {
        console.error('Failed to send stalled alert:', err.message);
        continue;
      }

      await updateCustomer(job.phone, job.status, null, null, {
        last_locked_alert_at: new Date().toISOString(),
      });

      issues++;
    }
  } catch (err) {
    console.error('checkStalledPriceLocked error:', err.message);
  }
  return issues;
}

async function checkRosterCoverage() {
  let issues = 0;
  try {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    for (const trade of TRADES) {
      const { count, error } = await supabase
        .from('workers')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .eq('data->>trade', trade);

      if (error) {
        console.error(`Roster check error for ${trade}:`, error.message);
        continue;
      }

      if (count === 0) {
        // Check cooldown
        if (lastRosterAlert[trade] && lastRosterAlert[trade] > oneDayAgo) continue;

        try {
          await sendSMS(process.env.MY_CELL_NUMBER, `ROSTER GAP - No active ${trade} contractors in system.`);
        } catch (err) {
          console.error(`Failed to send roster gap alert for ${trade}:`, err.message);
          continue;
        }

        lastRosterAlert[trade] = Date.now();
        issues++;
      }
    }
  } catch (err) {
    console.error('checkRosterCoverage error:', err.message);
  }
  return issues;
}

module.exports = { runMonitorAgent };
