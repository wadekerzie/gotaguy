require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const smsRoute = require('./routes/sms');
const stripeRoute = require('./routes/stripe');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook needs raw body — mount before bodyParser
app.use('/stripe/webhook', stripeRoute);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use('/sms', smsRoute);

app.listen(PORT, () => {
  console.log(`GotaGuy server running on port ${PORT}`);
});
