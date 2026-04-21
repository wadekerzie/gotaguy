/**
 * Onboards Tony Montana as a test contractor for the Aurora market.
 *
 * Prerequisites: migration 002_markets.sql must already be applied in Supabase.
 *
 * Usage: node scripts/onboard_tony.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const AURORA_TWILIO = '+17208213271';
const AURORA_ZIPS = [
  '80010','80011','80012','80013','80014','80015','80016','80017','80018',
  '80019','80040','80041','80042','80044','80045','80046','80047'
];

const TONY_PHONE = '+17204680020';
const TONY_TRADES = [
  'Plumbing', 'Electrical', 'HVAC', 'Drywall', 'Painting',
  'Tile & Flooring', 'Carpentry', 'Roofing', 'Landscaping',
  'Fencing', 'Concrete', 'Appliance Repair', 'General Handyman'
];

async function main() {
  // 1. Verify markets table exists and find Aurora market
  const { data: aurora, error: mktErr } = await supabase
    .from('markets')
    .select('*')
    .eq('twilio_number', AURORA_TWILIO)
    .maybeSingle();

  if (mktErr) {
    console.error('ERROR: Could not query markets table:', mktErr.message);
    console.error('→ Run migrations/002_markets.sql in the Supabase SQL editor first.');
    process.exit(1);
  }
  if (!aurora) {
    console.error('ERROR: Aurora market row not found.');
    console.error('→ Run migrations/002_markets.sql in the Supabase SQL editor first.');
    process.exit(1);
  }

  console.log(`Aurora market found: id=${aurora.id} name="${aurora.name}"`);

  // 2. Delete existing record if present (idempotent re-run)
  const { data: existing } = await supabase
    .from('workers')
    .select('id, status')
    .eq('phone', TONY_PHONE)
    .maybeSingle();

  if (existing) {
    console.log(`Existing worker found (id=${existing.id}, status=${existing.status}) — removing before re-insert`);
    await supabase.from('workers').delete().eq('phone', TONY_PHONE);
  }

  // 3. Create Tony via admin API (fires welcomeContractor automatically)
  const BASE_URL = process.env.RAILWAY_DOMAIN || 'http://localhost:3000';
  const url = `${BASE_URL}/admin/contractors`;

  console.log(`Calling POST ${url} ...`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': process.env.ADMIN_SECRET,
    },
    body: JSON.stringify({
      name: 'Tony Montana',
      trade: 'General Handyman',
      phone: TONY_PHONE,
      market_id: aurora.id,
      zip_codes: AURORA_ZIPS,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Admin API returned ${resp.status}: ${body}`);
    process.exit(1);
  }

  const worker = await resp.json();
  console.log(`\nWorker created: id=${worker.id}`);

  // 4. Verify Tony's row
  const { data: tony } = await supabase
    .from('workers')
    .select('*')
    .eq('phone', TONY_PHONE)
    .single();

  console.log('\n=== Tony Montana DB row ===');
  console.log(JSON.stringify(tony, null, 2));

  // 5. Confirm market_id matches Aurora
  if (tony.market_id !== aurora.id) {
    console.error(`FAIL: market_id mismatch — got ${tony.market_id}, expected ${aurora.id}`);
    process.exit(1);
  }
  console.log('\n✓ market_id matches Aurora market');

  // 6. Confirm Tony does NOT appear in a McKinney dispatch
  const { data: mckinneyWorkers } = await supabase
    .from('workers')
    .select('id, phone')
    .eq('status', 'active')
    .eq('market_id', aurora.id === tony.market_id ? (
      // Get McKinney market id to exclude Aurora workers
      null
    ) : aurora.id);

  // Simpler check: query workers with a McKinney zip that Tony shouldn't have
  const mckinney75069Workers = await supabase
    .from('workers')
    .select('id, phone, market_id, data')
    .eq('market_id', aurora.id)
    .eq('status', 'active');

  // Tony is pending_stripe, not active — but verify his zip_codes don't overlap McKinney
  const tonyZips = (tony.data && tony.data.zip_codes) || [];
  const mckinneyZips = ['75069','75070','75071','75072','75002','75013','75023','75024','75025'];
  const overlap = tonyZips.filter(z => mckinneyZips.includes(z));

  if (overlap.length > 0) {
    console.error(`FAIL: Tony has McKinney zip codes: ${overlap.join(', ')}`);
    process.exit(1);
  }
  console.log('✓ Tony has no McKinney zip codes');

  // 7. Confirm Tony's zip_codes cover Aurora
  const missingAuroraZips = AURORA_ZIPS.filter(z => !tonyZips.includes(z));
  if (missingAuroraZips.length > 0) {
    console.error(`FAIL: Tony is missing Aurora zips: ${missingAuroraZips.join(', ')}`);
    process.exit(1);
  }
  console.log('✓ Tony has all Aurora zip codes');

  console.log('\nAll checks passed. Welcome SMS fired via welcomeContractor (check Railway logs).');
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
