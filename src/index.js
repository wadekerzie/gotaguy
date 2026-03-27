require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const smsRoute = require('./routes/sms');
const stripeRoute = require('./routes/stripe');
const { runMonitorAgent } = require('./agents/monitorAgent');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook needs raw body — mount before bodyParser
app.use('/stripe/webhook', stripeRoute);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use('/sms', smsRoute);
app.use('/admin', require('./routes/admin'));
app.use('/stripe/connect', require('./routes/stripeConnect'));

app.listen(PORT, () => {
  console.log(`GotaGuy server running on port ${PORT}`);
});

// Monitor agent — every 10 minutes
cron.schedule('*/10 * * * *', () => {
  runMonitorAgent().catch(console.error);
});
