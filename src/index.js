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

app.use(express.static('public'));

app.get('/payment-success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Payment Confirmed</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #f9f9f9; }
        h1 { color: #2e7d32; font-size: 1.8rem; }
        p { color: #444; font-size: 1.1rem; margin-top: 16px; }
      </style>
      </head>
      <body>
        <h1>Payment Authorized</h1>
        <p>Your card has been authorized but not charged yet.</p>
        <p>You'll receive a text when the job is complete. Reply YES to release payment or NO if you have a concern.</p>
        <p>Thanks for using GotaGuy.</p>
      </body>
    </html>
  `);
});

app.get('/payment-cancelled', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Payment Cancelled</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #f9f9f9; }
        h1 { color: #c62828; font-size: 1.8rem; }
        p { color: #444; font-size: 1.1rem; margin-top: 16px; }
      </style>
      </head>
      <body>
        <h1>Payment Not Completed</h1>
        <p>No charge was made. Text us if you need help completing payment.</p>
        <p>Reply to your original text thread or contact us at ${process.env.MY_CELL_NUMBER}.</p>
      </body>
    </html>
  `);
});

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
