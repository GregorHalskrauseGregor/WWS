// Anthropic-Provider. Erwartet ANTHROPIC_API_KEY und optional ANTHROPIC_MODEL / ANTHROPIC_MODEL_LIGHT.
// Reine Text-API in dieser Version (Bilder laufen vorher über Mistral OCR).
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const LIGHT_MODEL = 'claude-haiku-4-5';

async function chat(systemPrompt, userMessage, options = {}) {
  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.ANTHROPIC_MODEL_LIGHT : process.env.ANTHROPIC_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Anthropic-API-Fehler: ' + JSON.stringify(data));
  }

  return data.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL };
