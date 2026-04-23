const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../');

function loadSystemPrompt() {
  let persona = '';
  let states = '';

  try {
    persona = fs.readFileSync(path.join(ROOT, 'PERSONA.md'), 'utf8').trim();
  } catch (err) {
    console.warn('[loadSystemPrompt] PERSONA.md not found — skipping');
  }

  try {
    states = fs.readFileSync(path.join(ROOT, 'STATES.md'), 'utf8').trim();
  } catch (err) {
    console.warn('[loadSystemPrompt] STATES.md not found — skipping');
  }

  return [persona, states].filter(Boolean).join('\n\n');
}

module.exports = { loadSystemPrompt };
