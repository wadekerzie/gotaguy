require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const smsRoute = require('./routes/sms');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use('/sms', smsRoute);

app.listen(PORT, () => {
  console.log(`GotaGuy server running on port ${PORT}`);
});
