const supabase = require('../db/client');
const { updateCustomer } = require('../db/client');
const { sendSMS } = require('../services/twilio');
const { TRADES } = require('../utils/constants');
const { retryDispatch } = require('./dispatchAgent');


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

    // CHECK 5 - Waitlisted job retries
    issuesFound += await checkWaitlistedJobs();

    // CHECK 6 - Pending Stripe 24-hour follow-up
    issuesFound += await checkPendingStripeFollowup();

    // CHECK 7 - 30-day closed job follow-up
    issuesFound += await checkThirtyDayFollowup();

    // Log to monitor_logs
    try {
      await supabase.from('monitor_logs').insert({
        checks_run: 7,
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

      // Send holding SMS to homeowner (once per job)
      const waitlist = (job.data && job.data.waitlist) || {};
      if (!waitlist.homeowner_notified) {
        try {
          await sendSMS(job.phone, "Still working on confirming your pro. We'll have someone locked in shortly. Reply CANCEL if you'd like to cancel.");
        } catch (err) {
          console.error('Failed to send homeowner holding SMS:', err.message);
        }
      }

      await updateCustomer(job.phone, job.status, null, null, {
        last_dispatch_alert_at: new Date().toISOString(),
        waitlist: { ...waitlist, homeowner_notified: true },
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
    for (const trade of TRADES) {
      // Any record for this trade — any status — means we have someone in the pipeline
      console.log(`[checkRosterCoverage] querying trade: ${trade}`);
      const { count, error } = await supabase
        .from('workers')
        .select('*', { count: 'exact', head: true })
        .eq('data->>trade', trade);

      console.log(`[checkRosterCoverage] trade: ${trade} | count: ${count} | error: ${error ? error.message : 'none'}`);

      if (error) {
        console.error(`Roster check error for ${trade}:`, error.message);
        continue;
      }

      if (count === 0) {
        try {
          await sendSMS(process.env.MY_CELL_NUMBER, `ROSTER GAP - No ${trade} contractors in system at all.`);
        } catch (err) {
          console.error(`Failed to send roster gap alert for ${trade}:`, err.message);
          continue;
        }

        issues++;
      }
    }
  } catch (err) {
    console.error('checkRosterCoverage error:', err.message);
  }
  return issues;
}

const MAX_WAITLIST_RETRIES = 6;
const WAITLIST_RETRY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function checkWaitlistedJobs() {
  let issues = 0;
  try {
    const { data: waitlisted, error } = await supabase
      .from('customers')
      .select('*')
      .eq('status', 'waitlisted');

    if (error) {
      console.error('Check 5 query error:', error.message);
      return 0;
    }
    if (!waitlisted || waitlisted.length === 0) return 0;

    for (const customer of waitlisted) {
      const waitlist = (customer.data && customer.data.waitlist) || {};
      const retryCount = waitlist.retry_count || 0;
      const lastRetry = waitlist.last_retry_at;

      // Cooldown: 30 minutes since last retry
      if (lastRetry && (Date.now() - new Date(lastRetry).getTime()) < WAITLIST_RETRY_INTERVAL_MS) {
        continue;
      }

      // Also respect cooldown from initial waitlist if no retries yet
      if (!lastRetry && waitlist.waitlisted_at) {
        if ((Date.now() - new Date(waitlist.waitlisted_at).getTime()) < WAITLIST_RETRY_INTERVAL_MS) {
          continue;
        }
      }

      const shortId = customer.short_id || '????';
      const category = (customer.data && customer.data.job && customer.data.job.category) || 'unknown';
      const address = (customer.data && customer.data.contact && customer.data.contact.address) || '';
      const zipMatch = address.match(/\b(\d{5})\b/);
      const zip = zipMatch ? zipMatch[1] : 'unknown';

      // Max retries reached — escalate
      if (retryCount >= MAX_WAITLIST_RETRIES) {
        if (!waitlist.escalated_at) {
          const now = new Date().toISOString();
          await sendSMS(process.env.MY_CELL_NUMBER, `ESCALATION - Job #${shortId} ${category} in ${zip} - ${retryCount} retries exhausted. Customer: ${customer.phone}. Manual dispatch needed: POST /admin/dispatch/${customer.id}`);
          await updateCustomer(customer.phone, 'waitlisted', null, null, {
            waitlist: { ...waitlist, escalated_at: now },
          });
          issues++;
        }
        continue;
      }

      // Retry dispatch
      const result = await retryDispatch(customer);

      if (result.dispatched) {
        console.log(`Check 5: Job #${shortId} dispatched on retry ${retryCount + 1}`);
      } else {
        console.log(`Check 5: Job #${shortId} retry ${result.retryCount || retryCount + 1} - still no match`);
      }

      issues++;
    }
  } catch (err) {
    console.error('checkWaitlistedJobs error:', err.message);
  }
  return issues;
}

async function checkPendingStripeFollowup() {
  let issues = 0;
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from('workers')
      .select('*')
      .eq('status', 'pending_stripe')
      .lt('created_at', twentyFourHoursAgo);

    if (error) {
      console.error('Check 6 query error:', error.message);
      return 0;
    }
    if (!pending || pending.length === 0) return 0;

    const { getStripe } = require('../services/stripe');
    const stripe = getStripe();

    for (const worker of pending) {
      const onboarding = (worker.data && worker.data.onboarding) || {};
      if (onboarding.followup_sent) continue;

      const stripeAccountId = worker.data && worker.data.stripe_account_id;
      if (!stripeAccountId) continue;

      // Generate a fresh onboarding link
      let link;
      try {
        const accountLink = await stripe.accountLinks.create({
          account: stripeAccountId,
          refresh_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/refresh?account_id=' + stripeAccountId,
          return_url: process.env.RAILWAY_DOMAIN + '/stripe/connect/return?account_id=' + stripeAccountId,
          type: 'account_onboarding',
        });
        link = accountLink.url;
      } catch (err) {
        console.error(`Failed to generate Stripe link for worker ${worker.id}:`, err.message);
        continue;
      }

      try {
        await sendSMS(worker.phone, `Hey, looks like your GotaGuy setup isn't quite complete. Finish here: ${link}. Takes 5 minutes and you'll start receiving jobs immediately.`);
      } catch (err) {
        console.error('Failed to send Stripe followup SMS:', err.message);
        continue;
      }

      // Mark followup_sent to prevent duplicates
      await supabase
        .from('workers')
        .update({
          data: {
            ...worker.data,
            onboarding: { ...onboarding, followup_sent: true },
          },
        })
        .eq('id', worker.id);

      issues++;
    }
  } catch (err) {
    console.error('checkPendingStripeFollowup error:', err.message);
  }
  return issues;
}

async function checkThirtyDayFollowup() {
  let issues = 0;
  try {
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    const { data: closed, error } = await supabase
      .from('customers')
      .select('*')
      .eq('status', 'closed')
      .gte('updated_at', thirtyOneDaysAgo)
      .lte('updated_at', twentyNineDaysAgo);

    if (error) {
      console.error('Check 7 query error:', error.message);
      return 0;
    }
    if (!closed || closed.length === 0) return 0;

    for (const customer of closed) {
      const invoice = (customer.data && customer.data.invoice) || {};
      if (invoice.followup_sent) continue;

      try {
        await sendSMS(customer.phone, "Hey, it's GotaGuy. Hope everything is still holding up from your repair last month. Anything else need attention around the house? Just text us.");
      } catch (err) {
        console.error('Failed to send 30-day followup SMS:', err.message);
        continue;
      }

      await updateCustomer(customer.phone, 'closed', null, null, {
        invoice: { ...invoice, followup_sent: true },
      });

      issues++;
    }
  } catch (err) {
    console.error('checkThirtyDayFollowup error:', err.message);
  }
  return issues;
}

module.exports = { runMonitorAgent };
