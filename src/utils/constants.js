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

const ZIP_TO_CITY = {
  '75069': 'McKinney',
  '75070': 'McKinney',
  '75071': 'McKinney',
  '75072': 'McKinney',
  '75002': 'Allen',
  '75013': 'Allen',
  '75033': 'Frisco',
  '75034': 'Frisco',
  '75035': 'Frisco',
  '75036': 'Frisco',
  '75023': 'Plano',
  '75024': 'Plano',
  '75025': 'Plano',
  '75026': 'Plano',
  '75074': 'Plano',
  '75075': 'Plano',
  '75086': 'Plano',
  '75093': 'Plano',
  '75094': 'Plano',
  '75078': 'Prosper',
  '75009': 'Celina',
  '75098': 'Wylie',
  '75048': 'Sachse',
  '75409': 'Anna',
  '75454': 'Melissa',
  '75407': 'Princeton',
  '75166': 'Lavon',
  '75080': 'Richardson',
  '75082': 'Richardson',
};

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

// Path appended to market.domain to build market-aware contractor TOS URL
const CONTRACTOR_TOS_PATH = '/contractor-terms.html';

// Deterministic scheduling prompt — sent directly via Twilio, never through AI
const MSG_SCHEDULE_PROMPT = "What day works for you? We typically schedule within the next 1-3 days.";

// Job status set by handleClaim when pending_day_confirmation = true
// If this status name ever changes, update both handleClaim and this constant together
const STATUS_PENDING_DAY_CONFIRMATION = 'active';

// Post-payment review request — deterministic send, no AI involvement
const GOOGLE_REVIEW_URL_MCKINNEY = 'https://g.page/r/CVrexW02zXzOEBM/review';
const MSG_REVIEW_REQUEST = (reviewUrl) =>
  `Thanks for using GotaGuy! If your experience was great, we'd love a quick review: ${reviewUrl}`;

module.exports = {
  COLLIN_COUNTY_ZIPS,
  ZIP_TO_CITY,
  TRADES,
  LICENSED_TRADES,
  TRADE_LABELS,
  CUSTOMER_STATUSES,
  CONTRACTOR_COMMANDS,
  SUPPORTED_LANGUAGES,
  PLATFORM_NAME,
  CONTRACTOR_TOS_PATH,
  MSG_SCHEDULE_PROMPT,
  STATUS_PENDING_DAY_CONFIRMATION,
  GOOGLE_REVIEW_URL_MCKINNEY,
  MSG_REVIEW_REQUEST,
};
