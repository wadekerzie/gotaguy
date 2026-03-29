const COLLIN_COUNTY_ZIPS = [
  '75069', '75070', '75071',
  '75002', '75013',
  '75023', '75024', '75025',
  '75034', '75035',
  '75094', '75098',
  '75009', '75078'
];

const TRADES = [
  'electrical',
  'plumbing',
  'hvac',
  'handyman',
  'drywall',
  'painting',
  'sprinkler',
  'garage_door',
  'pool',
  'pest_control',
  'landscaping',
  'appliance',
  'fence'
];

const LICENSED_TRADES = [
  'electrical',
  'plumbing',
  'hvac',
  'pool',
  'pest_control'
];

const TRADE_LABELS = {
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  handyman: 'Handyman',
  drywall: 'Drywall repair',
  painting: 'Painting',
  sprinkler: 'Sprinkler repair',
  garage_door: 'Garage door repair',
  pool: 'Pool equipment repair',
  pest_control: 'Pest control',
  landscaping: 'Landscaping',
  appliance: 'Appliance repair',
  fence: 'Fence repair'
};

const CUSTOMER_STATUSES = [
  'new', 'scoping', 'quoting', 'scheduling', 'agreed',
  'waitlisted', 'dispatched', 'price_locked', 'active', 'complete', 'closed'
];

const CONTRACTOR_COMMANDS = ['CLAIM', 'ARRIVED', 'DONE'];

const PLATFORM_NAME = 'GotaGuy';

module.exports = {
  COLLIN_COUNTY_ZIPS,
  TRADES,
  LICENSED_TRADES,
  TRADE_LABELS,
  CUSTOMER_STATUSES,
  CONTRACTOR_COMMANDS,
  PLATFORM_NAME,
};
