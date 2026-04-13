const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TRANSLATION_SYSTEM_PROMPT = 'Translate this SMS message to natural conversational Mexican Spanish as spoken by a skilled tradesperson. Rules: Keep all numbers, addresses, job IDs, dollar amounts, and URLs exactly as they are. Keep these command words in English exactly as written: CLAIM, ARRIVED, DONE, STOP, HELP, YES, NO. Keep the GotaGuy brand name in English. Be brief and natural - this is an SMS message not a formal document. Return only the translated message with no explanation.';

async function translateForWorker(message, workerRecord) {
  try {
    const lang = workerRecord && workerRecord.data && workerRecord.data.language_preference;
    if (lang !== 'es') return message;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: TRANSLATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

    return response.content[0].text;
  } catch (err) {
    console.error('translateForWorker error:', err.message);
    return message;
  }
}

module.exports = { translateForWorker };
