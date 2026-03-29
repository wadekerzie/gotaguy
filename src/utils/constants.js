const COLLIN_COUNTY_ZIPS = [
  '75069', '75070', '75071',
  '75002', '75013',
  '75023', '75024', '75025',
  '75034', '75035',
  '75094', '75098',
  '75009', '75078'
];

const TRADES = ['electrical', 'plumbing', 'hvac', 'handyman'];

const CUSTOMER_STATUSES = [
  'new', 'scoping', 'quoting', 'scheduling', 'agreed',
  'waitlisted', 'dispatched', 'price_locked', 'active', 'complete', 'closed'
];

const CONTRACTOR_COMMANDS = ['CLAIM', 'ARRIVED', 'DONE'];

const PLATFORM_NAME = 'GotaGuy';

module.exports = {
  COLLIN_COUNTY_ZIPS,
  TRADES,
  CUSTOMER_STATUSES,
  CONTRACTOR_COMMANDS,
  PLATFORM_NAME,
};
