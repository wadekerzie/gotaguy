const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are classifying a first inbound SMS to GotaGuy, a home repair marketplace in Collin County TX.

Classify the message as exactly one of:
- homeowner: person describing a repair problem, asking about getting work done, or inquiring about home services
- contractor: licensed tradesperson mentioning their trade, looking for work, responding to a sign, or asking about picking up jobs
- ambiguous: cannot clearly determine from the message alone

Examples of homeowner: "my disposal stopped working", "need a plumber", "AC is out", "how much to fix a leaky faucet"
Examples of contractor: "I'm a licensed electrician", "saw your sign I do plumbing", "interested in picking up jobs", "I do HVAC work"
Examples of ambiguous: "hey", "hello", "what is this", "how does this work", "?"

Respond with only one word: homeowner, contractor, or ambiguous. No punctuation. No explanation.`;

async function classifyContact(messageText) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageText }],
    });

    const raw = response.content[0].text.trim().toLowerCase();

    if (raw === 'homeowner' || raw === 'contractor' || raw === 'ambiguous') {
      return raw;
    }

    console.warn('Classifier returned unexpected value:', raw, '- defaulting to homeowner');
    return 'homeowner';
  } catch (err) {
    console.error('classifyContact error:', err.message, '- defaulting to homeowner');
    return 'homeowner';
  }
}

module.exports = { classifyContact };
