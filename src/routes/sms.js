const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  const { From, Body } = req.body;
  console.log(`Inbound SMS from ${From}: ${Body}`);

  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');
});

module.exports = router;
