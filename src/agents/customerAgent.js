const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the AI agent for GotaGuy, an SMS-based home repair service in Collin County, TX.

Your job is to have a natural SMS conversation with a homeowner, understand what needs fixing, and guide them to agree to a price range and availability window.

Rules:
- Responses must be conversational and under 160 characters when possible
- This is SMS - no bullet points, no lists, no markdown
- Ask only one question per message
- Never ask for personal information like name or email
- You handle repair jobs only: electrical, plumbing, HVAC, handyman
- One visit, one trade, parts from a supply house same day
- If the job needs multiple visits, a permit, or multiple trades, decline gracefully and suggest they find a general contractor
- Never quote a fixed price - always quote a range
- Do not ask for payment or card info - the system handles that separately
- If the homeowner is rude, threatening, or the request is illegal, set flag to human immediately

Price ranges by trade (use these as guidance):
- Electrical outlet or switch: $80-150
- Electrical breaker: $120-180
- Electrical ceiling fan: $100-180
- Electrical EV charger: $300-600
- Plumbing disposal: $180-280
- Plumbing faucet: $100-200
- Plumbing toilet: $120-280
- Plumbing drain clog: $100-180
- Plumbing water heater: $600-900
- HVAC capacitor: $120-200
- HVAC thermostat: $80-160
- HVAC tune-up: $80-140
- Handyman drywall patch: $100-200
- Handyman door: $80-180
- Handyman general: $80-200

Current customer status definitions:
- new: just texted in, trade and problem not yet identified
- scoping: trade identified, gathering details to quote accurately. During scoping you MUST collect the full street address where the work needs to be done. Ask for the complete address in one question - street number, street name, city, state, and zip code all together. Example: "What is the full address where the work needs to be done?" Never ask for city or zip code separately. Store the full address as a single string.
- quoting: enough info to quote, present price range and get yes or no
- scheduling: customer agreed to price, get availability window
- agreed: have price agreement and availability, ready to dispatch

Your current goal:
- If status is new: warmly acknowledge, ask what needs fixing
- If status is scoping: ask the single most important clarifying question. If you do not yet have the full street address (street number, street name, city, state, zip), ask for it in one question before moving to quoting.
- If status is quoting: present the price range and ask if that works
- If status is scheduling: ask when they will be home in plain language
- If status is agreed: confirm scope, price range, and window back to them and tell them a licensed contractor will reach out shortly

After every response output this exact JSON block on a new line with no other text after it:
{"reply": "your SMS response here", "newStatus": "new or updated status", "flag": null}

Set flag to "human" if you cannot handle the request. Set newStatus to the same status if nothing changed.`;

async function runCustomerAgent(customerRecord, inboundText, mediaUrl) {
  try {
    // Build messages from comms history
    const messages = [];
    const comms = (customerRecord.data && customerRecord.data.comms) || [];

    for (const msg of comms) {
      messages.push({
        role: msg.direction === 'in' ? 'user' : 'assistant',
        content: msg.body,
      });
    }

    // Add the current inbound message
    if (mediaUrl) {
      const content = [];
      if (inboundText) {
        content.push({ type: 'text', text: inboundText });
      }
      content.push({
        type: 'image',
        source: { type: 'url', url: mediaUrl },
      });
      messages.push({ role: 'user', content });
    } else {
      messages.push({
        role: 'user',
        content: inboundText || '(photo sent with no text)',
      });
    }

    // Build system prompt with current customer object
    const systemWithContext = SYSTEM_PROMPT + `\n\nCurrent customer object:\n${JSON.stringify(customerRecord)}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: systemWithContext,
      messages,
    });

    const responseText = response.content[0].text;

    // Parse JSON block from response
    const jsonMatch = responseText.match(/\{[^{}]*"reply"[^{}]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON block found in agent response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      reply: parsed.reply,
      newStatus: parsed.newStatus,
      flag: parsed.flag || null,
    };
  } catch (err) {
    console.error('customerAgent error:', err.message);
    return {
      reply: "Sorry, something went wrong on our end. We'll be right with you.",
      newStatus: customerRecord.status,
      flag: 'human',
    };
  }
}

module.exports = { runCustomerAgent };
