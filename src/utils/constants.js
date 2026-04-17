const COLLIN_COUNTY_ZIPS = [
  // McKinney
  '75069', '75070', '75071', '75072',
  // Allen
  '75002', '75013',
  // Frisco
  '75033', '75034', '75035', '75036',
  // Plano
  '75023', '75024', '75025', '75026', '75074', '75075', '75086', '75093', '75094',
  // Prosper
  '75078',
  // Celina
  '75009',
  // Wylie
  '75098',
  // Sachse
  '75048',
  // Anna
  '75409',
  // Melissa
  '75454',
  // Princeton
  '75407',
  // Lavon
  '75166',
  // Richardson (Collin County portion)
  '75080', '75082',
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

const SUPPORTED_LANGUAGES = ['en', 'es'];

const PLATFORM_NAME = 'GotaGuy';

module.exports = {
  COLLIN_COUNTY_ZIPS,
  TRADES,
  LICENSED_TRADES,
  TRADE_LABELS,
  CUSTOMER_STATUSES,
  CONTRACTOR_COMMANDS,
  SUPPORTED_LANGUAGES,
  PLATFORM_NAME,
};
